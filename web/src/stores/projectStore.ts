import { create } from 'zustand'
import type { ProjectInfo, StatusResponse } from '../api'

const STORAGE_KEY = 'hydra-project-id'

interface ProjectState {
  projects: ProjectInfo[]
  selectedProjectId: string | null
  systemStatus: StatusResponse | null
  setProjects: (projects: ProjectInfo[]) => void
  setSelectedProjectId: (id: string | null) => void
  setSystemStatus: (status: StatusResponse) => void
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  selectedProjectId: (() => {
    try {
      return localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  })(),
  systemStatus: null,
  setProjects: (projects) => set({ projects }),
  setSelectedProjectId: (id) => {
    try {
      if (id == null) {
        localStorage.removeItem(STORAGE_KEY)
      } else {
        localStorage.setItem(STORAGE_KEY, id)
      }
    } catch { /* ignore */ }
    set({ selectedProjectId: id })
  },
  setSystemStatus: (systemStatus) => set({ systemStatus }),
}))
