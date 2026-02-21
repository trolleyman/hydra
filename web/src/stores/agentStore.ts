import { create } from 'zustand';
import type { Agent, CreateAgentRequest } from '../api';
import { api } from './apiClient';

interface AgentState {
  agents: Record<string, Agent[]>; // projectId -> agents
  loading: boolean;
  error: string | null;
  fetchAgents: (projectId: string) => Promise<void>;
  createAgent: (projectId: string, req: CreateAgentRequest) => Promise<Agent>;
  deleteAgent: (projectId: string, agentId: string) => Promise<void>;
  mergeAgent: (projectId: string, agentId: string) => Promise<Agent>;
  updateAgent: (agent: Agent) => void;
}

export const useAgentStore = create<AgentState>()((set) => ({
  agents: {},
  loading: false,
  error: null,

  fetchAgents: async (projectId: string) => {
    set({ loading: true, error: null });
    try {
      const agents = await api.default.listAgents(projectId);
      set((state) => ({
        agents: { ...state.agents, [projectId]: agents },
        loading: false,
      }));
    } catch (e: unknown) {
      set({ error: String(e), loading: false });
    }
  },

  createAgent: async (projectId: string, req: CreateAgentRequest) => {
    const agent = await api.default.createAgent(projectId, req);
    set((state) => ({
      agents: {
        ...state.agents,
        [projectId]: [agent, ...(state.agents[projectId] ?? [])],
      },
    }));
    return agent;
  },

  deleteAgent: async (projectId: string, agentId: string) => {
    await api.default.deleteAgent(projectId, agentId);
    set((state) => ({
      agents: {
        ...state.agents,
        [projectId]: (state.agents[projectId] ?? []).filter((a) => a.id !== agentId),
      },
    }));
  },

  mergeAgent: async (projectId: string, agentId: string) => {
    const agent = await api.default.mergeAgent(projectId, agentId);
    set((state) => ({
      agents: {
        ...state.agents,
        [projectId]: (state.agents[projectId] ?? []).map((a) =>
          a.id === agentId ? agent : a,
        ),
      },
    }));
    return agent;
  },

  updateAgent: (agent: Agent) => {
    set((state) => ({
      agents: {
        ...state.agents,
        [agent.projectId]: (state.agents[agent.projectId] ?? []).map((a) =>
          a.id === agent.id ? agent : a,
        ),
      },
    }));
  },
}));
