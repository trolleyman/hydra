// Per-artifact UI preferences persisted to localStorage, keyed by
// project + agent + artifact name, so toggles like "expanded", "show unchanged"
// and "build log open" survive a reload and switching between agents.
//
// Two cleanup mechanisms keep the store from growing without bound:
//   1. TTL - entries untouched for ARTIFACT_TTL_MS are pruned on boot.
//   2. Status reset - a saved entry is only honoured while the artifact's status
//      is unchanged. When a card goes generating → ready/error (or is
//      regenerated) the stale entry is ignored, so the card falls back to its
//      status-derived defaults instead of restoring a now-irrelevant toggle.

import { ARTIFACT_PREFS_PREFIX, ARTIFACT_TAG_FILTER_PREFIX, artifactChromeKey, artifactChromeProjectKey, artifactPrefsKey, artifactTagFilterKey, createShardedStore, readJSON, writeJSON } from './storage'

export type ArtifactPrefs = {
  collapsed?: boolean
  buildLogOpen?: boolean
}

// What we store: the prefs plus the status they were saved under (used as a
// relevance check on load). The shared sharded store adds the TTL timestamp and
// owns the JSON/prune boilerplate; the tag-filter key shares this prefix but is a
// different shape, so prune skips it. See storage.ts createShardedStore.
type StoredArtifactPrefs = ArtifactPrefs & { status: string }

const ARTIFACT_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

const store = createShardedStore<StoredArtifactPrefs>(ARTIFACT_PREFS_PREFIX, ARTIFACT_TTL_MS, {
  skipPrefix: ARTIFACT_TAG_FILTER_PREFIX,
})

// Load the saved prefs for an artifact, but only if they are still relevant:
// the artifact's status must match the one they were saved under, and the entry
// must not have expired. Returns null otherwise (→ caller uses its defaults).
export function loadArtifactPrefs(
  projectId: string | null,
  agentId: string,
  name: string,
  status: string,
): ArtifactPrefs | null {
  const stored = store.load(artifactPrefsKey(projectId, agentId, name))
  if (!stored) return null
  if (stored.status !== status) return null
  return { collapsed: stored.collapsed, buildLogOpen: stored.buildLogOpen }
}

export function saveArtifactPrefs(
  projectId: string | null,
  agentId: string,
  name: string,
  status: string,
  prefs: ArtifactPrefs,
): void {
  store.save(artifactPrefsKey(projectId, agentId, name), { ...prefs, status })
}

// The artifact tag filter, shared across an agent's cards. Every value is shown
// (every checkbox on) by default; the filter records only what the user has
// turned OFF. `scoped` maps a label category (e.g. "theme") to its hidden values
// (e.g. ["dark"]) - a file is dropped if its value for that category is among
// them; an absent or empty list means "nothing hidden" (show all). `free` is the
// set of hidden free-form tags. An empty filter (no scoped values, no free tags)
// means "show everything".
export type ArtifactTagFilter = {
  scoped: Record<string, string[]>
  free: string[]
  // changeThreshold is the "% changed" gate on the built-in change-type filter: a
  // file reported 'modified' whose change_ratio is below this percentage (0-100)
  // is treated as 'unchanged' - i.e. how much of an image's pixels (or a video's
  // frames) must differ before the change "counts". 0 (the default) gates nothing,
  // so any real difference counts as modified. Lives on the filter so it persists
  // and flows through the same plumbing as the scoped/free toggles.
  changeThreshold?: number
}

// Clamp an arbitrary value to a sane change-threshold percentage (0-100, rounded).
// Used when reading back persisted state and when the slider reports a new value.
export function clampChangeThreshold(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(100, Math.round(n))
}

// The built-in change-type filter is a reserved scope (like the media-type one in
// ArtifactsPanel) whose values are a file's change_type (added/removed/modified/
// unchanged). Unlike the user scopes it defaults to HIDING unchanged, preserving
// the old "unchanged hidden by default" behaviour - so a fresh or legacy filter
// (no stored 'change' key) seeds ['unchanged']. Once the user touches it, the
// stored value (even []) wins, distinguishing "show all" from "never set".
export const ARTIFACT_CHANGE_CATEGORY = 'change'
export const DEFAULT_HIDDEN_CHANGE_TYPES = ['unchanged']

// The default filter: nothing hidden, except the change-type scope hides
// 'unchanged'. Exported so the "reset filters" affordance can restore it.
export function defaultTagFilter(): ArtifactTagFilter {
  return { scoped: { [ARTIFACT_CHANGE_CATEGORY]: [...DEFAULT_HIDDEN_CHANGE_TYPES] }, free: [] }
}

