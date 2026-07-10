// Per-agent view preferences persisted to localStorage, keyed by project +
// agent, so an agent's detail page restores its own layout on reload and when
// switching between agents - treating each agent like its own page. We persist:
//   - terminalHeight: the height the user dragged the terminal panel to.
//   - scrollTop: the scroll position of the agent detail page.
//   - collapsedFiles: which files are collapsed in the diff viewer.
//
//   - bashTabs: the extra bash shell tabs open in the terminal panel (each with
//     its sandboxed/host flag), plus activeTabId, so each agent keeps its own
//     set of shells when you switch away and back.
//
// These live in a single entry per agent (rather than separate keys) so the
// store stays compact and a single TTL prune drops everything for a stale
// agent at once. Entries untouched for AGENT_VIEW_TTL_MS are pruned on boot.

import { agentViewPrefsKey, AGENT_VIEW_PREFS_PREFIX, createShardedStore } from './storage'

// A persisted bash shell tab. `id` doubles as the backend shell_id, so on
// restore the pane reconnects to the same session if it's still alive.
export type BashTabPref = {
  id: string
  label: string
  sandboxed: boolean
}

export type AgentViewPrefs = {
  terminalHeight?: number
  scrollTop?: number
  collapsedFiles?: string[]
  bashTabs?: BashTabPref[]
  activeTabId?: string
  // Tests-panel view modes (the two orthogonal cog checkboxes, both off by
  // default): group cases into per-status sections, and group the tree by
  // logical scope (class/describe chain) instead of filesystem path.
  testGroupResult?: boolean
  testUseScope?: boolean
  // Tests-panel expansion state, so a card the user opened (and the tree nodes
  // they collapsed inside it) restore on return to the agent page. Keyed by
  // runner name: testCardCollapsed maps name → whether the whole card is
  // collapsed (absent → the default-collapsed card); testTreeCollapsed maps
  // name → the collapsed tree-node keys within that runner's case tree.
  testCardCollapsed?: Record<string, boolean>
  testTreeCollapsed?: Record<string, string[]>
  // Chat-pane transcript scroll offset, saved only while the user has scrolled
  // AWAY from the bottom (a pinned-to-bottom chat just re-pins on return).
  chatScrollTop?: number
  // Chat composer minimum height, in whole rows (the drag bar's setting).
  chatComposerRows?: number
  // Unsent chat composer text, so a draft survives switching agents and reloads
  // (item 30). Attachments travel alongside in an in-memory cache (chatDrafts).
  chatDraft?: string
  // Split layout: whether the working pane's prompt disclosure is collapsed.
  promptCollapsed?: boolean
}

const AGENT_VIEW_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

// The shared sharded-store machinery handles the JSON/TTL/prune boilerplate; this
// module just supplies the value shape and its typed wrappers (see storage.ts).
const store = createShardedStore<AgentViewPrefs>(AGENT_VIEW_PREFS_PREFIX, AGENT_VIEW_TTL_MS)

// Load the saved view prefs for an agent. Returns an empty object when nothing
// is stored or the entry has expired (→ callers fall back to their defaults).
export function loadAgentViewPrefs(projectId: string | null, agentId: string): AgentViewPrefs {
  const stored = store.load(agentViewPrefsKey(projectId, agentId))
  if (!stored) return {}
  return {
    terminalHeight: stored.terminalHeight,
    scrollTop: stored.scrollTop,
    collapsedFiles: stored.collapsedFiles,
    bashTabs: stored.bashTabs,
    activeTabId: stored.activeTabId,
    testGroupResult: stored.testGroupResult,
    testUseScope: stored.testUseScope,
    testCardCollapsed: stored.testCardCollapsed,
    testTreeCollapsed: stored.testTreeCollapsed,
    chatScrollTop: stored.chatScrollTop,
    chatComposerRows: stored.chatComposerRows,
    chatDraft: stored.chatDraft,
    promptCollapsed: stored.promptCollapsed,
  }
}

// Merge a partial update into an agent's stored prefs, refreshing the TTL.
// Read-modify-write so the three independent writers (terminal, page scroll,
// diff viewer) each update only their own field without clobbering the others.
export function patchAgentViewPrefs(
  projectId: string | null,
  agentId: string,
  patch: Partial<AgentViewPrefs>,
): void {
  store.patch(agentViewPrefsKey(projectId, agentId), patch)
}

// Drop expired agent-view-pref entries. Cheap to call once on app boot.
export function pruneAgentViewPrefs(): void {
  store.prune()
}
