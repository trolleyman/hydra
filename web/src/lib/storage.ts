// Single source of truth for every localStorage key Hydra uses.
//
// Keep keys here rather than as inline string literals so two features can't
// silently collide on the same key, and so the full set is auditable in one
// place. Every key shares the `hydra-` prefix; keys with dynamic segments are
// exposed as builder functions so their prefix lives in exactly one spot.

import { hasDesktopBridge, postDesktopMessage } from './desktopBridge'

const pendingDesktopWrites = new Map<string, string | null>()
let desktopWriteTimer: number | undefined

function flushDesktopWrites(): void {
  if (desktopWriteTimer !== undefined) window.clearTimeout(desktopWriteTimer)
  desktopWriteTimer = undefined
  for (const [key, value] of pendingDesktopWrites) {
    postDesktopMessage({ type: 'browser-storage', key, value })
  }
  pendingDesktopWrites.clear()
}

function persistDesktopWrite(key: string, value: string | null): void {
  if (!hasDesktopBridge()) return
  pendingDesktopWrites.set(key, value)
  if (desktopWriteTimer === undefined) desktopWriteTimer = window.setTimeout(flushDesktopWrites, 150)
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushDesktopWrites)

// ── Static keys ──────────────────────────────────────────────────────────────

export const StorageKeys = {
  projectId: 'hydra-project-id',
  themeMode: 'hydra-theme-mode',
  sidebarWidth: 'hydra-sidebar-width',
  // '1' when the user has collapsed the sidebar (no top bar layout). Only the
  // explicit toggle persists this; the small-screen auto-close on navigation is
  // transient so it doesn't clobber the desktop preference.
  sidebarCollapsed: 'hydra-sidebar-collapsed',
  // The left (working) pane's share of the agent-page split, as a stored float
  // fraction in [0,1] (e.g. '0.4' = 40% terminal / 60% inspector). Global, like
  // sidebarWidth. See AgentDetail / lib/layout.ts.
  agentSplitRatio: 'hydra-agent-split-ratio',
  // Which agent-page pane is collapsed for a focus view: 'none' (the split),
  // 'inspector' (terminal-only) or 'working' (inspector-only). Global, mirrors
  // the sidebar collapse toggle. See lib/layout.ts.
  agentPaneCollapse: 'hydra-agent-pane-collapse',
  defaultAgentType: 'hydra-default-agent-type',
  // Most-recently-visited project ordering (JSON array of project IDs, most
  // recent first). Drives the Ctrl+` alt-tab switcher's order. See
  // lib/projectRecency.ts.
  projectRecency: 'hydra-project-recency',
  // Snapshot of each project's resolved [review] config (JSON map projectId ->
  // ReviewConfigResponse). Hydrated into the project store on boot so the
  // sidebar forge icon and Create MR prefill render instantly, then refreshed
  // from the (slow, shells out to gh/glab) endpoint in the background. Entries
  // for removed projects are pruned when the project list loads. See
  // stores/projectStore.ts.
  reviewConfigs: 'hydra-review-configs',
  // Remembered model per agent type (JSON map, e.g. {"claude":"opus"}). Keyed by
  // agent type because each CLI has its own model aliases; picking a model in the
  // spawn form seeds the next spawn of that same agent type. '' / absent = the
  // CLI's own default.
  defaultModel: 'hydra-default-model',
  // Most-recently selected agent providers (JSON array, most recent first).
  // The model picker keeps the active provider first, then uses this history to
  // place the providers the user returns to most often near the top.
  modelProviderRecency: 'hydra-model-provider-recency',
  // 'true' when the spawn form's structured chat-mode toggle
  // was last on, so the next spawn defaults to the same mode.
  defaultChatMode: 'hydra-default-chat-mode',
  // '1' when the Settings Review section is collapsed (it starts collapsed).
  settingsReviewCollapsed: 'hydra-settings-review-collapsed',
  // '1' when the Settings Resource limits section is collapsed (starts collapsed).
  settingsResourcesCollapsed: 'hydra-settings-resources-collapsed',
  spawnHeight: 'hydra-sidebar-spawn-height',
  // LEGACY, read-only: 'sans' when the user had turned OFF the serif font for
  // chat-mode agent messages, back when that was a boolean toggle. Superseded by
  // fontChat below, which reads this once as its fallback (so an existing
  // sans-chat browser stays sans) and clears it on the first deliberate choice.
  // See lib/fontPrefs.
  chatSerif: 'hydra-chat-serif',
  // The chosen font id (see lib/fonts.ts FONT_OPTIONS) for each of the four
  // roles: the app shell, chat-mode agent prose, code/diffs, and the terminal
  // panes. Absent = that role's default. Client-only, global (localStorage, like
  // Theme). See lib/fontPrefs.
  fontUi: 'hydra-font-ui',
  fontChat: 'hydra-font-chat',
  fontCode: 'hydra-font-code',
  fontTerminal: 'hydra-font-terminal',
  // The size STEP for each role - a signed whole number of pixels from that
  // surface's built-in size ('-1', '2'), not an absolute size. Absent/'0' = the
  // built-in size. Interface moves the whole named type ladder in index.css
  // (--text-xs and friends); the rest move their own surface. See lib/fontPrefs.
  fontSizeUi: 'hydra-font-size-ui',
  fontSizeChat: 'hydra-font-size-chat',
  fontSizeCode: 'hydra-font-size-code',
  fontSizeTerminal: 'hydra-font-size-terminal',
  // '0' when the user turned OFF the paste markers: pasting an attachment
  // (image / large text) into a composer also inserts its "[filename]" at the
  // caret. Absent/'1' = on (the default). See lib/composerPrefs.ts.
  pasteMarkers: 'hydra-paste-markers',
  // '0' when Enter should add a newline in the chat composer, leaving
  // Cmd/Ctrl+Enter as send. Absent/'1' = Enter sends (the default). Shift+Enter
  // always adds a newline. See lib/composerPrefs.ts + AgentChat.
  enterSends: 'hydra-enter-sends',
  // '0' when the user turned OFF auto-pairing in the composers: typing an opener
  // (` ( [ { " ') inserts its closer, Enter on a "```" line opens a fenced
  // block, and a mark typed over a selection wraps it. Absent/'1' = on (the default). See
  // lib/composerPrefs.ts + lib/autoPair.ts.
  autoPair: 'hydra-auto-pair',
  // '1' when the user has turned ON the browser's own spellchecker in Hydra's
  // text boxes (the composers, the review comment boxes, the commit message, the
  // question card's free-text answers). Absent = off, the default. See
  // lib/composerPrefs.ts.
  spellcheck: 'hydra-spellcheck',
  // 'off' when the user has turned OFF smooth (paced) streaming of chat-mode agent
  // text. Default (absent) = on: incoming token bursts are revealed at a steady
  // per-frame rate so the text reads as continuous typing rather than landing in
  // ~quarter-second chunks (the claude CLI flushes deltas ~5x/sec). Client-only,
  // global (localStorage, like Theme). See lib/chatPrefs.
  chatSmoothStreaming: 'hydra-chat-smooth-streaming',
  // Opt-in feature flag for easing coarse desktop mouse-wheel input in the chat
  // transcript. Absent = off, so normal browser scrolling remains the baseline.
  // See lib/featureFlags.ts + AgentChat.
  featureSmoothChatWheel: 'hydra-feature-smooth-chat-wheel',
  // Opt-in feature flag for Hydra's thin, button-less scrollbar styling.
  // Absent = off, leaving every non-terminal scroll container to the browser/OS.
  // See lib/featureFlags.ts + index.css.
  featureCustomScrollbars: 'hydra-feature-custom-scrollbars',
  // 'off' when the user has turned OFF the line-number gutter on multi-line code
  // blocks - the chat transcript (a Bash command, a tool's JSON input) and the
  // security approval card's command box. Default (absent) = on: the numbers tell
  // a wrapped long line apart from a genuinely new one. Client-only, global
  // (localStorage, like Theme). See lib/chatPrefs.
  chatCodeLineNumbers: 'hydra-chat-code-line-numbers',
  // Which whitespace the code surfaces (diff viewer, repository browser, the
  // chat's file cards) draw a mark on: 'boundary' (the indent and any trailing
  // spaces) or 'all'. Absent = off, the default. Client-only, global
  // (localStorage, like Theme). See lib/whitespacePrefs + lib/whitespaceMarks.
  codeWhitespace: 'hydra-code-whitespace',
  // Spaces the shell-command formatter indents a block body by when it lays a
  // one-line for/while/if/case out over several lines - in the chat transcript
  // and on the security approval card. A bare number ('0' = flush left); absent
  // = the built-in 4. Client-only, global (localStorage, like Theme). See
  // lib/chatPrefs + lib/bashFormat.
  chatBashIndent: 'hydra-chat-bash-indent',
  // 'off' when the user has turned OFF step folding in the chat transcript.
  // Default (absent) = on: a run of settled thoughts + tool calls collapses into
  // one "N steps" line you can expand, so what the agent SAID stands out from
  // the machinery it used getting there. Client-only, global (localStorage, like
  // Theme). See lib/chatPrefs.
  chatStepGroups: 'hydra-chat-step-groups',
  // '1' when the user has opted in to desktop (browser) notifications for agent
  // transitions (needs_input / approval / finished) that happen while this tab is
  // backgrounded or unfocused. Absent = off (the default; enabling requires an
  // explicit user gesture so the OS permission prompt has one). See lib/notifyPrefs.
  desktopNotifications: 'hydra-desktop-notifications',
  // '0' when closing the final native window should also stop a desktop-owned
  // backend. Absent = keep it running, matching an installed desktop app.
  desktopKeepRunning: 'hydra-desktop-keep-running',

  diffSideBySide: 'hydra-diff-side-by-side',
  diffIgnoreWhitespace: 'hydra-diff-ignore-whitespace',
  // Whether to tint the exact changed words within a modified line (default on).
  diffWordHighlight: 'hydra-diff-word-highlight',
  diffSingleFile: 'hydra-diff-single-file',
  diffFileView: 'hydra-diff-file-view',
  diffSidebarWidth: 'hydra-diff-sidebar-width',
  // Whether the diff's file-list column is hidden (the Files header's toggle).
  diffFilesListHidden: 'hydra-diff-files-list-hidden',
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
  // User-chosen default height (pixels) a chat window opens at, set on the user
  // settings page. Chat panes have no character grid, so their height is a raw
  // pixel value rather than rows - and is kept separate from the terminal default
  // so chat windows and terminal windows can open at different sizes (see
  // lib/chatPrefs + AgentTerminal).
  chatDefaultHeight: 'hydra-chat-default-height',

  repoWrap: 'hydra-repo-wrap',
  repoIcons: 'hydra-repo-icons',
  repoSidebarWidth: 'hydra-repo-sidebar-width',
  // Repository branch-compare diff: show one file at a time (default) vs all
  // files stacked. Absent = the one-file default; 'false' = the multi-file view.
  repoDiffSingleFile: 'hydra-repo-diff-single-file',
  // Repository branch-compare diff: how the changed-files sidebar is laid out -
  // 'tree' (default, folders), 'flat', or 'grouped'. Mirrors the agent diff
  // viewer's own file-view setting, but kept under a separate key so the two
  // views can be configured independently.
  repoDiffFileView: 'hydra-repo-diff-file-view',

  // 'false' when the user has turned OFF soft wrapping in the lightbox's text
  // viewer (a long line then scrolls the pane sideways, under a sticky
  // line-number gutter). Absent = on, the default: a lightbox is opened to READ
  // a file, and a log line running off the right edge is the one thing that
  // stops. Kept separate from repoWrap - the repository browser is a different
  // surface with its own habit. See LightboxViewers.
  lightboxWrap: 'hydra-lightbox-wrap',
  // 'false' when the user has switched the lightbox's markdown viewer to the
  // file's source instead of the rendered document. Absent = rendered, the
  // default. See LightboxViewers.
  lightboxMarkdownRendered: 'hydra-lightbox-markdown-rendered',

  // '1' when a test/screenshot harness wants to drive the toast store from page
  // context (see lib/toastHarness). Dormant unless explicitly set - only the
  // screenshot script seeds it (via addInitScript), never the app itself - so it
  // has no effect in real builds.
  toastHarness: 'hydra-toast-harness',
} as const

