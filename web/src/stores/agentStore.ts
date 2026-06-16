import { create } from 'zustand'
import type { AgentResponse } from '../api'
import { AgentStatus } from '../api'

// Default lifetime of an optimistic status override. Comfortably longer than
// the agent-list poll interval (5s) plus the hook → status-poller latency, so
// the override bridges the gap until the backend confirms the real status
// without the badge flickering back on an intervening poll.
const OPTIMISTIC_TTL_MS = 8_000

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
  setAgents: (agents: AgentResponse[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  addAgent: (agent: AgentResponse) => void
  removeAgent: (id: string) => void
  updateAgent: (agent: AgentResponse) => void
  // Optimistically pin an agent's status for a short window. ttlMs defaults to
  // OPTIMISTIC_TTL_MS.
  setOptimisticStatus: (id: string, status: AgentStatus, ttlMs?: number) => void
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

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],
  loading: true,
  error: null,
  optimistic: {},
  setAgents: (agents) => set((state) => {
    const { agents: merged, optimistic } = applyOptimistic(agents, state.optimistic)
    return { agents: merged, optimistic, loading: false, error: null }
  }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  addAgent: (agent) => set((state) => ({
    agents: state.agents.some((a) => a.id === agent.id) ? state.agents : [agent, ...state.agents]
  })),
  removeAgent: (id) => set((state) => ({
    agents: state.agents.filter((a) => a.id !== id),
    optimistic: Object.fromEntries(Object.entries(state.optimistic).filter(([k]) => k !== id)),
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
}))
