import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import { api } from '../stores/apiClient'
import { useProjectStore } from '../stores/projectStore'
import { useServerData } from './useServerData'
import { EVENT_FALLBACK_MS } from './visibilityPolling'
import type { StatusResponse } from '../api'

export interface SystemStatus {
  // Stable refetch handle - wire into the caller's events stream.
  refetchStatus: () => void
  // Whether the server can re-exec itself (gates the restart control).
  canRestart: boolean
  // Whether it can also rebuild itself from source first.
  canUpdate: boolean
  // Build/version identifier reported by the running server.
  version: string | null
  // Server boot time as a client epoch (ms), or null until the first status lands.
  // A ref so the once-per-second uptime ticker can advance the label without the
  // caller threading extra state.
  spawnedAt: MutableRefObject<number | null>
}

// System status + project list: refreshed by the events stream, with a slow
// visibility-gated fallback poll. The fetch lands the status in the store and,
// chained off it, refreshes the project list + auto-selects a project on a cold
// load. The "up N minutes" label advances itself via an isolated <Uptime> leaf
// (see LiveTime / useNowTick) - we only force ONE render here, the moment the
// server first reports an uptime, so that label mounts.
export function useSystemStatus(): SystemStatus {
  const spawnedAt = useRef<number | null>(null)
  const [, setTick] = useState(0)
  const [canRestart, setCanRestart] = useState(false)
  const [canUpdate, setCanUpdate] = useState(false)
  const [version, setVersion] = useState<string | null>(null)

  const handleStatus = useCallback((status: StatusResponse) => {
    const { setSystemStatus, setProjects, setSelectedProjectId } = useProjectStore.getState()
    setSystemStatus(status)
    setCanRestart(status.can_restart ?? false)
    setCanUpdate(status.can_update ?? false)
    setVersion(status.version ?? null)
    if (status.uptime_seconds != null && spawnedAt.current === null) {
      spawnedAt.current = Date.now() - status.uptime_seconds * 1000
      setTick((n) => n + 1) // one render to mount the self-ticking <Uptime> label
    }
    api.default.listProjects().then((ps) => {
      setProjects(ps)
      const currentId = useProjectStore.getState().selectedProjectId
      if (currentId == null || !ps.some((p) => p.id === currentId)) {
        const newId =
          status.default_project_id != null && ps.some((p) => p.id === status.default_project_id)
            ? status.default_project_id
            // Prefer a project the user actually registered. The built-in scratch
            // project is always present, so a bare ps[0] could silently make it
            // the landing project for someone who has real work to open.
            : (ps.find((p) => !p.builtin)?.id ?? ps[0]?.id ?? null)
        // Just record the selection; the redirect effect in RootLayout moves the
        // UI onto the project's page if we're sitting on the root route.
        if (newId != null) setSelectedProjectId(newId)
      }
    }).catch(() => {
      // ignore project fetch errors silently
    })
  }, [])

  const { refetch: refetchStatus } = useServerData<StatusResponse>(
    'system-status',
    () => api.default.getStatus(),
    // trackLoading false: `loading` is unused and this hook lives in RootLayout.
    { intervalMs: EVENT_FALLBACK_MS, onData: handleStatus, trackLoading: false },
  )

  return { refetchStatus, canRestart, canUpdate, version, spawnedAt }
}
