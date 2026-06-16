// Per-agent view preferences persisted to localStorage, keyed by project +
// agent, so an agent's detail page restores its own layout on reload and when
// switching between agents — treating each agent like its own page. We persist:
//   - terminalHeight: the height the user dragged the terminal panel to.
//   - scrollTop: the scroll position of the agent detail page.
//   - collapsedFiles: which files are collapsed in the diff viewer.
//
// All three live in a single entry per agent (rather than three keys) so the
// store stays compact and a single TTL prune drops everything for a stale
// agent at once. Entries untouched for AGENT_VIEW_TTL_MS are pruned on boot.

import { agentViewPrefsKey, AGENT_VIEW_PREFS_PREFIX, readLocal, writeLocal } from './storage'

export type AgentViewPrefs = {
  terminalHeight?: number
  scrollTop?: number
  collapsedFiles?: string[]
}

// What we actually store: the prefs plus a last-touched timestamp for TTL.
type StoredAgentViewPrefs = AgentViewPrefs & { t: number }

const AGENT_VIEW_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

function readStored(k: string): StoredAgentViewPrefs | null {
  const raw = readLocal(k)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as StoredAgentViewPrefs
    if (!parsed || typeof parsed !== 'object' || typeof parsed.t !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

// Load the saved view prefs for an agent. Returns an empty object when nothing
// is stored or the entry has expired (→ callers fall back to their defaults).
export function loadAgentViewPrefs(projectId: string | null, agentId: string): AgentViewPrefs {
  const stored = readStored(agentViewPrefsKey(projectId, agentId))
  if (!stored) return {}
  if (Date.now() - stored.t > AGENT_VIEW_TTL_MS) return {}
  return { terminalHeight: stored.terminalHeight, scrollTop: stored.scrollTop, collapsedFiles: stored.collapsedFiles }
}

// Merge a partial update into an agent's stored prefs, refreshing the TTL.
// Read-modify-write so the three independent writers (terminal, page scroll,
// diff viewer) each update only their own field without clobbering the others.
export function patchAgentViewPrefs(
  projectId: string | null,
  agentId: string,
  patch: Partial<AgentViewPrefs>,
): void {
  const k = agentViewPrefsKey(projectId, agentId)
  const current = readStored(k)
  const value: StoredAgentViewPrefs = { ...current, ...patch, t: Date.now() }
  writeLocal(k, JSON.stringify(value))
}

// Drop expired agent-view-pref entries. Cheap to call once on app boot.
export function pruneAgentViewPrefs(): void {
  try {
    const now = Date.now()
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(AGENT_VIEW_PREFS_PREFIX)) continue
      const stored = readStored(k)
      if (!stored || now - stored.t > AGENT_VIEW_TTL_MS) stale.push(k)
    }
    for (const k of stale) localStorage.removeItem(k)
  } catch { /* ignore */ }
}
