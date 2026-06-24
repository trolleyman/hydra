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

import { ARTIFACT_PREFS_PREFIX, ARTIFACT_TAG_FILTER_PREFIX, artifactPrefsKey, artifactTagFilterKey, readLocal, writeLocal } from './storage'

export type ArtifactPrefs = {
  collapsed?: boolean
  buildLogOpen?: boolean
}

// What we actually store: the prefs plus the status they were saved under and a
// last-touched timestamp for TTL pruning.
type StoredArtifactPrefs = ArtifactPrefs & { status: string; t: number }

const ARTIFACT_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

function readStored(k: string): StoredArtifactPrefs | null {
  const raw = readLocal(k)
  if (!raw) return null
  try {
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
  const stored = readStored(artifactPrefsKey(projectId, agentId, name))
  if (!stored) return null
  if (stored.status !== status) return null
  if (Date.now() - stored.t > ARTIFACT_TTL_MS) return null
  return { collapsed: stored.collapsed, buildLogOpen: stored.buildLogOpen }
}

export function saveArtifactPrefs(
  projectId: string | null,
  agentId: string,
  name: string,
  status: string,
  prefs: ArtifactPrefs,
): void {
  const value: StoredArtifactPrefs = { ...prefs, status, t: Date.now() }
  writeLocal(artifactPrefsKey(projectId, agentId, name), JSON.stringify(value))
}

// The artifact tag filter, shared across an agent's cards. Every value is shown
// (every checkbox on) by default; the filter records only what the user has
// turned OFF. `scoped` maps a label category (e.g. "theme") to its hidden values
// (e.g. ["dark"]) — a file is dropped if its value for that category is among
// them; an absent or empty list means "nothing hidden" (show all). `free` is the
// set of hidden free-form tags. An empty filter (no scoped values, no free tags)
// means "show everything".
export type ArtifactTagFilter = {
  scoped: Record<string, string[]>
  free: string[]
}

// The built-in change-type filter is a reserved scope (like the media-type one in
// ArtifactsPanel) whose values are a file's change_type (added/removed/modified/
// unchanged). Unlike the user scopes it defaults to HIDING unchanged, preserving
// the old "unchanged hidden by default" behaviour — so a fresh or legacy filter
// (no stored 'change' key) seeds ['unchanged']. Once the user touches it, the
// stored value (even []) wins, distinguishing "show all" from "never set".
export const ARTIFACT_CHANGE_CATEGORY = 'change'
const DEFAULT_HIDDEN_CHANGE_TYPES = ['unchanged']

function defaultTagFilter(): ArtifactTagFilter {
  return { scoped: { [ARTIFACT_CHANGE_CATEGORY]: [...DEFAULT_HIDDEN_CHANGE_TYPES] }, free: [] }
}

export function loadTagFilter(projectId: string | null, agentId: string): ArtifactTagFilter {
  const raw = readLocal(artifactTagFilterKey(projectId, agentId))
  if (!raw) return defaultTagFilter()
  try {
    const parsed = JSON.parse(raw) as { scoped?: unknown; free?: unknown }
    const scoped: Record<string, string[]> = {}
    if (parsed.scoped && typeof parsed.scoped === 'object') {
      // Normalize each category to a string[]. Tolerate the legacy single-value
      // shape (Record<string, string>) by wrapping a non-empty string in a list.
      for (const [cat, v] of Object.entries(parsed.scoped as Record<string, unknown>)) {
        if (Array.isArray(v)) scoped[cat] = v.filter((x): x is string => typeof x === 'string')
        else if (typeof v === 'string' && v) scoped[cat] = [v]
      }
    }
    // Seed the change-type default only when it was never stored (legacy/fresh) —
    // an explicitly-stored value, including [], is respected.
    if (!(ARTIFACT_CHANGE_CATEGORY in scoped)) scoped[ARTIFACT_CHANGE_CATEGORY] = [...DEFAULT_HIDDEN_CHANGE_TYPES]
    return {
      scoped,
      free: Array.isArray(parsed.free) ? parsed.free.filter((t): t is string => typeof t === 'string') : [],
    }
  } catch {
    return defaultTagFilter()
  }
}

export function saveTagFilter(projectId: string | null, agentId: string, filter: ArtifactTagFilter): void {
  writeLocal(artifactTagFilterKey(projectId, agentId), JSON.stringify(filter))
}

// Drop expired artifact-pref entries. Cheap to call once on app boot; iterating
// localStorage is fine given the small number of keys Hydra writes.
export function pruneArtifactPrefs(): void {
  try {
    const now = Date.now()
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(ARTIFACT_PREFS_PREFIX)) continue
      // The tag-filter key shares the artifact prefix but is a different shape
      // (no status/timestamp), so don't treat it as a stale/corrupt prefs entry.
      if (k.startsWith(ARTIFACT_TAG_FILTER_PREFIX)) continue
      const stored = readStored(k)
      if (!stored || now - stored.t > ARTIFACT_TTL_MS) stale.push(k)
    }
    for (const k of stale) localStorage.removeItem(k)
  } catch { /* ignore */ }
}