// ── Dynamic keys (prefix + builder pair) ─────────────────────────────────────

// Which view is last open within a project - an agent, the repository browser,
// or the bare project page. One entry per project. See lib/projectView.ts.
export const PROJECT_VIEW_PREFIX = 'hydra-project-view-'
export const projectViewKey = (projectId: string): string =>
  `${PROJECT_VIEW_PREFIX}${projectId}`

// Last-seen live agent list, one entry per project, so switching into a project
// paints its sidebar (and a restored agent page) from cache instead of showing
// the *previous* project's agents until the list request lands. Replaced by the
// first real response. See lib/agentCache.ts.
export const AGENTS_CACHE_PREFIX = 'hydra-agents-'
export const agentsCacheKey = (projectId: string): string =>
  `${AGENTS_CACHE_PREFIX}${projectId}`

// Last-seen branch list, one entry per project, so every branch selector (the
// agent header's base picker, the repository view's branch/compare pickers, the
// spawn options popover) paints as a real dropdown on the first frame instead of
// popping in when `git branch` lands. Replaced by the first real response. See
// lib/branchCache.ts.
export const BRANCHES_CACHE_PREFIX = 'hydra-branches-'
export const branchesCacheKey = (projectId: string): string =>
  `${BRANCHES_CACHE_PREFIX}${projectId}`

