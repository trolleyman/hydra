// Single source of truth for every localStorage key Hydra uses.
//
// Keep keys here rather than as inline string literals so two features can't
// silently collide on the same key, and so the full set is auditable in one
// place. Every key shares the `hydra-` prefix; keys with dynamic segments are
// exposed as builder functions so their prefix lives in exactly one spot.

// ── Static keys ──────────────────────────────────────────────────────────────

export const StorageKeys = {
  projectId: 'hydra-project-id',
  themeMode: 'hydra-theme-mode',
  sidebarWidth: 'hydra-sidebar-width',
  // '1' when the user has collapsed the sidebar (no top bar layout). Only the
  // explicit toggle persists this; the small-screen auto-close on navigation is
  // transient so it doesn't clobber the desktop preference.
  sidebarCollapsed: 'hydra-sidebar-collapsed',
  defaultAgentType: 'hydra-default-agent-type',
  // Remembered model per agent type (JSON map, e.g. {"claude":"opus"}). Keyed by
  // agent type because each CLI has its own model aliases; picking a model in the
  // spawn form seeds the next spawn of that same agent type. '' / absent = the
  // CLI's own default.
  defaultModel: 'hydra-default-model',
  spawnHeight: 'hydra-sidebar-spawn-height',

  diffSideBySide: 'hydra-diff-side-by-side',
  diffIgnoreWhitespace: 'hydra-diff-ignore-whitespace',
  diffSingleFile: 'hydra-diff-single-file',
  diffFileView: 'hydra-diff-file-view',
  diffSidebarWidth: 'hydra-diff-sidebar-width',
  diffImageMode: 'hydra-diff-image-mode',
  // Artifact masonry layout: JSON map of file name → column span override, set by
  // dragging a tile's edge. Tiles without an entry auto-span by aspect ratio.
  // Shared across every artifact card (one layout for the whole panel).
  diffArtifactSpans: 'hydra-diff-artifact-spans',
  // Global artifact-tile size multiplier (a string float, e.g. '1.5'), set by the
  // size slider in the diff settings popup. Scales every tile's auto column span up
  // or down so the whole grid can be enlarged/shrunk without per-tile drags.
  diffArtifactScale: 'hydra-diff-artifact-scale',
  // Global before/after view ('before' | 'after') for the A/B compare mode, shared
  // across every artifact tile (flip them all at once; keyboard "B").
  diffArtifactView: 'hydra-diff-artifact-view',
  // Global "highlight changed pixels" toggle ('true'/'false') for the A/B compare
  // mode, shared across every tile (keyboard "H").
  diffArtifactHighlight: 'hydra-diff-artifact-highlight',

  // Last terminal geometry the client successfully sent (JSON {cols, rows}). Seeds
  // the initial PTY size on the next connection so a fresh/resumed agent renders
  // at the right width instead of flashing the 80x24 default (see AgentTerminal).
  terminalGeometry: 'hydra-terminal-geometry',
  // User-chosen default terminal height (rows) for newly spawned heads, set on the
  // user settings page. Used as the spawn height only when no last-height geometry
  // exists yet (see lib/terminalGeometry).
  terminalDefaultRows: 'hydra-terminal-default-rows',

  repoWrap: 'hydra-repo-wrap',
  repoIcons: 'hydra-repo-icons',
  repoSidebarWidth: 'hydra-repo-sidebar-width',
  // Repository branch-compare diff: show one file at a time (default) vs all
  // files stacked. Absent = the one-file default; 'false' = the multi-file view.
  repoDiffSingleFile: 'hydra-repo-diff-single-file',
  // Repository branch-compare diff: how the changed-files sidebar is laid out —
  // 'tree' (default, folders), 'flat', or 'grouped'. Mirrors the agent diff
  // viewer's own file-view setting, but kept under a separate key so the two
  // views can be configured independently.
  repoDiffFileView: 'hydra-repo-diff-file-view',

  // '1' when a test/screenshot harness wants to drive the toast store from page
  // context (see lib/toastHarness). Dormant unless explicitly set — only the
  // screenshot script seeds it (via addInitScript), never the app itself — so it
  // has no effect in real builds.
  toastHarness: 'hydra-toast-harness',
} as const

// ── Dynamic keys (prefix + builder pair) ─────────────────────────────────────

// Which view is last open within a project — an agent, the repository browser,
// or the bare project page. One entry per project. See lib/projectView.ts.
export const PROJECT_VIEW_PREFIX = 'hydra-project-view-'
export const projectViewKey = (projectId: string): string =>
  `${PROJECT_VIEW_PREFIX}${projectId}`

// Per-artifact view prefs, keyed by project + agent + artifact name (see
// artifactPrefs.ts). projectId may be null → '_' keeps the key shape stable.
export const ARTIFACT_PREFS_PREFIX = 'hydra-artifact-'
export const artifactPrefsKey = (projectId: string | null, agentId: string, name: string): string =>
  `${ARTIFACT_PREFS_PREFIX}${projectId ?? '_'}-${agentId}-${name}`

