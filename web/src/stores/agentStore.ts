import { create } from 'zustand'
import type { AgentResponse } from '../api'

interface AgentState {
  agents: AgentResponse[]
  loading: boolean
  error: string | null
  setAgents: (agents: AgentResponse[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  addAgent: (agent: AgentResponse) => void
  removeAgent: (id: string) => void
  updateAgent: (agent: AgentResponse) => void
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],
  loading: true,
  error: null,
  setAgents: (agents) => set({ agents, loading: false, error: null }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  addAgent: (agent) => set((state) => ({
    agents: state.agents.some((a) => a.id === agent.id) ? state.agents : [agent, ...state.agents]
  })),
  removeAgent: (id) => set((state) => ({
    agents: state.agents.filter((a) => a.id !== id)
  })),
  updateAgent: (agent) => set((state) => ({
    agents: state.agents.map((a) => a.id === agent.id ? agent : a)
  })),
}))