// Per-artifact view prefs, keyed by project + agent + artifact name (see
// artifactPrefs.ts). projectId may be null → '_' keeps the key shape stable.
export const ARTIFACT_PREFS_PREFIX = 'hydra-artifact-'
export const artifactPrefsKey = (projectId: string | null, agentId: string, name: string): string =>
  `${ARTIFACT_PREFS_PREFIX}${projectId ?? '_'}-${agentId}-${name}`

// Artifact tag filter, keyed by project + agent (one selection shared across all
// of an agent's artifact cards - see artifactPrefs.ts loadTagFilter/saveTagFilter).
// projectId may be null → '_' keeps the key shape stable. The `-v2-` version: the
// stored arrays used to list the *selected* (shown) values; they now list the
// values turned *off* (hidden), so the bump discards the old, now-inverted data.
export const ARTIFACT_TAG_FILTER_PREFIX = 'hydra-artifact-tagfilter-v2-'
export const artifactTagFilterKey = (projectId: string | null, agentId: string): string =>
  `${ARTIFACT_TAG_FILTER_PREFIX}${projectId ?? '_'}-${agentId}`

// Artifact "chrome" cache - the script names + available tags of a comparison,
// remembered client-side so the artifacts panel can render its header, tag filter
// and collapsed card headers instantly (no network) while the real comparison
// loads (see artifactPrefs.ts load/saveArtifactChrome). Two levels, both
// zero-network: per agent (the branch), and a per-project last-resort fallback
// (artifact config is project-wide, so a brand-new agent can borrow a sibling's
// chrome). Entries carry a `t` stamp, so the artifact-prefs prune below - which
// sweeps this same `hydra-artifact-` prefix - drops stale ones too. projectId may
// be null → '_' keeps the key shape stable.
export const ARTIFACT_CHROME_PREFIX = 'hydra-artifact-chrome-'
export const artifactChromeKey = (projectId: string | null, agentId: string): string =>
  `${ARTIFACT_CHROME_PREFIX}a-${projectId ?? '_'}-${agentId}`