// isDefaultTagFilter reports whether a filter is at its default - every category
// empty (nothing hidden) except 'change', which must be exactly its default hidden
// set. Drives whether the "reset filters" button shows.
export function isDefaultTagFilter(filter: ArtifactTagFilter): boolean {
  if (filter.free.length > 0) return false
  if (clampChangeThreshold(filter.changeThreshold) !== 0) return false
  const cats = new Set([...Object.keys(filter.scoped), ARTIFACT_CHANGE_CATEGORY])
  for (const cat of cats) {
    const off = filter.scoped[cat] ?? []
    const expected = cat === ARTIFACT_CHANGE_CATEGORY ? DEFAULT_HIDDEN_CHANGE_TYPES : []
    if (off.length !== expected.length || off.some((v) => !expected.includes(v))) return false
  }
  return true
}

export function loadTagFilter(projectId: string | null, agentId: string): ArtifactTagFilter {
  const parsed = readJSON(artifactTagFilterKey(projectId, agentId), (v) =>
    v && typeof v === 'object' ? (v as { scoped?: unknown; free?: unknown; changeThreshold?: unknown }) : null,
  )
  if (!parsed) return defaultTagFilter()
  const scoped: Record<string, string[]> = {}
  if (parsed.scoped && typeof parsed.scoped === 'object') {
    // Normalize each category to a string[]. Tolerate the legacy single-value
    // shape (Record<string, string>) by wrapping a non-empty string in a list.
    for (const [cat, v] of Object.entries(parsed.scoped as Record<string, unknown>)) {
      if (Array.isArray(v)) scoped[cat] = v.filter((x): x is string => typeof x === 'string')
      else if (typeof v === 'string' && v) scoped[cat] = [v]
    }
  }
  // Seed the change-type default only when it was never stored (legacy/fresh) -
  // an explicitly-stored value, including [], is respected.
  if (!(ARTIFACT_CHANGE_CATEGORY in scoped)) scoped[ARTIFACT_CHANGE_CATEGORY] = [...DEFAULT_HIDDEN_CHANGE_TYPES]
  return {
    scoped,
    free: Array.isArray(parsed.free) ? parsed.free.filter((t): t is string => typeof t === 'string') : [],
    changeThreshold: clampChangeThreshold(parsed.changeThreshold),
  }
}

export function saveTagFilter(projectId: string | null, agentId: string, filter: ArtifactTagFilter): void {
  writeJSON(artifactTagFilterKey(projectId, agentId), filter)
}

// Drop expired artifact-pref entries. Cheap to call once on app boot. The
// tag-filter key shares this prefix but is a different shape (no timestamp), so
// the store skips it (see createShardedStore's skipPrefix above). Chrome entries
// (load/saveArtifactChrome) share the prefix too but DO carry a timestamp, so
// this same sweep prunes the stale ones - no separate prune needed.
export function pruneArtifactPrefs(): void {
  store.prune()
}

// The artifacts panel's cached "chrome": the script names + the union of
// available tags of a settled comparison. Persisted client-side so re-opening an
// agent's diff renders the header, tag filter and collapsed card headers
// instantly - with no network round-trip - while the live comparison loads in.
// Layout is deliberately NOT cached (too many inputs affect it); only this
// lightweight chrome.
export type ArtifactChrome = { names: string[]; tags: string[] }

// Same TTL as the per-card prefs, and a `t` stamp so the shared artifact-prefs
// prune (above) drops stale chrome entries too.
const ARTIFACT_CHROME_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days
type StoredChrome = ArtifactChrome & { t: number }

function readChrome(key: string): ArtifactChrome | null {
  const s = readJSON<StoredChrome>(key, (v) => {
    if (!v || typeof v !== 'object') return null
    const o = v as { names?: unknown; tags?: unknown; t?: unknown }
    if (!Array.isArray(o.names) || !Array.isArray(o.tags) || typeof o.t !== 'number') return null
    return {
      names: o.names.filter((x): x is string => typeof x === 'string'),
      tags: o.tags.filter((x): x is string => typeof x === 'string'),
      t: o.t,
    }
  })
  if (!s || Date.now() - s.t > ARTIFACT_CHROME_TTL_MS) return null
  return { names: s.names, tags: s.tags }
}

// loadArtifactChrome returns the last-known chrome for this agent, falling back
// to the most recent chrome saved for the project (a brand-new agent can borrow a
// sibling's, since artifact scripts are project-wide). null when neither exists
// or both have expired.
export function loadArtifactChrome(projectId: string | null, agentId: string): ArtifactChrome | null {
  return readChrome(artifactChromeKey(projectId, agentId)) ?? readChrome(artifactChromeProjectKey(projectId))
}

// saveArtifactChrome records a settled comparison's chrome under both the per-agent
// and per-project keys (see loadArtifactChrome's fallback). Names/tags are stored
// as given (the caller sorts + dedupes).
export function saveArtifactChrome(projectId: string | null, agentId: string, chrome: ArtifactChrome): void {
  const payload: StoredChrome = { names: chrome.names, tags: chrome.tags, t: Date.now() }
  writeJSON(artifactChromeKey(projectId, agentId), payload)
  writeJSON(artifactChromeProjectKey(projectId), payload)
}
