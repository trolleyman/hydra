import { readJSON, StorageKeys, writeJSON } from './storage'
import type { AgentTypeOption } from './spawnDefaults'

const AGENT_TYPE_IDS: AgentTypeOption[] = ['claude', 'gemini', 'copilot', 'codex']

function isAgentType(value: unknown): value is AgentTypeOption {
  return typeof value === 'string' && AGENT_TYPE_IDS.includes(value as AgentTypeOption)
}

export function readModelProviderRecency(): AgentTypeOption[] {
  return readJSON<AgentTypeOption[]>(StorageKeys.modelProviderRecency, (value) =>
    Array.isArray(value) && value.every(isAgentType) ? value : null,
  ) ?? []
}

export function recordModelProviderUse(agent: AgentTypeOption): void {
  writeJSON(StorageKeys.modelProviderRecency, [agent, ...readModelProviderRecency().filter((id) => id !== agent)])
}

// The selected provider is always immediately reachable. The remaining groups
// retain their curated fallback order, except that providers used more recently
// rise above ones used less recently. Model order inside each group is unchanged.
export function orderModelProviders<T extends { id: AgentTypeOption }>(
  providers: readonly T[],
  active: AgentTypeOption,
  recency = readModelProviderRecency(),
): T[] {
  const rank = new Map(recency.map((id, index) => [id, index]))
  return [...providers].sort((a, b) => {
    if (a.id === active) return -1
    if (b.id === active) return 1
    return (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)
  })
}
