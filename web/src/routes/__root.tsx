import { createRootRoute, Outlet } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { api } from '../stores/apiClient'

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-2">404</h1>
        <p className="text-gray-500">Page not found</p>
      </div>
    </div>
  ),
})

function formatUptime(seconds: number): string {
  const s = Math.floor(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return `${m}m ${rs}s`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}h ${rm}m`
}

function RootLayout() {
  const [projectRoot, setProjectRoot] = useState<string | null>(null)
  const [uptimeSeconds, setUptimeSeconds] = useState<number | null>(null)
  const uptimeFetchedAt = useRef<number>(0)
  const uptimeAtFetch = useRef<number>(0)

  useEffect(() => {
    let cancelled = false
    let ticker: ReturnType<typeof setInterval> | null = null

    async function fetchStatus() {
      try {
        const status = await api.default.getStatus()
        if (cancelled) return
        if (status.project_root != null) setProjectRoot(status.project_root)
        if (status.uptime_seconds != null) {
          uptimeAtFetch.current = status.uptime_seconds
          uptimeFetchedAt.current = Date.now()
          setUptimeSeconds(status.uptime_seconds)
          if (ticker === null) {
            ticker = setInterval(() => {
              const elapsed = (Date.now() - uptimeFetchedAt.current) / 1000
              setUptimeSeconds(uptimeAtFetch.current + elapsed)
            }, 1000)
          }
        }
      } catch {
        // ignore errors silently
      }
    }

    fetchStatus()
    const pollInterval = setInterval(fetchStatus, 10_000)
    return () => {
      cancelled = true
      clearInterval(pollInterval)
      if (ticker !== null) clearInterval(ticker)
    }
  }, [])

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col">
      <header className="h-12 bg-white border-b border-gray-200 flex items-center px-4 gap-4 shrink-0">
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-6 h-6 bg-blue-600 rounded-md flex items-center justify-center">
            <span className="text-white font-bold text-xs">H</span>
          </div>
          <span className="font-semibold text-gray-900">Hydra</span>
        </div>
        {projectRoot && (
          <span className="text-xs font-mono text-gray-500 truncate min-w-0">
            {projectRoot}
          </span>
        )}
        <div className="ml-auto shrink-0">
          {uptimeSeconds !== null && (
            <span className="text-xs text-gray-400">
              up {formatUptime(uptimeSeconds)}
            </span>
          )}
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  )
}