// Artifact tag filter, keyed by project + agent (one selection shared across all
// of an agent's artifact cards — see artifactPrefs.ts loadTagFilter/saveTagFilter).
// projectId may be null → '_' keeps the key shape stable. The `-v2-` version: the
// stored arrays used to list the *selected* (shown) values; they now list the
// values turned *off* (hidden), so the bump discards the old, now-inverted data.
export const ARTIFACT_TAG_FILTER_PREFIX = 'hydra-artifact-tagfilter-v2-'
export const artifactTagFilterKey = (projectId: string | null, agentId: string): string =>
  `${ARTIFACT_TAG_FILTER_PREFIX}${projectId ?? '_'}-${agentId}`

// Artifact "chrome" cache — the script names + available tags of a comparison,
// remembered client-side so the artifacts panel can render its header, tag filter
// and collapsed card headers instantly (no network) while the real comparison
// loads (see artifactPrefs.ts load/saveArtifactChrome). Two levels, both
// zero-network: per agent (the branch), and a per-project last-resort fallback
// (artifact config is project-wide, so a brand-new agent can borrow a sibling's
// chrome). Entries carry a `t` stamp, so the artifact-prefs prune below — which
// sweeps this same `hydra-artifact-` prefix — drops stale ones too. projectId may
// be null → '_' keeps the key shape stable.
export const ARTIFACT_CHROME_PREFIX = 'hydra-artifact-chrome-'
export const artifactChromeKey = (projectId: string | null, agentId: string): string =>
  `${ARTIFACT_CHROME_PREFIX}a-${projectId ?? '_'}-${agentId}`
export const artifactChromeProjectKey = (projectId: string | null): string =>
  `${ARTIFACT_CHROME_PREFIX}p-${projectId ?? '_'}`

// Test status filter, keyed by project + agent (one selection shared across all
// of an agent's test-runner cards — see testFilterPrefs.ts). Mirrors the artifact
// tag-filter model: the stored array lists the statuses turned *off* (hidden).
// projectId may be null → '_' keeps the key shape stable.
export const TEST_FILTER_PREFIX = 'hydra-test-filter-'
export const testFilterKey = (projectId: string | null, agentId: string): string =>
  `${TEST_FILTER_PREFIX}${projectId ?? '_'}-${agentId}`

// Per-agent view prefs (terminal height, page scroll, collapsed diff files) so
// each agent's detail page restores its own layout (see agentViewPrefs.ts).
// projectId may be null → '_' keeps the key shape stable.
export const AGENT_VIEW_PREFS_PREFIX = 'hydra-agent-view-'
export const agentViewPrefsKey = (projectId: string | null, agentId: string): string =>
  `${AGENT_VIEW_PREFS_PREFIX}${projectId ?? '_'}-${agentId}`

// Whether the sidebar's "Archived" section is collapsed, per project. Absent =
// collapsed (the default — archived history is rarely wanted, so it stays out of
// the way); '0' = the user explicitly expanded it. (Legacy '1' values from when
// collapsed was the non-default still read as collapsed.) Per-project so one
// project's choice doesn't leak into another's.
export const ARCHIVED_COLLAPSED_PREFIX = 'hydra-archived-collapsed-'
export const archivedCollapsedKey = (projectId: string): string =>
  `${ARCHIVED_COLLAPSED_PREFIX}${projectId}`

// Unsent spawn-prompt draft, per project and per layout (compact vs full).
export const promptDraftKey = (projectId: string, compact: boolean): string =>
  `hydra-prompt-draft-${compact ? 'compact' : 'full'}-${projectId}`

// Scroll offset (textarea scrollTop) of the spawn-prompt box, per project and
// per layout — mirrors promptDraftKey so a long draft restores to the same
// scroll position when switching back to its project.
export const promptScrollKey = (projectId: string, compact: boolean): string =>
  `hydra-prompt-scroll-${compact ? 'compact' : 'full'}-${projectId}`

// Running count of generically-named pasted images (image1.png, image2.png, …)
// for the spawn form, per project and per layout — mirrors promptDraftKey so the
// numbering stays separate across projects and survives a reload (the
// attachments themselves are in-session only; see lib/spawnDrafts.ts).
export const imageCounterKey = (projectId: string, compact: boolean): string =>
  `hydra-image-counter-${compact ? 'compact' : 'full'}-${projectId}`

// ── Shared safe accessors ────────────────────────────────────────────────────
// localStorage can throw (privacy mode, quota, disabled storage); these swallow
// it so callers never need their own try/catch.

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeLocal(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* ignore */ }
}

// ── JSON accessors ───────────────────────────────────────────────────────────
// Most stored values are JSON. readJSON/writeJSON fold the parse/try-catch and
// the stringify/remove dance into one place so callers stop hand-rolling it.

