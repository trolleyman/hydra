import type { TestCase } from '../api/models/TestCase'

// Structured test-case location helpers (TESTS_PLAN.md "shared foundation").
// A case's location has two axes: `path` - a repo-relative filesystem location
// (file, or package dir for Go) - and `scope` - the logical nesting chain
// between the path and the leaf name (class chain / describe chain / subtest
// parent). Old cached reports carry a pre-joined display name and neither axis.

export function splitPath(path?: string | null): string[] {
  return path ? path.split('/').filter(Boolean) : []
}

// segmentsFor derives the tree segment list for a case on the chosen axis,
// falling back per-case to the other axis so a missing one never breaks a view:
// path mode = dir/dir/file then the scope chain; scope mode = the scope chain
// alone (with file:line rendered separately as a secondary affordance).
export function segmentsFor(c: TestCase, useScope: boolean): string[] {
  const scope = c.scope ?? []
  if (useScope) return scope.length ? scope : splitPath(c.path)
  return [...splitPath(c.path), ...scope]
}

// caseKey identifies a case across renders and view modes (expansion state,
// React keys): the full location + leaf name.
export function caseKey(c: TestCase): string {
  return [c.path ?? '', ...(c.scope ?? []), c.name].join('\0')
}

// caseDisplayName renders the flat single-line form: `path › scope... › name`.
// Old reports (no path/scope) already carry the pre-joined form in `name`.
export function caseDisplayName(c: TestCase): string {
  return [...(c.path ? [c.path] : []), ...(c.scope ?? []), c.name].join(' › ')
}

// caseLocation renders the copyable `path:line[:col]` form, or '' without a path.
export function caseLocation(c: TestCase): string {
  if (!c.path) return ''
  let loc = c.path
  if (c.line != null && c.line > 0) {
    loc += `:${c.line}`
    if (c.col != null && c.col > 0) loc += `:${c.col}`
  }
  return loc
}

// buildFixTestMessage renders the chat message the tests panel's "fix this test"
// sparkle would send: which runner and case, where it lives, and the runner's
// own output for it fenced verbatim. Everything comes off the case itself - the
// user is shown this exact string in a confirmation before anything is sent, so
// it has to be complete and literal rather than a summary filled in later.
//
// The closing instruction is deliberate: the shortest path to a green run is to
// weaken the assertion, and that is almost never what you wanted when you
// clicked the button on a failure.
export function buildFixTestMessage(runner: string, c: TestCase): string {
  const loc = caseLocation(c)
  const lines = [`The \`${runner}\` test runner reports a ${c.status === 'warning' ? 'warning' : 'failure'}.`, '']
  lines.push(`Test: ${c.scope?.length ? `${c.scope.join(' > ')} > ${c.name}` : c.name}`)
  if (loc) lines.push(`Location: ${loc}`)
  if (c.message) lines.push('', 'Output:', '```', c.message.trimEnd(), '```')
  lines.push('', 'Find out what is actually wrong and fix the underlying cause. Only change the test itself if the test is the thing that is wrong.')
  return lines.join('\n')
}