export const artifactChromeProjectKey = (projectId: string | null): string =>
  `${ARTIFACT_CHROME_PREFIX}p-${projectId ?? '_'}`

// Test status filter, keyed by project + agent (one selection shared across all
// of an agent's test-runner cards - see testFilterPrefs.ts). Mirrors the artifact
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

// In-progress (not yet "Add to review"ed) line-comment drafts, one entry per
// project + agent holding a map of line-key -> the half-written text. This is the
// only half of a review that is still local: once a comment is queued it becomes
// a numbered server-side object (lib/reviewComments.ts), but the text you are
// mid-sentence on is keystroke-frequency and belongs to nobody but this browser.
// See lib/reviewDrafts.ts. projectId may be null -> '_'.
export const LINE_DRAFT_PREFIX = 'hydra-line-draft-'
export const lineDraftKey = (projectId: string | null, agentId: string): string =>
  `${LINE_DRAFT_PREFIX}${projectId ?? '_'}-${agentId}`

// In-progress replies to a FORGE review thread (docs/review-threads.md), one
// entry per project + agent holding a map of thread-id -> the half-written text.
// Same lifecycle as LINE_DRAFT, kept separate so a reply the user is part-way
// through survives scrolling the thread out of view or reloading, and so the two
// prune independently. projectId may be null -> '_'.
export const THREAD_DRAFT_PREFIX = 'hydra-thread-draft-'
export const threadDraftKey = (projectId: string | null, agentId: string): string =>
  `${THREAD_DRAFT_PREFIX}${projectId ?? '_'}-${agentId}`

