import { create } from 'zustand'
import type { ProjectInfo } from '../api'

const STORAGE_KEY = 'hydra-project-id'

interface ProjectState {
  projects: ProjectInfo[]
  selectedProjectId: string | null
  setProjects: (projects: ProjectInfo[]) => void
  setSelectedProjectId: (id: string | null) => void
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
}))
