// Per-artifact UI preferences persisted to localStorage, keyed by
// project + agent + artifact name, so toggles like "expanded", "show unchanged"
// and "build log open" survive a reload and switching between agents.
//
// Two cleanup mechanisms keep the store from growing without bound:
//   1. TTL — entries untouched for ARTIFACT_TTL_MS are pruned on boot.
//   2. Status reset — a saved entry is only honoured while the artifact's status
//      is unchanged. When a card goes generating → ready/error (or is
//      regenerated) the stale entry is ignored, so the card falls back to its
//      status-derived defaults instead of restoring a now-irrelevant toggle.

export type ArtifactPrefs = {
  collapsed?: boolean
  showUnchanged?: boolean
  buildLogOpen?: boolean
}

// What we actually store: the prefs plus the status they were saved under and a
// last-touched timestamp for TTL pruning.
type StoredArtifactPrefs = ArtifactPrefs & { status: string; t: number }

const PREFIX = 'hydra:artifact:'
const ARTIFACT_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

function key(projectId: string | null, agentId: string, name: string): string {
  // projectId can be null for the "no project" case; '_' keeps the key shape stable.
  return `${PREFIX}${projectId ?? '_'}:${agentId}:${name}`
}

function readStored(k: string): StoredArtifactPrefs | null {
  try {
    const raw = localStorage.getItem(k)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredArtifactPrefs
    if (!parsed || typeof parsed !== 'object' || typeof parsed.t !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

// Load the saved prefs for an artifact, but only if they are still relevant:
// the artifact's status must match the one they were saved under, and the entry
// must not have expired. Returns null otherwise (→ caller uses its defaults).
export function loadArtifactPrefs(
  projectId: string | null,
  agentId: string,
  name: string,
  status: string,
): ArtifactPrefs | null {
  const stored = readStored(key(projectId, agentId, name))
  if (!stored) return null
  if (stored.status !== status) return null
  if (Date.now() - stored.t > ARTIFACT_TTL_MS) return null
  return { collapsed: stored.collapsed, showUnchanged: stored.showUnchanged, buildLogOpen: stored.buildLogOpen }
}

export function saveArtifactPrefs(
  projectId: string | null,
  agentId: string,
  name: string,
  status: string,
  prefs: ArtifactPrefs,
): void {
  try {
    const value: StoredArtifactPrefs = { ...prefs, status, t: Date.now() }
    localStorage.setItem(key(projectId, agentId, name), JSON.stringify(value))
  } catch { /* ignore quota / disabled storage */ }
}

// Drop expired artifact-pref entries. Cheap to call once on app boot; iterating
// localStorage is fine given the small number of keys Hydra writes.
export function pruneArtifactPrefs(): void {
  try {
    const now = Date.now()
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(PREFIX)) continue
      const stored = readStored(k)
      if (!stored || now - stored.t > ARTIFACT_TTL_MS) stale.push(k)
    }
    for (const k of stale) localStorage.removeItem(k)
  } catch { /* ignore */ }
}
