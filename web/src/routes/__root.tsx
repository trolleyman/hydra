import { createRootRoute, Outlet } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { api } from '../stores/apiClient'
import { useProjectStore } from '../stores/projectStore'
import type { ProjectInfo } from '../api'

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

function formatSpawnedAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 5) return 'Spawned just now'
  if (seconds < 60) return `Spawned ${seconds} seconds ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Spawned ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Spawned ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Spawned yesterday'
  return `Spawned ${days} days ago`
}

function SunIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M12 5v14" />
    </svg>
  )
}

// ── Project Dropdown ───────────────────────────────────────────────────────────

function ProjectDropdown({
  projects,
  selectedId,
  onSelect,
  onAddProject,
}: {
  projects: ProjectInfo[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAddProject: (path: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [showAddInput, setShowAddInput] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = projects.find((p) => p.id === selectedId)

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
        setShowAddInput(false)
        setAddError(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  useEffect(() => {
    if (showAddInput) {
      inputRef.current?.focus()
    }
  }, [showAddInput])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    const path = newPath.trim()
    if (!path || adding) return
    setAdding(true)
    setAddError(null)
    try {
      await onAddProject(path)
      setNewPath('')
      setShowAddInput(false)
      setOpen(false)
    } catch (err) {
      setAddError(String(err))
    } finally {
      setAdding(false)
    }
  }

  return (
    <div ref={dropdownRef} className="relative shrink-0">
      <button
        onClick={() => { setOpen((o) => !o); setShowAddInput(false); setAddError(null) }}
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-md text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors max-w-xs"
        title={selected?.path ?? 'Select project'}
      >
        <FolderIcon />
        <span className="truncate max-w-[160px]">{selected?.name ?? 'Select project'}</span>
        <ChevronDownIcon />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 overflow-hidden">
          {projects.length > 0 && (
            <div className="py-1 border-b border-gray-100 dark:border-gray-700">
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { onSelect(p.id); setOpen(false) }}
                  className={`w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
                    p.id === selectedId ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                  }`}
                >
                  <FolderIcon />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{p.name}</div>
                    <div className="text-xs font-mono text-gray-400 dark:text-gray-500 truncate">{p.path}</div>
                  </div>
                  {p.id === selectedId && (
                    <svg className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Add project section */}
          <div className="py-1">
            {!showAddInput ? (
              <button
                onClick={() => setShowAddInput(true)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <PlusIcon />
                Open folder…
              </button>
            ) : (
              <form onSubmit={handleAdd} className="px-3 py-2">
                <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">Folder path</label>
                <input
                  ref={inputRef}
                  type="text"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  placeholder="/absolute/path/to/project"
                  disabled={adding}
                  className="w-full text-xs font-mono px-2 py-1.5 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-500 focus:outline-none focus:border-blue-400 dark:focus:border-blue-500 disabled:opacity-50"
                />
                {addError && (
                  <p className="text-[10px] text-red-500 mt-1 leading-snug">{addError}</p>
                )}
                <div className="flex gap-2 mt-2">
                  <button
                    type="submit"
                    disabled={!newPath.trim() || adding}
                    className="flex-1 text-xs py-1 px-2 rounded bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  >
                    {adding ? 'Opening…' : 'Open'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowAddInput(false); setNewPath(''); setAddError(null) }}
                    className="text-xs py-1 px-2 rounded border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Root Layout ────────────────────────────────────────────────────────────────

function RootLayout() {
  const spawnedAt = useRef<number | null>(null)
  const [, setTick] = useState(0)
  const [dark, setDark] = useState<boolean>(() => {
    const stored = localStorage.getItem('hydra-dark-mode')
    if (stored !== null) return stored === 'true'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  const { projects, selectedProjectId, setProjects, setSelectedProjectId } = useProjectStore()

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
        if (status.uptime_seconds != null) {
          if (spawnedAt.current === null) {
            spawnedAt.current = Date.now() - status.uptime_seconds * 1000
            setTick((n) => n + 1)
          }
          if (ticker === null) {
            ticker = setInterval(() => setTick((n) => n + 1), 1000)
          }
        }
        // Load projects list and ensure the default project is selected if nothing is chosen yet.
        try {
          const ps = await api.default.listProjects()
          if (cancelled) return
          setProjects(ps)
          // Auto-select default project if current selection is absent.
          const currentId = useProjectStore.getState().selectedProjectId
          if (currentId == null || !ps.some((p) => p.id === currentId)) {
            // Fall back to the server's default project id.
            if (status.default_project_id != null && ps.some((p) => p.id === status.default_project_id)) {
              setSelectedProjectId(status.default_project_id)
            } else if (ps.length > 0) {
              setSelectedProjectId(ps[0].id)
            }
          }
        } catch {
          // ignore project fetch errors silently
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
  }, [setProjects, setSelectedProjectId])

  async function handleAddProject(path: string) {
    const p = await api.default.addProject({ path })
    // Merge: add only if not already present.
    const exists = projects.some((existing) => existing.id === p.id)
    if (!exists) {
      setProjects([...projects, p])
    }
    setSelectedProjectId(p.id)
  }

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null

  return (
    <div className={`min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 flex flex-col${dark ? ' dark' : ''}`}>
      <header className="h-12 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-center px-4 gap-3 shrink-0">
        {/* Logo */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-6 h-6 flex items-center justify-center overflow-hidden rounded-sm">
            <img
              className='w-full h-full object-cover object-center'
              srcSet="icon.png, icon.avif"
              src="icon.png"
              alt="Hydra icon" />
          </div>
          <span className="text-2xl font-bold font-serif tracking-[-0.05em] dark:text-gray-100">Hydra</span>
        </div>

        {/* Project selector dropdown */}
        <ProjectDropdown
          projects={projects}
          selectedId={selectedProjectId}
          onSelect={setSelectedProjectId}
          onAddProject={handleAddProject}
        />

        {/* Current project path (monospace, truncated) */}
        {selectedProject && (
          <span className="text-xs font-mono text-gray-400 dark:text-gray-500 truncate min-w-0 mt-1 hidden sm:block">
            {selectedProject.path}
          </span>
        )}

        <div className="ml-auto flex items-center gap-3 shrink-0 self-center">
          {spawnedAt.current !== null && (
            <span
              className="text-xs text-gray-400 dark:text-gray-500 cursor-default hidden md:block"
              title={`Spawned at ${new Date(spawnedAt.current).toUTCString()}`}
            >
              {formatSpawnedAgo(Date.now() - spawnedAt.current)}
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
