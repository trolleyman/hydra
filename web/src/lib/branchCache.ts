// Shared cache + fetch for a project's branch list.
//
// Three places show a BranchSelector - the agent header's base-branch picker,
// the repository view's branch/compare pickers and the spawn options popover -
// and each used to issue its own uncached `getRepositoryBranches` on mount, then
// render a flat placeholder until it landed. On a repo where `git branch` isn't
// instant that reads as the dropdown "popping in" a beat after everything else.
//
// So: one module-level cache per project, mirrored into localStorage, plus
// in-flight de-duplication. A selector reads `peekBranches` during its first
// render (synchronous, no network) and only shows its loading state when there
// is genuinely nothing cached - a cold first visit to a project. The fetch still
// runs every time and replaces the cache wholesale; the cache is a first paint,
// never a source of truth.

import { api } from '../stores/apiClient'
import type { RepositoryBranch } from '../api'
import { BRANCHES_CACHE_PREFIX, branchesCacheKey, createShardedStore } from './storage'

export type BranchList = {
  branches: RepositoryBranch[]
  // The repo's checked-out branch (HEAD), '' when unknown.
  current: string
  // Stable repository default, independent of the checked-out branch.
  default: string
}

// A week, matching the agent-list cache: a stale branch list is still a useful
// head start (the picker refreshes on open), and beyond that the entry is more
// likely a project the user has stopped using.
const TTL_MS = 7 * 24 * 60 * 60 * 1000

// Cap on cached branches per project. Well above any real repo's branch count,
// and it bounds what a repo with thousands of branches can write into the ~5MB
// localStorage shared with every other Hydra key. Only the cached first paint is
// truncated - the live list from the fetch is never capped.
const MAX_BRANCHES = 300

const store = createShardedStore<{ list: BranchList }>(BRANCHES_CACHE_PREFIX, TTL_MS)

// The freshest list per project this session. Preferred over localStorage, which
// is only consulted once per project (on the first peek after a page load).
const memory = new Map<string, BranchList>()
// In-flight requests, so three selectors mounting together share one round trip.
const inflight = new Map<string, Promise<BranchList>>()

function valid(list: unknown): list is BranchList {
  if (!list || typeof list !== 'object') return false
  const l = list as BranchList
  return typeof l.current === 'string' && typeof l.default === 'string'
    && Array.isArray(l.branches) && l.branches.every((b) => !!b && typeof b.name === 'string')
}

// The cached branch list for a project, or null when there is nothing usable -
// synchronous and network-free, so it can seed `useState` during first render.
export function peekBranches(projectId: string | null | undefined): BranchList | null {
  if (!projectId) return null
  const mem = memory.get(projectId)
  if (mem) return mem
  const entry = store.load(branchesCacheKey(projectId))
  if (!entry || !valid(entry.list)) return null
  memory.set(projectId, entry.list)
  return entry.list
}

// Fetch the project's branches, sharing one request between concurrent callers.
// Rejects on failure (callers decide what a failed load means for their UI); the
// previously cached list is left alone.
export function fetchBranches(projectId: string): Promise<BranchList> {
  const pending = inflight.get(projectId)
  if (pending) return pending
  const p = api.default.getRepositoryBranches(projectId)
    .then((r) => {
      const list: BranchList = { branches: r.branches, current: r.current || '', default: r.default || '' }
      memory.set(projectId, list)
      store.save(branchesCacheKey(projectId), {
        list: { branches: list.branches.slice(0, MAX_BRANCHES), current: list.current, default: list.default },
      })
      return list
    })
    .finally(() => {
      if (inflight.get(projectId) === p) inflight.delete(projectId)
    })
  inflight.set(projectId, p)
  return p
}

// Boot-time sweep of expired entries, alongside the other pruned stores.
export function pruneBranchCaches(): void {
  store.prune()
}