// Whether the sidebar's "Archived" section is collapsed, per project. Absent =
// collapsed (the default - archived history is rarely wanted, so it stays out of
// the way); '0' = the user explicitly expanded it. (Legacy '1' values from when
// collapsed was the non-default still read as collapsed.) Per-project so one
// project's choice doesn't leak into another's.
export const ARCHIVED_COLLAPSED_PREFIX = 'hydra-archived-collapsed-'
export const archivedCollapsedKey = (projectId: string): string =>
  `${ARCHIVED_COLLAPSED_PREFIX}${projectId}`

// Running count of generically-named pasted images (image1.png, ...) for a
// chat composer, per project + agent - mirrors the spawn form's imageCounterKey
// so chat-pasted images get stable image<N>.png names across reloads.
export const chatImageCounterKey = (projectId: string | null, agentId: string): string =>
  `hydra-chat-image-counter-${projectId ?? '_'}-${agentId}`

// Unsent spawn-prompt draft, per project and per layout (compact vs full).
export const promptDraftKey = (projectId: string, compact: boolean): string =>
  `hydra-prompt-draft-${compact ? 'compact' : 'full'}-${projectId}`

// Scroll offset (textarea scrollTop) of the spawn-prompt box, per project and
// per layout - mirrors promptDraftKey so a long draft restores to the same
// scroll position when switching back to its project.
export const promptScrollKey = (projectId: string, compact: boolean): string =>
  `hydra-prompt-scroll-${compact ? 'compact' : 'full'}-${projectId}`

// Running count of generically-named pasted images (image1.png, image2.png, ...)
// for the spawn form, per project and per layout - mirrors promptDraftKey so the
// numbering stays separate across projects and survives a reload.
export const imageCounterKey = (projectId: string, compact: boolean): string =>
  `hydra-image-counter-${compact ? 'compact' : 'full'}-${projectId}`

// The settled uploads attached to that draft, stored as their on-disk paths -
// the half of an attachment that outlives the page (see lib/draftAttachments).
// Mirrors promptDraftKey so a box's text and its attachments come back together.
export const spawnAttachmentsKey = (projectId: string, compact: boolean): string =>
  `hydra-prompt-attachments-${compact ? 'compact' : 'full'}-${projectId}`

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
    persistDesktopWrite(key, value)
  } catch { /* ignore */ }
}

// ── JSON accessors ───────────────────────────────────────────────────────────
// Most stored values are JSON. readJSON/writeJSON fold the parse/try-catch and
// the stringify/remove dance into one place so callers stop hand-rolling it.

// Read and JSON-parse a stored value. `validate` refines the parsed value to T -
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
// avoided - it would grow unbounded and lose this per-id TTL/prune.) The
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
  // (no timestamp) and so must be left untouched by prune - e.g. the artifact
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
      // Merge onto whatever is stored (expired or not - the write refreshes `t`).
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
        for (const k of stale) writeLocal(k, null)
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
    // the field on boot. version is left unset - there's no envelope to migrate.
    getItem: () => ({ state: { [field]: read() } as { [P in K]: V } }),
    setItem: (_name, value) => write(value.state[field]),
    // The singletons never call persist.clearStorage(); the key's lifecycle is
    // owned by write() (which removes it for a null/default value).
    removeItem: () => {},
  }
}
