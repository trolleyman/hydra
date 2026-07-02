// Status filtering + free-text search for test cases, shared by every runner
// card in the TestsPanel — the tests analog of artifactFilter/artifactPrefs.
// Tests filter like the artifacts diff: passing is the boring, expected state
// (like 'unchanged' artifacts) and is hidden by default; the filter records
// only the statuses the user has turned OFF, so an empty list means show all.

import type { TestCase } from '../api/models/TestCase'
import { searchFiles } from './artifactFilter'
import { caseDisplayName } from './testCases'
import { testFilterKey, readJSON, writeJSON } from './storage'

// The order the status dropdown offers values in — most interesting first,
// mirroring CHANGE_TYPE_ORDER. All four are always offered (a status with no
// cases just counts 0) so the menu is constant and predictable.
export const TEST_STATUS_ORDER = ['failed', 'warning', 'skipped', 'passed'] as const
export type TestCaseStatusValue = (typeof TEST_STATUS_ORDER)[number]

export const DEFAULT_HIDDEN_STATUSES: string[] = ['passed']

// The test filter: the statuses turned OFF (hidden). Mirrors the artifact tag
// filter's inverted model so the same TagScopeFilter dropdown drives it.
export type TestFilter = {
  status: string[]
}

export function defaultTestFilter(): TestFilter {
  return { status: [...DEFAULT_HIDDEN_STATUSES] }
}

// isDefaultTestFilter drives the "reset" affordance: true when the hidden set
// is exactly the default (only 'passed').
export function isDefaultTestFilter(filter: TestFilter): boolean {
  return (
    filter.status.length === DEFAULT_HIDDEN_STATUSES.length &&
    DEFAULT_HIDDEN_STATUSES.every((s) => filter.status.includes(s))
  )
}

export function loadTestFilter(projectId: string | null, agentId: string): TestFilter {
  const parsed = readJSON(testFilterKey(projectId, agentId), (v) =>
    v && typeof v === 'object' ? (v as { status?: unknown }) : null,
  )
  if (!parsed || !Array.isArray(parsed.status)) return defaultTestFilter()
  return { status: parsed.status.filter((s): s is string => typeof s === 'string') }
}

export function saveTestFilter(projectId: string | null, agentId: string, filter: TestFilter): void {
  writeJSON(testFilterKey(projectId, agentId), filter)
}

export function caseMatchesFilter(c: TestCase, filter: TestFilter): boolean {
  return !filter.status.includes(c.status)
}

// computeVisibleCases is the single source of truth for which of a runner's
// cases are shown, and in what order: the status filter hides cases, then the
// search query (when present) narrows + ranks them — the same pipeline as
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
