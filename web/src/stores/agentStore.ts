import { create } from 'zustand'
import type { AgentResponse } from '../api'
import { AgentStatus } from '../api'
import { useToastStore } from './toastStore'

// Default lifetime of an optimistic status override. Comfortably longer than
// the agent-list poll interval (5s) plus the hook → status-poller latency, so
// the override bridges the gap until the backend confirms the real status
// without the badge flickering back on an intervening poll.
const OPTIMISTIC_TTL_MS = 8_000

// Lifetime of an optimistic "marked read" override. Same reasoning as the status
// TTL: it bridges the gap until a poll confirms the backend has cleared the
// unread flag, so opening an agent dismisses its unread dot instantly without it
// flickering back on the next poll.
const READ_TTL_MS = 8_000

// Lifetime of an optimistic "marked unread" override. Mirror of READ_TTL_MS: it
// bridges the gap until a poll confirms the backend has raised the unread flag,
// so the "mark as unread" command lights the dot instantly without it flickering
// back off on an intervening poll.
const UNREAD_TTL_MS = 8_000

interface OptimisticOverride {
  status: AgentStatus
  until: number
}

// Page size for the archived-history infinite-scroll list.
export const ARCHIVED_PAGE_SIZE = 20

interface AgentState {
  agents: AgentResponse[]
  // Project the current live `agents` list belongs to. Tracked so setAgents can
  // tell a same-project refresh (where a vanished agent means it finished) apart
  // from a project switch (where the whole list is replaced wholesale).
  agentsProjectId: string | null
  loading: boolean
  error: string | null
  // Archived (killed/merged) history, loaded lazily in pages as the user scrolls
  // the sidebar. Distinct from `agents`, which is the live (polled) list.
  archived: AgentResponse[]
  archivedLoading: boolean
  // True while there may be more archived pages to fetch (last page was full).
  archivedHasMore: boolean
  // Per-agent optimistic status overrides keyed by agent id, each with a wall-
  // clock expiry. Applied on top of polled data in setAgents so a locally-known
  // status change (e.g. a just-submitted prompt) shows instantly.
  optimistic: Record<string, OptimisticOverride>
  // Per-agent optimistic "read" expiries keyed by agent id. While active, the
  // agent's has_unread_changes is forced false on top of polled data so the
  // unread dot clears instantly on open.
  readUntil: Record<string, number>
  // Per-agent optimistic "unread" expiries keyed by agent id. While active, the
  // agent's has_unread_changes is forced true on top of polled data so the
  // unread dot lights instantly when the user marks the agent unread.
  unreadUntil: Record<string, number>
  // Replace the live agent list. Pass the project the list belongs to so a
  // background merge completing (an armed agent that vanishes on a same-project
  // refresh) can be detected and toasted; omit it to skip that detection.
  setAgents: (agents: AgentResponse[], projectId?: string | null) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  addAgent: (agent: AgentResponse) => void
  removeAgent: (id: string) => void
  updateAgent: (agent: AgentResponse) => void
  // Reset the archived list (e.g. on project switch).
  resetArchived: () => void
  setArchivedLoading: (loading: boolean) => void
  // Replace the archived list with the first page.
  setArchivedFirstPage: (page: AgentResponse[]) => void
  // Append a fetched page of archived agents, de-duplicating by id.
  appendArchived: (page: AgentResponse[]) => void
  // Insert/replace a single archived agent (e.g. fetched on a cold page load, or
  // optimistically when a live agent is just killed/merged). New entries are
  // placed in created-at order (newest first), matching the list's ordering — a
  // just-killed *old* agent therefore slots in by its creation date, not the top.
  upsertArchived: (agent: AgentResponse) => void
  // Remove an archived agent from the history list (e.g. after it is permanently
  // deleted / purged).
  removeArchived: (id: string) => void
  // Optimistically pin an agent's status for a short window. ttlMs defaults to
  // OPTIMISTIC_TTL_MS.
  setOptimisticStatus: (id: string, status: AgentStatus, ttlMs?: number) => void
  // Optimistically clear an agent's unread dot for a short window (paired with a
  // markAgentRead API call by the caller).
  markRead: (id: string) => void
  // Optimistically light an agent's unread dot for a short window (paired with a
  // markAgentUnread API call by the caller).
  markUnread: (id: string) => void
}

