import { create } from 'zustand'
import type { ProjectInfo, ReviewConfigResponse, StatusResponse } from '../api'
import { StorageKeys, readLocal, writeLocal } from '../lib/storage'

interface ProjectState {
  projects: ProjectInfo[]
  selectedProjectId: string | null
  systemStatus: StatusResponse | null
  // Resolved [review] config, cached per project. It is project-scoped (not
  // per-agent), so it is fetched once and shared by the Create MR dialog prefill
  // and the Settings editor, rather than re-fetched on every agent view.
  reviewConfigs: Record<string, ReviewConfigResponse>
  setProjects: (projects: ProjectInfo[]) => void
  setSelectedProjectId: (id: string | null) => void
  setSystemStatus: (status: StatusResponse) => void
  setReviewConfig: (projectId: string, cfg: ReviewConfigResponse) => void
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  selectedProjectId: readLocal(StorageKeys.projectId),
  systemStatus: null,
  reviewConfigs: {},
  setProjects: (projects) => set({ projects }),
  setSelectedProjectId: (id) => {
    writeLocal(StorageKeys.projectId, id)
    set({ selectedProjectId: id })
  },
  setSystemStatus: (systemStatus) => set({ systemStatus }),
  setReviewConfig: (projectId, cfg) => set((s) => ({ reviewConfigs: { ...s.reviewConfigs, [projectId]: cfg } })),
}))
