import { create } from 'zustand'
import type { AgentResponse } from '../api'
import { AgentStatus } from '../api'

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

interface OptimisticOverride {
  status: AgentStatus
  until: number
}

interface AgentState {
  agents: AgentResponse[]
  loading: boolean
  error: string | null
  // Per-agent optimistic status overrides keyed by agent id, each with a wall-
  // clock expiry. Applied on top of polled data in setAgents so a locally-known
  // status change (e.g. a just-submitted prompt) shows instantly.
  optimistic: Record<string, OptimisticOverride>
  // Per-agent optimistic "read" expiries keyed by agent id. While active, the
  // agent's has_unread_changes is forced false on top of polled data so the
  // unread dot clears instantly on open.
  readUntil: Record<string, number>
  setAgents: (agents: AgentResponse[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  addAgent: (agent: AgentResponse) => void
  removeAgent: (id: string) => void
  updateAgent: (agent: AgentResponse) => void
  // Optimistically pin an agent's status for a short window. ttlMs defaults to
  // OPTIMISTIC_TTL_MS.
  setOptimisticStatus: (id: string, status: AgentStatus, ttlMs?: number) => void
  // Optimistically clear an agent's unread dot for a short window (paired with a
  // markAgentRead API call by the caller).
  markRead: (id: string) => void
}

// applyOptimistic overlays the still-active overrides onto a fresh agent list,
// dropping overrides that have expired or that the backend has already caught
// up to (its reported status matches the override).
function applyOptimistic(
  agents: AgentResponse[],
  optimistic: Record<string, OptimisticOverride>,
): { agents: AgentResponse[]; optimistic: Record<string, OptimisticOverride> } {
  const now = Date.now()
  const next: Record<string, OptimisticOverride> = {}
  const merged = agents.map((a) => {
    const o = optimistic[a.id]
    if (!o || o.until <= now) return a
    // Backend already reports the optimistic status — the override served its
    // purpose, so drop it and use the real (authoritative) data.
    if (a.agent_status?.status === o.status) return a
    next[a.id] = o
    const base = a.agent_status ?? { status: o.status, timestamp: '' }
    return { ...a, agent_status: { ...base, status: o.status } }
  })
  return { agents: merged, optimistic: next }
}

// applyReadOverrides forces has_unread_changes false on agents with an active
// "marked read" override, dropping overrides that have expired or that the
// backend has already caught up to (it already reports the agent as read).
function applyReadOverrides(
  agents: AgentResponse[],
  readUntil: Record<string, number>,
): { agents: AgentResponse[]; readUntil: Record<string, number> } {
  const now = Date.now()
  const next: Record<string, number> = {}
  const merged = agents.map((a) => {
    const until = readUntil[a.id]
    if (!until || until <= now) return a
    // Backend already cleared the flag — the override served its purpose.
    if (!a.has_unread_changes) return a
    next[a.id] = until
    return { ...a, has_unread_changes: false }
  })
  return { agents: merged, readUntil: next }
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],
  loading: true,
  error: null,
  optimistic: {},
  readUntil: {},
  setAgents: (agents) => set((state) => {
    const opt = applyOptimistic(agents, state.optimistic)
    const rd = applyReadOverrides(opt.agents, state.readUntil)
    return { agents: rd.agents, optimistic: opt.optimistic, readUntil: rd.readUntil, loading: false, error: null }
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
  })),
  updateAgent: (agent) => set((state) => ({
    agents: state.agents.map((a) => a.id === agent.id ? agent : a)
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
    agents: state.agents.map((a) => (a.id === id ? { ...a, has_unread_changes: false } : a)),
  })),
}))