// Read and JSON-parse a stored value. `validate` refines the parsed value to T —
// return null to reject malformed or unexpected data. Returns null on a missing
// key, a parse error, or a rejected value, so callers never need their own
// try/catch around JSON.parse.
export function readJSON<T>(key: string, validate: (value: unknown) => T | null): T | null {
  const raw = readLocal(key)
  if (raw == null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return validate(parsed)
}

// JSON-stringify and store a value, removing the key when value is null/undefined.
export function writeJSON(key: string, value: unknown): void {
  writeLocal(key, value == null ? null : JSON.stringify(value))
}

// ── Per-id (sharded) TTL stores ──────────────────────────────────────────────
// agentViewPrefs and artifactPrefs each persist one entry per id under a shared
// prefix, every entry stamped with a last-touched timestamp so a single boot-time
// pass can prune everything stale. (A single combined blob is deliberately
// avoided — it would grow unbounded and lose this per-id TTL/prune.) The
// load/save/patch/prune boilerplate is identical between them, so it lives here;
// callers supply the value shape T and keep their own typed wrappers around it.

export interface ShardedStore<T extends object> {
  // The parsed entry (with its `t` stamp), or null if missing, corrupt, or
  // expired. Relevance checks beyond the TTL (e.g. a saved-under status) are the
  // caller's job, done on the returned value.
  load(key: string): (T & { t: number }) | null
  // Overwrite the entry, refreshing its timestamp.
  save(key: string, value: T): void
  // Merge a partial update into the existing entry, refreshing its timestamp.
  // Read-modify-write so independent writers each touch only their own field
  // without clobbering the others.
  patch(key: string, patch: Partial<T>): void
  // Drop expired or corrupt entries under the prefix. Cheap to call once on boot;
  // iterating localStorage is fine given the few keys Hydra writes.
  prune(): void
}

export function createShardedStore<T extends object>(
  prefix: string,
  ttlMs: number,
  // skipPrefix: a longer prefix that shares `prefix` but holds a different shape
  // (no timestamp) and so must be left untouched by prune — e.g. the artifact
  // tag filter, which sits under the artifact prefix.
  opts: { skipPrefix?: string } = {},
): ShardedStore<T> {
  type Stored = T & { t: number }
  const parse = (key: string): Stored | null =>
    readJSON<Stored>(key, (v) =>
      v && typeof v === 'object' && typeof (v as { t?: unknown }).t === 'number' ? (v as Stored) : null,
    )
  const fresh = (s: Stored): boolean => Date.now() - s.t <= ttlMs
  return {
    load(key) {
      const s = parse(key)
      return s && fresh(s) ? s : null
    },
    save(key, value) {
      writeJSON(key, { ...value, t: Date.now() })
    },
    patch(key, patch) {
      // Merge onto whatever is stored (expired or not — the write refreshes `t`).
      const current = parse(key)
      writeJSON(key, { ...current, ...patch, t: Date.now() })
    },
    prune() {
      try {
        const stale: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          if (!k || !k.startsWith(prefix)) continue
          if (opts.skipPrefix && k.startsWith(opts.skipPrefix)) continue
          const s = parse(k)
          if (!s || !fresh(s)) stale.push(k)
        }
        for (const k of stale) localStorage.removeItem(k)
      } catch { /* ignore */ }
    },
  }
}

// ── zustand persist glue for global singletons ───────────────────────────────
// The global preference stores (theme, sidebar, terminal default rows) adopt the
// zustand `persist` middleware so the store owns read-on-init + write-on-set
// instead of each setter hand-rolling a writeLocal. But persist's default
// storage wraps the value in a {state, version} JSON envelope, which would break
// the human-readable keys and the non-React callers that read the same key
// directly (e.g. spawnGeometry → loadDefaultRows reads the raw rows at spawn
// time, outside React). singleFieldStorage bridges the gap: it persists exactly
// ONE field of the store as a raw, unwrapped value, reusing the module's existing
// validated reader/writer. So the storage format is unchanged and persist just
// replaces the manual init/set plumbing.

import type { PersistStorage } from 'zustand/middleware'

// K (the field name) and V (its type) are inferred from the field literal and
// the read/write pair, so callers pass `partialize: (s) => ({ [field]: s[field] })`
// to match the persisted slice.
export function singleFieldStorage<K extends string, V>(
  field: K,
  // Current value, with the module's own default applied when nothing is stored.
  read: () => V,
  // Persist the value (and clear the key per its own null/default rules).
  write: (value: V) => void,
): PersistStorage<{ [P in K]: V }> {
  return {
    // Always returns a state (read() supplies the default), so persist rehydrates
    // the field on boot. version is left unset — there's no envelope to migrate.
    getItem: () => ({ state: { [field]: read() } as { [P in K]: V } }),
    setItem: (_name, value) => write(value.state[field]),
    // The singletons never call persist.clearStorage(); the key's lifecycle is
    // owned by write() (which removes it for a null/default value).
    removeItem: () => {},
  }
}
