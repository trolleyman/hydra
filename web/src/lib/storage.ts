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
  darkModeLegacy: 'hydra-dark-mode', // migrated away from; only read to migrate
  sidebarWidth: 'hydra-sidebar-width',
  defaultAgentType: 'hydra-default-agent-type',
  spawnHeight: 'hydra-sidebar-spawn-height',

  diffSideBySide: 'hydra-diff-side-by-side',
  diffIgnoreWhitespace: 'hydra-diff-ignore-whitespace',
  diffSingleFile: 'hydra-diff-single-file',
  diffFileView: 'hydra-diff-file-view',
  diffSidebarWidth: 'hydra-diff-sidebar-width',
  diffImageMode: 'hydra-diff-image-mode',

  repoWrap: 'hydra-repo-wrap',
  repoIcons: 'hydra-repo-icons',
  repoSidebarWidth: 'hydra-repo-sidebar-width',
} as const

// ── Dynamic keys (prefix + builder pair) ─────────────────────────────────────

// Which agent is selected within a project. One entry per project.
export const SELECTED_AGENT_PREFIX = 'hydra-selected-agent-'
export const selectedAgentKey = (projectId: string): string =>
  `${SELECTED_AGENT_PREFIX}${projectId}`

// Per-artifact view prefs, keyed by project + agent + artifact name (see
// artifactPrefs.ts). projectId may be null → '_' keeps the key shape stable.
export const ARTIFACT_PREFS_PREFIX = 'hydra-artifact-'
export const artifactPrefsKey = (projectId: string | null, agentId: string, name: string): string =>
  `${ARTIFACT_PREFS_PREFIX}${projectId ?? '_'}-${agentId}-${name}`

// Per-agent view prefs (terminal height, page scroll, collapsed diff files) so
// each agent's detail page restores its own layout (see agentViewPrefs.ts).
// projectId may be null → '_' keeps the key shape stable.
export const AGENT_VIEW_PREFS_PREFIX = 'hydra-agent-view-'
export const agentViewPrefsKey = (projectId: string | null, agentId: string): string =>
  `${AGENT_VIEW_PREFS_PREFIX}${projectId ?? '_'}-${agentId}`

// Unsent spawn-prompt draft, per project and per layout (compact vs full).
export const promptDraftKey = (projectId: string, compact: boolean): string =>
  `hydra-prompt-draft-${compact ? 'compact' : 'full'}-${projectId}`

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
