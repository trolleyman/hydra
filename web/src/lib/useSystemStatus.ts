import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { api } from '../stores/apiClient'
import { useProjectStore } from '../stores/projectStore'
import { useServerData } from './useServerData'
import { EVENT_FALLBACK_MS } from './visibilityPolling'
import type { StatusResponse } from '../api'

export interface SystemStatus {
  // Stable refetch handle — wire into the caller's events stream.
  refetchStatus: () => void
  // Whether the server is running in dev mode (gates the restart button).
  development: boolean
  // Server boot time as a client epoch (ms), or null until the first status lands.
  // A ref so the once-per-second uptime ticker can advance the label without the
  // caller threading extra state.
  spawnedAt: MutableRefObject<number | null>
}

// System status + project list: refreshed by the events stream, with a slow
// visibility-gated fallback poll. The fetch lands the status in the store and,
// chained off it, refreshes the project list + auto-selects a project on a cold
// load. A once-armed uptime ticker re-renders every second so the "up N minutes"
// label advances.
export function useSystemStatus(): SystemStatus {
  const spawnedAt = useRef<number | null>(null)
  const [, setTick] = useState(0)
  const [development, setDevelopment] = useState(false)
  const [uptimeTracking, setUptimeTracking] = useState(false)

  const handleStatus = useCallback((status: StatusResponse) => {
    const { setSystemStatus, setProjects, setSelectedProjectId } = useProjectStore.getState()
    setSystemStatus(status)
    setDevelopment(status.development ?? false)
    if (status.uptime_seconds != null) {
      if (spawnedAt.current === null) {
        spawnedAt.current = Date.now() - status.uptime_seconds * 1000
        setTick((n) => n + 1)
      }
      setUptimeTracking(true)
    }
    api.default.listProjects().then((ps) => {
      setProjects(ps)
      const currentId = useProjectStore.getState().selectedProjectId
      if (currentId == null || !ps.some((p) => p.id === currentId)) {
        let newId: string | null = null
        if (status.default_project_id != null && ps.some((p) => p.id === status.default_project_id)) {
          newId = status.default_project_id
        } else if (ps.length > 0) {
          newId = ps[0].id
        }
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
    { intervalMs: EVENT_FALLBACK_MS, onData: handleStatus },
  )

  // Uptime ticker: once the server reports an uptime, re-render every second so
  // the "up N minutes" label advances. Armed once and runs until unmount.
  useEffect(() => {
    if (!uptimeTracking) return
    const ticker = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(ticker)
  }, [uptimeTracking])

  return { refetchStatus, development, spawnedAt }
}