// applyOverrides overlays one family of optimistic overrides onto a fresh agent
// list. The three families (status, marked-read, marked-unread) share the exact
// same shape — keep an override only while it hasn't expired AND the backend
// hasn't already caught up to it; drop it otherwise; rewrite the matching agent
// while it's live — and differ only in three callbacks:
//   - expiry(o): the override's wall-clock expiry (`o.until`, or the bare number)
//   - settled(agent, o): true once the backend already reports the override's
//     outcome, so the override has served its purpose and can be dropped
//   - rewrite(agent, o): the agent with the optimistic value forced on
// It returns the merged agents plus the surviving (non-expired, non-settled)
// overrides so the caller can persist a pruned map.
function applyOverrides<O>(
  agents: AgentResponse[],
  overrides: Record<string, O>,
  expiry: (o: O) => number,
  settled: (agent: AgentResponse, o: O) => boolean,
  rewrite: (agent: AgentResponse, o: O) => AgentResponse,
): { agents: AgentResponse[]; overrides: Record<string, O> } {
  const now = Date.now()
  const next: Record<string, O> = {}
  const merged = agents.map((a) => {
    const o = overrides[a.id]
    if (o === undefined || expiry(o) <= now) return a
    if (settled(a, o)) return a
    next[a.id] = o
    return rewrite(a, o)
  })
  return { agents: merged, overrides: next }
}

