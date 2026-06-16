import { create } from 'zustand'
import type { ProjectInfo, StatusResponse } from '../api'
import { StorageKeys, readLocal, writeLocal } from '../lib/storage'

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
  selectedProjectId: readLocal(StorageKeys.projectId),
  systemStatus: null,
  setProjects: (projects) => set({ projects }),
  setSelectedProjectId: (id) => {
    writeLocal(StorageKeys.projectId, id)
    set({ selectedProjectId: id })
  },
  setSystemStatus: (systemStatus) => set({ systemStatus }),
}))
