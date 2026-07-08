import { useCallback, useRef, useState } from 'react'
import { ApiError } from '../api'
import { api } from '../stores/apiClient'
import { formatError } from '../api/format_error'
import { useToastStore, type ToastProjectContext } from '../stores/toastStore'
import { useProjectStore } from '../stores/projectStore'
import { useServerData } from './useServerData'
import { EVENT_FALLBACK_MS } from './visibilityPolling'
import type { RepositoryPushStatus } from '../api'

export interface PushStatus {
  pushStatus: RepositoryPushStatus | null
  // True while the selected project has an in-flight sync.
  syncing: boolean
  // Pull then push the current branch, with toasts for progress/result/conflict.
  handleSync: () => Promise<void>
  // True while the selected project has an in-flight commit.
  committing: boolean
  // Commit the given uncommitted paths in the project root with the given
  // message. Resolves true on success (failures toast and resolve false).
  handleCommit: (message: string, paths: string[]) => Promise<boolean>
  // Stable refetch handle - wire into the caller's events stream.
  refetchPushStatus: () => void
}

// Push/pull status for the project's current branch: drives the sidebar Sync
// button, which shows how far ahead/behind the remote the branch is and, when
// clicked, pulls then pushes. Refreshed on the slow fallback poll, plus on demand
// after a sync or when the events stream reports a change (via `refetchPushStatus`).
export function usePushStatus(currentProjectId: string | null): PushStatus {
  // Track which projects have an in-flight sync, keyed by project id, so the
  // spinner/disabled state stays tied to the project the sync was started for
  // rather than bleeding onto whatever project/tab the sidebar shows next.
  const [syncingProjects, setSyncingProjects] = useState<ReadonlySet<string>>(() => new Set())
  const syncing = currentProjectId ? syncingProjects.has(currentProjectId) : false
  const [committingProjects, setCommittingProjects] = useState<ReadonlySet<string>>(() => new Set())
  const committing = currentProjectId ? committingProjects.has(currentProjectId) : false

  const { data: pushStatus, setData: setPushStatus, refetch: refetchPushStatus } =
    useServerData<RepositoryPushStatus | null>(
      currentProjectId,
      (id) => api.default.getRepositoryPushStatus(id),
      // trackLoading false: nobody reads `loading` and this hook lives in
      // RootLayout - the flag toggling would re-render the whole chrome twice
      // per background refetch.
      { intervalMs: EVENT_FALLBACK_MS, initial: null, resetOnError: true, trackLoading: false },
    )

  // Read through a ref so a sync that finishes after the user switches projects
  // only paints its result if they're still looking at the project it ran for.
  const currentProjectIdRef = useRef(currentProjectId)
  currentProjectIdRef.current = currentProjectId

  const handleSync = useCallback(async () => {
    if (!currentProjectId || syncingProjects.has(currentProjectId)) return
    const projectId = currentProjectId
    const toast = useToastStore.getState()
    // Carry the project so its toasts show a header once the user switches away
    // to another project (the Toaster hides the header while this project is in
    // view). The icon matches the project switcher's glyph.
    const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
    const projectContext: ToastProjectContext = {
      projectId,
      projectName: project?.name || project?.path || projectId,
      icon: project?.icon,
    }
    setSyncingProjects((prev) => new Set(prev).add(projectId))
    const toastId = toast.show({ message: 'Syncing with remote...', type: 'info', duration: 0, projectContext })
    try {
      const result = await api.default.syncRepository(projectId)
      // Only paint the result if the user is still looking at this project;
      // otherwise the per-project poll/websocket keeps the visible one correct.
      if (currentProjectIdRef.current === projectId) setPushStatus(result)
      toast.dismiss(toastId)
      // The backticks render the remote branch as a mono pill in the toast.
      const where = result.remote && result.branch ? ` with \`${result.remote}/${result.branch}\`` : ''
      toast.show({ message: `Synced${where}`, type: 'success', projectContext })
    } catch (err) {
      toast.dismiss(toastId)
      // A 409 means the pull couldn't merge cleanly; surface it distinctly.
      const conflict = err instanceof ApiError && err.status === 409
      toast.show({
        message: conflict
          ? `Sync failed: pull conflicts - resolve in the repository, then retry`
          : `Sync failed: ${formatError(err)}`,
        type: 'error',
        duration: 6000,
        projectContext,
      })
    } finally {
      setSyncingProjects((prev) => {
        const next = new Set(prev)
        next.delete(projectId)
        return next
      })
      refetchPushStatus()
    }
  }, [currentProjectId, syncingProjects, refetchPushStatus, setPushStatus])

  const handleCommit = useCallback(async (message: string, paths: string[]): Promise<boolean> => {
    if (!currentProjectId || committingProjects.has(currentProjectId)) return false
    const projectId = currentProjectId
    const toast = useToastStore.getState()
    setCommittingProjects((prev) => new Set(prev).add(projectId))
    try {
      const result = await api.default.commitRepository(projectId, { message, paths })
      if (currentProjectIdRef.current === projectId) setPushStatus(result)
      toast.show({
        message: `Committed ${paths.length} file${paths.length === 1 ? '' : 's'}`,
        type: 'success',
      })
      return true
    } catch (err) {
      toast.show({ message: `Commit failed: ${formatError(err)}`, type: 'error', duration: 6000 })
      return false
    } finally {
      setCommittingProjects((prev) => {
        const next = new Set(prev)
        next.delete(projectId)
        return next
      })
      refetchPushStatus()
    }
  }, [currentProjectId, committingProjects, refetchPushStatus, setPushStatus])

  return { pushStatus, syncing, handleSync, committing, handleCommit, refetchPushStatus }
}