// notifyBackgroundMerges fires a "merged" toast for each agent that was armed for
// auto-merge (merge_when_green) on the previous list and has since left the live
// list — i.e. the daemon merged it in the background once its tests went green.
// Only call this for a same-project refresh; on a project switch the old agents
// also "vanish" but haven't merged. The synchronous merge path removes the agent
// via removeAgent (not setAgents) and shows its own toast, so it won't fire here.
function notifyBackgroundMerges(prev: AgentResponse[], next: AgentResponse[], projectId: string) {
  if (prev.length === 0) return
  const nextIds = new Set(next.map((a) => a.id))
  for (const agent of prev) {
    if (agent.merge_when_green && !nextIds.has(agent.id)) {
      const name = agent.title || agent.id
      const toBranch = agent.base_branch || 'its base branch'
      useToastStore.getState().show({
        message: `Agent "${name}" merged into ${toBranch}`,
        type: 'success',
        // Rendered as the agent-transition card (matching the status-update
        // toasts); the message is only the fallback for non-card surfaces.
        agentTransition: { agentName: name, agentId: agent.id, projectId, status: 'merged', before: '', after: `into ${toBranch}` },
      })
    }
  }
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],
  agentsProjectId: null,
  loading: true,
  error: null,
  archived: [],
  archivedLoading: false,
  archivedHasMore: true,
  optimistic: {},
  readUntil: {},
  unreadUntil: {},
  setAgents: (agents, projectId) => set((state) => {
    // Detect background merges before applying overrides: an armed agent that has
    // left the list on a same-project refresh was merged by the daemon. Skip on a
    // project switch (projectId differs), which also drops the previous agents.
    if (projectId != null && projectId === state.agentsProjectId) {
      notifyBackgroundMerges(state.agents, agents, projectId)
    }
    // Status: drop the override once the backend reports the optimistic status —
    // or the moment it reports needs_input. needs_input is the explicit "the
    // agent is blocked on you" signal, so it must never stay masked behind a
    // stale optimistic "running" (e.g. the agent asked a follow-up question right
    // after the user submitted input).
    const opt = applyOverrides(
      agents, state.optimistic,
      (o) => o.until,
      (a, o) => a.agent_status?.status === o.status || a.agent_status?.status === AgentStatus.NEEDS_INPUT,
      (a, o) => ({ ...a, agent_status: { ...(a.agent_status ?? { status: o.status, timestamp: '' }), status: o.status } }),
    )
    // Marked read: force the flag off until the backend reports it cleared.
    const rd = applyOverrides(
      opt.agents, state.readUntil,
      (until) => until,
      (a) => !a.has_unread_changes,
      (a) => ({ ...a, has_unread_changes: false }),
    )
    // Marked unread: force the flag on until the backend reports it raised.
    const ur = applyOverrides(
      rd.agents, state.unreadUntil,
      (until) => until,
      (a) => !!a.has_unread_changes,
      (a) => ({ ...a, has_unread_changes: true }),
    )
    return {
      agents: ur.agents,
      agentsProjectId: projectId === undefined ? state.agentsProjectId : projectId,
      optimistic: opt.overrides,
      readUntil: rd.overrides,
      unreadUntil: ur.overrides,
      loading: false,
      error: null,
    }
  }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  addAgent: (agent) => set((state) => ({
    agents: state.agents.some((a) => a.id === agent.id) ? state.agents : [agent, ...state.agents]
  })),
  removeAgent: (id) => set((state) => ({
    agents: state.agents.filter((a) => a.id !== id),
    optimistic: Object.fromEntries(Object.entries(state.optimistic).filter(([k]) => k !== id)),
    readUntil: Object.fromEntries(Object.entries(state.readUntil).filter(([k]) => k !== id)),
    unreadUntil: Object.fromEntries(Object.entries(state.unreadUntil).filter(([k]) => k !== id)),
  })),
  updateAgent: (agent) => set((state) => ({
    agents: state.agents.map((a) => a.id === agent.id ? agent : a)
  })),
  resetArchived: () => set({ archived: [], archivedHasMore: true, archivedLoading: false }),
  setArchivedLoading: (loading) => set({ archivedLoading: loading }),
  setArchivedFirstPage: (page) => set({
    archived: page,
    archivedHasMore: page.length >= ARCHIVED_PAGE_SIZE,
    archivedLoading: false,
  }),
  appendArchived: (page) => set((state) => {
    const seen = new Set(state.archived.map((a) => a.id))
    const fresh = page.filter((a) => !seen.has(a.id))
    return {
      archived: [...state.archived, ...fresh],
      archivedHasMore: page.length >= ARCHIVED_PAGE_SIZE,
      archivedLoading: false,
    }
  }),
  upsertArchived: (agent) => set((state) => {
    if (state.archived.some((a) => a.id === agent.id)) {
      return { archived: state.archived.map((a) => (a.id === agent.id ? agent : a)) }
    }
    // Insert in created-at order (newest first), tie-breaking by id to match the
    // backend's stable ordering, so an optimistically-archived agent lands in the
    // same slot the server would place it on the next fetch.
    const next = [...state.archived]
    const at = agent.created_at ?? 0
    let i = next.findIndex((a) => {
      const t = a.created_at ?? 0
      return t < at || (t === at && a.id > agent.id)
    })
    if (i < 0) i = next.length
    next.splice(i, 0, agent)
    return { archived: next }
  }),
  removeArchived: (id) => set((state) => ({
    archived: state.archived.filter((a) => a.id !== id),
  })),
  setOptimisticStatus: (id: string, status: AgentStatus, ttlMs = OPTIMISTIC_TTL_MS) => set((state) => {
    const override: OptimisticOverride = { status, until: Date.now() + ttlMs }
    return {
      optimistic: { ...state.optimistic, [id]: override },
      agents: state.agents.map((a) => {
        if (a.id !== id) return a
        // Don't clobber a backend status that already matches.
        if (a.agent_status?.status === status) return a
        const base = a.agent_status ?? { status, timestamp: '' }
        return { ...a, agent_status: { ...base, status } }
      }),
    }
  }),
  markRead: (id: string) => set((state) => ({
    readUntil: { ...state.readUntil, [id]: Date.now() + READ_TTL_MS },
    // Drop any opposing "unread" override so it can't force the dot back on.
    unreadUntil: Object.fromEntries(Object.entries(state.unreadUntil).filter(([k]) => k !== id)),
    agents: state.agents.map((a) => (a.id === id ? { ...a, has_unread_changes: false } : a)),
  })),
  markUnread: (id: string) => set((state) => ({
    unreadUntil: { ...state.unreadUntil, [id]: Date.now() + UNREAD_TTL_MS },
    // Drop any opposing "read" override so it can't force the dot back off.
    readUntil: Object.fromEntries(Object.entries(state.readUntil).filter(([k]) => k !== id)),
    agents: state.agents.map((a) => (a.id === id ? { ...a, has_unread_changes: true } : a)),
  })),
}))
