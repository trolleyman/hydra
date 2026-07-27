// Per-project cache of the last live agent list, so switching into a project
// paints its sidebar immediately instead of leaving the *previous* project's
// agents on screen until the list request lands - which, on a project with real
// work in it, is seconds rather than milliseconds.
//
// This is a placeholder, not a source of truth: the first real response replaces
// it wholesale. It deliberately does NOT feed the background-merge detection
// (see useAgentPolling - the cache is seeded with a null project id so
// setAgents treats the following fetch as a project switch, not a refresh);
// otherwise an agent merged while the app was closed would toast "merged" on
// every boot.

import type { AgentResponse } from '../api'
import { AGENTS_CACHE_PREFIX, agentsCacheKey, createShardedStore } from './storage'

// A week. The cache is only ever a first paint, so a stale-but-plausible list is
// still worth showing; beyond that the entry is more likely to be a project the
// user has stopped using than a useful head start.
const TTL_MS = 7 * 24 * 60 * 60 * 1000

// Cap on cached rows per project. The sidebar shows the live (non-archived)
// agents, so this is far above any real project, and it bounds what a project
// with a runaway agent count can write into a ~5MB localStorage shared with
// every other Hydra key.
const MAX_AGENTS = 60

const store = createShardedStore<{ agents: AgentResponse[] }>(AGENTS_CACHE_PREFIX, TTL_MS)

// Cached agents for a project, or null when there is nothing usable stored.
// Entries without an id are dropped: everything downstream keys by it.
export function loadCachedAgents(projectId: string): AgentResponse[] | null {
  const entry = store.load(agentsCacheKey(projectId))
  if (!entry || !Array.isArray(entry.agents)) return null
  const agents = entry.agents.filter(
    (a): a is AgentResponse => !!a && typeof a === 'object' && typeof (a as AgentResponse).id === 'string' && !!(a as AgentResponse).id,
  )
  return agents.length > 0 ? agents : null
}

export function saveCachedAgents(projectId: string, agents: AgentResponse[]): void {
  store.save(agentsCacheKey(projectId), { agents: agents.slice(0, MAX_AGENTS) })
}

// Boot-time sweep of expired entries, alongside the other pruned stores.
export function pruneAgentCaches(): void {
  store.prune()
}
