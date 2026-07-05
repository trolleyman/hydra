// Status filtering + free-text search for test cases, shared by every runner
// card in the TestsPanel - the tests analog of artifactFilter/artifactPrefs.
// Tests filter like the artifacts diff: the boring, expected outcomes (like
// 'unchanged' artifacts) are hidden by default; the filter records only the
// statuses the user has turned OFF, so an empty list means show all.

import type { TestCase } from '../api/models/TestCase'
import { searchFiles } from './artifactFilter'
import { caseDisplayName } from './testCases'
import { testFilterKey, readJSON, writeJSON } from './storage'

// The order the status dropdown offers values in - most interesting first,
// mirroring CHANGE_TYPE_ORDER. All four are always offered (a status with no
// cases just counts 0) so the menu is constant and predictable.
export const TEST_STATUS_ORDER = ['failed', 'warning', 'skipped', 'passed'] as const
export type TestCaseStatusValue = (typeof TEST_STATUS_ORDER)[number]

// The default hidden statuses depend on the view mode: the unified tree hides
// the boring outcomes (passed + skipped); the group-by-result view hides
// nothing - it keeps every status as its own section (passing folded shut by
// default, and a folded section mounts no rows), so a filter would be redundant.
export function defaultHiddenStatuses(groupResult: boolean): string[] {
  return groupResult ? [] : ['passed', 'skipped']
}

// The test filter: the statuses turned OFF (hidden). Mirrors the artifact tag
// filter's inverted model so the same TagScopeFilter dropdown drives it.
export type TestFilter = {
  status: string[]
}

export function defaultTestFilter(groupResult: boolean): TestFilter {
  return { status: defaultHiddenStatuses(groupResult) }
}

// isDefaultTestFilter drives the "reset" affordance and the decision to stop
// persisting: true when the hidden set is exactly the mode's default.
export function isDefaultTestFilter(filter: TestFilter, groupResult: boolean): boolean {
  const def = defaultHiddenStatuses(groupResult)
  return filter.status.length === def.length && def.every((s) => filter.status.includes(s))
}

// loadTestFilter returns the user's explicit customization, or null when none
// is stored - the caller then applies the mode-dependent default, and keeps
// tracking the mode as it changes.
export function loadTestFilter(projectId: string | null, agentId: string): TestFilter | null {
  const parsed = readJSON(testFilterKey(projectId, agentId), (v) =>
    v && typeof v === 'object' ? (v as { status?: unknown }) : null,
  )
  if (!parsed || !Array.isArray(parsed.status)) return null
  return { status: parsed.status.filter((s): s is string => typeof s === 'string') }
}

// saveTestFilter persists an explicit customization; null clears it so the
// mode-dependent default applies again.
export function saveTestFilter(projectId: string | null, agentId: string, filter: TestFilter | null): void {
  writeJSON(testFilterKey(projectId, agentId), filter)
}

export function caseMatchesFilter(c: TestCase, filter: TestFilter): boolean {
  return !filter.status.includes(c.status)
}

// computeVisibleCases is the single source of truth for which of a runner's
// cases are shown, and in what order: the status filter hides cases, then the
// search query (when present) narrows + ranks them - the same pipeline as
// computeVisibleFiles for artifacts. Search fuzzy-matches the full display
// name (path › scope › name), reusing the artifact search machinery.
export function computeVisibleCases(cases: TestCase[], filter: TestFilter, search: string): TestCase[] {
  const filtered = filter.status.length > 0 ? cases.filter((c) => caseMatchesFilter(c, filter)) : cases
  if (!search.trim()) return filtered
  return searchFiles(
    filtered.map((c) => ({ name: caseDisplayName(c), case: c })),
    search,
  ).map((x) => x.case)
}

// computeStatusCounts tallies cases per status across every runner (the status
// scope ignores its own toggles, and there is no other scope, so these are raw
// counts). Shown dimmed beside each dropdown checkbox.
export function computeStatusCounts(cases: TestCase[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of TEST_STATUS_ORDER) out[s] = 0
  for (const c of cases) out[c.status] = (out[c.status] ?? 0) + 1
  return out
}
