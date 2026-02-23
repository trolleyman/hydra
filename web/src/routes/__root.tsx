import { createRootRoute, Outlet } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { api } from '../stores/apiClient'

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100 mb-2">404</h1>
        <p className="text-gray-500 dark:text-gray-400">Page not found</p>
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

function SunIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4"/>
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
    </svg>
  )
}

function RootLayout() {
  const [projectRoot, setProjectRoot] = useState<string | null>(null)
  const [uptimeSeconds, setUptimeSeconds] = useState<number | null>(null)
  const uptimeFetchedAt = useRef<number>(0)
  const uptimeAtFetch = useRef<number>(0)
  const [dark, setDark] = useState<boolean>(() => {
    const stored = localStorage.getItem('hydra-dark-mode')
    if (stored !== null) return stored === 'true'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    localStorage.setItem('hydra-dark-mode', String(dark))
  }, [dark])

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
    <div className={`min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 flex flex-col${dark ? ' dark' : ''}`}>
      <header className="h-12 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-center px-4 gap-4 shrink-0">
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-6 h-6 bg-blue-600 rounded-md flex items-center justify-center">
            <span className="text-white font-bold text-xs">H</span>
          </div>
          <span className="font-semibold text-gray-900 dark:text-gray-100">Hydra</span>
        </div>
        {projectRoot && (
          <span className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate min-w-0">
            {projectRoot}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 shrink-0">
          {uptimeSeconds !== null && (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              up {formatUptime(uptimeSeconds)}
            </span>
          )}
          <button
            onClick={() => setDark((d) => !d)}
            className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {dark ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  )
}
