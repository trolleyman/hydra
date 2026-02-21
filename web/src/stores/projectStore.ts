import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Project } from '../api';
import { api } from './apiClient';

interface ProjectState {
  projects: Project[];
  lastProjectId: string | null;
  loading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
  createProject: (path: string) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  setLastProjectId: (id: string) => void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      projects: [],
      lastProjectId: null,
      loading: false,
      error: null,

      fetchProjects: async () => {
        set({ loading: true, error: null });
        try {
          const projects = await api.default.listProjects();
          set({ projects, loading: false });
        } catch (e: unknown) {
          set({ error: String(e), loading: false });
        }
      },

      createProject: async (path: string) => {
        const project = await api.default.createProject({ path });
        set((state) => ({ projects: [project, ...state.projects] }));
        return project;
      },

      deleteProject: async (id: string) => {
        await api.default.deleteProject(id);
        set((state) => ({
          projects: state.projects.filter((p) => p.id !== id),
          lastProjectId: state.lastProjectId === id ? null : state.lastProjectId,
        }));
      },

      setLastProjectId: (id: string) => {
        set({ lastProjectId: id });
      },
    }),
    {
      name: 'hydra-project-store',
      partialize: (state) => ({ lastProjectId: state.lastProjectId }),
    },
  ),
);
