import { create } from 'zustand'
import type { ProjectInfo, ReviewConfigResponse, StatusResponse } from '../api'
import { api } from './apiClient'
import { StorageKeys, readJSON, readLocal, writeJSON, writeLocal } from '../lib/storage'
import { deepEqual, reconcileList, reuseIfEqual } from '../lib/deepEqual'

// readStoredReviewConfigs hydrates the persisted per-project review-config
// snapshots (see StorageKeys.reviewConfigs). The endpoint that refreshes them
// is slow (it shells out to gh/glab), so booting from the snapshot lets the
// sidebar forge icon and MR prefill render instantly instead of popping in.
function readStoredReviewConfigs(): Record<string, ReviewConfigResponse> {
  return (
    readJSON<Record<string, ReviewConfigResponse>>(StorageKeys.reviewConfigs, (v) =>
      v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, ReviewConfigResponse>) : null,
    ) ?? {}
  )
}

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
  reviewConfigs: readStoredReviewConfigs(),
  // The setters below reuse the previous objects when a refetch returns
  // structurally-identical data, so the polls/event-driven refreshes that
  // re-deliver the same state don't re-render every subscriber.
  setProjects: (projects) => set((s) => {
    // Piggyback on the project list to prune persisted review configs of
    // removed projects, so the localStorage snapshot can't grow unbounded.
    const stale = Object.keys(s.reviewConfigs).filter((id) => !projects.some((p) => p.id === id))
    let reviewConfigs = s.reviewConfigs
    if (stale.length > 0) {
      reviewConfigs = { ...s.reviewConfigs }
      for (const id of stale) delete reviewConfigs[id]
      writeJSON(StorageKeys.reviewConfigs, reviewConfigs)
    }
    return { projects: reconcileList(s.projects, projects, (p) => p.id), reviewConfigs }
  }),
  setSelectedProjectId: (id) => {
    writeLocal(StorageKeys.projectId, id)
    set({ selectedProjectId: id })
  },
  setSystemStatus: (systemStatus) => set((s) => ({ systemStatus: reuseIfEqual(s.systemStatus, systemStatus) })),
  setReviewConfig: (projectId, cfg) => set((s) => {
    if (deepEqual(s.reviewConfigs[projectId], cfg)) return {}
    const reviewConfigs = { ...s.reviewConfigs, [projectId]: cfg }
    writeJSON(StorageKeys.reviewConfigs, reviewConfigs)
    return { reviewConfigs }
  }),
}))

// One in-flight GET per project, shared by every consumer (root layout, agent
// page, settings Review section): simultaneous cold mounts - including
// StrictMode's dev double-mount - join the same request instead of each firing
// their own. The endpoint is slow (~600ms; the server shells out to gh/glab
// for auth status), so stray duplicates are very visible in the request log.
const reviewConfigFetches = new Map<string, Promise<void>>()

// Projects whose review config was fetched from the server this session. A
// localStorage-hydrated entry renders immediately but still counts as stale -
// ensureReviewConfig kicks one background refresh per project per session so
// the snapshot tracks config/auth changes.
const freshReviewConfigs = new Set<string>()

// ensureReviewConfig loads a project's resolved review config into the store
// cache; a no-op when it was already fetched this session or a fetch is in
// flight. With a persisted snapshot present the store already has data, so
// consumers render instantly while this refresh runs.
export function ensureReviewConfig(projectId: string): Promise<void> {
  if (freshReviewConfigs.has(projectId)) return Promise.resolve()
  return refreshReviewConfig(projectId)
}

// refreshReviewConfig re-fetches even when cached (still joining any in-flight
// fetch), for callers that want fresh values - opening the Create MR dialog,
// saving settings. Failures are swallowed: a previously-cached config stays put.
export function refreshReviewConfig(projectId: string): Promise<void> {
  const running = reviewConfigFetches.get(projectId)
  if (running) return running
  const request = api.default
    .getReviewConfig(projectId)
    .then((cfg) => {
      freshReviewConfigs.add(projectId)
      useProjectStore.getState().setReviewConfig(projectId, cfg)
    })
    .catch(() => {})
    .finally(() => reviewConfigFetches.delete(projectId))
  reviewConfigFetches.set(projectId, request)
  return request
}
