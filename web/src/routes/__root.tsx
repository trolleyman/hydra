import { createRootRoute, Link, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '../stores/apiClient'
import { useProjectStore } from '../stores/projectStore'
import { useAgentStore } from '../stores/agentStore'
import type { ProjectInfo, AgentResponse } from '../api'
import { ApiError, ErrorResponse } from '../api'
import { formatError } from '../api/format_error'
import { Sun, Moon, ChevronDown, Folder, Plus, Settings, Check, X } from 'lucide-react'
import { AgentSidebarItem } from '../components/AgentComponents'
import { SpawnForm } from '../components/SpawnForm'

import { Dialog } from '../components/Dialog'
import { NotFound } from '../components/NotFound'
import { Tooltip } from '../components/Tooltip'

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => <NotFound />,
})

import { useDialogStore } from '../stores/dialogStore'

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

const SIDEBAR_MIN = 160
const SIDEBAR_MAX = 600
const SIDEBAR_DEFAULT = 224

// ── Project Dropdown ───────────────────────────────────────────────────────────

function ProjectDropdown({
  projects,
  selectedId,
  onSelect,
  onDeselect,
  onAddProject,
  onRemoveProject,
}: {
  projects: ProjectInfo[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDeselect: () => void
  onAddProject: (path: string) => Promise<void>
  onRemoveProject: (id: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [showAddInput, setShowAddInput] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = projects.find((p) => p.id === selectedId)

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
      setAddError(formatError(err))
    } finally {
      setAdding(false)
    }
  }

  function handleRemove(e: React.MouseEvent, projectId: string, projectName: string) {
    e.stopPropagation()
    useDialogStore.getState().show({
      title: 'Remove Project',
      message: `Remove "${projectName}" from Hydra? This will not delete any files on disk.`,
      type: 'confirm',
      showCancel: true,
      onConfirm: async () => {
        try {
          await onRemoveProject(projectId)
        } catch (err) {
          useDialogStore.getState().show({
            title: 'Remove Failed',
            message: `Failed to remove project: ${formatError(err)}`,
            type: 'error',
          })
        }
      },
    })
  }

  return (
    <div ref={dropdownRef} className="relative shrink-0">
      <button
        onClick={() => { setOpen((o) => !o); setShowAddInput(false); setAddError(null) }}
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-md text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors max-w-xs cursor-pointer"
      >
        <Folder className="w-3.5 h-3.5" />
        <span className="truncate max-w-[160px]">{selected?.name ?? 'Select project'}</span>
        <ChevronDown className="w-3 h-3" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 overflow-hidden">
          {projects.length > 0 && (
            <div className="py-1 border-b border-gray-100 dark:border-gray-700">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`relative flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
                    p.id === selectedId ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                  }`}
                  onMouseEnter={() => setHoveredId(p.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={() => {
                    if (p.id === selectedId) {
                      onDeselect()
                    } else {
                      onSelect(p.id)
                    }
                    setOpen(false)
                  }}
                >
                  <Folder className="w-3.5 h-3.5 mt-0.5 shrink-0 text-gray-400" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{p.name}</div>
                    <div className="text-xs font-mono text-gray-400 dark:text-gray-500 truncate">{p.path}</div>
                  </div>
                  {p.id === selectedId && hoveredId !== p.id && (
                    <Check className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                  )}
                  {hoveredId === p.id && (
                    <button
                      onClick={(e) => handleRemove(e, p.id, p.name)}
                      className="shrink-0 mt-0.5 p-0.5 rounded text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="py-1">
            {!showAddInput ? (
              <button
                onClick={() => setShowAddInput(true)}
                className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer text-left text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <Plus className="w-3 h-3" />
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
  const [development, setDevelopment] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [dark, setDark] = useState<boolean>(() => {
    const stored = localStorage.getItem('hydra-dark-mode')
    if (stored !== null) return stored === 'true'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  const { projects, selectedProjectId, setProjects, setSelectedProjectId, setSystemStatus } = useProjectStore()
  const { agents, setAgents, addAgent } = useAgentStore()
  const dialog = useDialogStore()
  const navigate = useNavigate()
  const routeParams = useParams({ strict: false }) as { projectId?: string; agentId?: string }
  const currentProjectId = routeParams.projectId ?? selectedProjectId
  const selectedAgentId = routeParams.agentId

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('hydra-sidebar-width')
      if (saved) return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, parseInt(saved, 10)))
    } catch { /* ignore */ }
    return SIDEBAR_DEFAULT
  })
  const sidebarWidthRef = useRef(sidebarWidth)

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidthRef.current

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    function onMove(ev: MouseEvent) {
      const newWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + ev.clientX - startX))
      sidebarWidthRef.current = newWidth
      setSidebarWidth(newWidth)
    }
    function onUp() {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try { localStorage.setItem('hydra-sidebar-width', String(sidebarWidthRef.current)) } catch { /* ignore */ }
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  useEffect(() => {
    localStorage.setItem('hydra-dark-mode', String(dark))
    if (dark) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [dark])

  // Poll agents for selected project
  useEffect(() => {
    if (!currentProjectId) {
      setAgents([])
      return
    }

    let cancelled = false

    async function fetchAgents() {
      try {
        const result = await api.default.listAgents(currentProjectId!)
        if (!cancelled) setAgents(result)
      } catch {
        // ignore silently
      }
    }

    fetchAgents()
    const interval = setInterval(fetchAgents, 5_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [currentProjectId, setAgents])

  // Clear agents when project deselected
  useEffect(() => {
    if (!currentProjectId) setAgents([])
  }, [currentProjectId, setAgents])

  useEffect(() => {
    let cancelled = false
    let ticker: ReturnType<typeof setInterval> | null = null

    async function fetchStatus() {
      try {
        const status = await api.default.getStatus()
        if (cancelled) return
        setSystemStatus(status)
        setDevelopment(status.development ?? false)
        if (status.uptime_seconds != null) {
          if (spawnedAt.current === null) {
            spawnedAt.current = Date.now() - status.uptime_seconds * 1000
            setTick((n) => n + 1)
          }
          if (ticker === null) {
            ticker = setInterval(() => setTick((n) => n + 1), 1000)
          }
        }
        try {
          const ps = await api.default.listProjects()
          if (cancelled) return
          setProjects(ps)
          const currentId = useProjectStore.getState().selectedProjectId
          if (currentId == null || !ps.some((p) => p.id === currentId)) {
            let newId: string | null = null
            if (status.default_project_id != null && ps.some((p) => p.id === status.default_project_id)) {
              newId = status.default_project_id
            } else if (ps.length > 0) {
              newId = ps[0].id
            }
            if (newId != null) {
              setSelectedProjectId(newId)
              // Do NOT auto-navigate — just set the selected project
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

  async function handleRestart() {
    setRestarting(true)
    try {
      await api.default.devRestart()
    } catch (err: any) {
      if (err?.status === 403) {
        useDialogStore.getState().show({
          title: 'Dev Mode Required',
          message: 'Server is not running in dev mode.',
          type: 'warning'
        })
        setRestarting(false)
        return
      }
    }

    for (let i = 0; i < 60; i++) {
      await new Promise<void>((r) => setTimeout(r, 500))
      try {
        const resp = await fetch('/health')
        if (resp.ok) {
          const text = await resp.text()
          if (text.trim() === 'OK') break
        }
      } catch { /* still restarting */ }
    }
    window.location.reload()
  }

  async function handleAddProject(path: string) {
    try {
      const p = await api.default.addProject({ path })
      const exists = projects.some((existing) => existing.id === p.id)
      if (!exists) {
        setProjects([...projects, p])
      }
      setSelectedProjectId(p.id)
      const isOnSettings = window.location.pathname.endsWith('/settings')
      navigate({ to: isOnSettings ? '/project/$projectId/settings' : '/project/$projectId', params: { projectId: p.id } })
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        const errorType = err.body?.error
        const isNotFound = errorType === ErrorResponse.error.PATH_NOT_FOUND
        const isNotGit = errorType === ErrorResponse.error.NOT_A_GIT_REPO

        if (isNotFound || isNotGit) {
          return new Promise<void>((resolve, reject) => {
            dialog.show({
              title: isNotFound ? 'Directory Not Found' : 'Not a Git Repository',
              message: isNotFound
                ? `The directory "${path}" does not exist. Do you want to create it and initialize a git repository?`
                : `The directory "${path}" is not a git repository. Do you want to initialize one?`,
              type: 'confirm',
              showCancel: true,
              onConfirm: async () => {
                try {
                  const p = await api.default.addProject({
                    path,
                    create_if_missing: isNotFound,
                    init_git: true,
                  })
                  const exists = projects.some((existing) => existing.id === p.id)
                  if (!exists) {
                    setProjects([...projects, p])
                  }
                  setSelectedProjectId(p.id)
                  const isOnSettings = window.location.pathname.endsWith('/settings')
                  navigate({ to: isOnSettings ? '/project/$projectId/settings' : '/project/$projectId', params: { projectId: p.id } })
                  resolve()
                } catch (e) {
                  reject(e)
                }
              },
              onCancel: () => {
                reject(err)
              },
            })
          })
        }
      }
      throw err
    }
  }

  async function handleRemoveProject(id: string) {
    await api.default.removeProject(id)
    const updated = projects.filter(p => p.id !== id)
    setProjects(updated)
    if (selectedProjectId === id || currentProjectId === id) {
      setSelectedProjectId(null)
      setAgents([])
      navigate({ to: '/' })
    }
  }

  function handleSpawned(agent: AgentResponse) {
    addAgent(agent)
    if (currentProjectId) {
      navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId: currentProjectId, agentId: agent.id } })
    }
  }

  const filteredAgents = agents.filter((a) => !a.ephemeral)
  const selectedProject = projects.find((p) => p.id === currentProjectId) ?? null

  return (
    <div className="h-full bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 flex flex-col">
      <header className="h-12 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-center px-4 gap-3 shrink-0">
        <Link
          to={currentProjectId ? '/project/$projectId' : '/'}
          params={currentProjectId ? { projectId: currentProjectId } : {}}
          className="flex items-center gap-2 shrink-0"
        >
          <div className="w-6 h-6 flex items-center justify-center overflow-hidden rounded-sm">
            <img
              className='w-full h-full object-cover object-center'
              srcSet="/icon.png, /icon.avif"
              src="/icon.png"
              alt="Hydra icon" />
          </div>
          <span className="text-2xl font-bold font-serif tracking-[-0.05em] dark:text-gray-100">Hydra</span>
        </Link>

        <ProjectDropdown
          projects={projects}
          selectedId={currentProjectId}
          onSelect={(id) => {
            setSelectedProjectId(id)
            const isOnSettings = window.location.pathname.endsWith('/settings')
            navigate({ to: isOnSettings ? '/project/$projectId/settings' : '/project/$projectId', params: { projectId: id } })
          }}
          onDeselect={() => {
            setSelectedProjectId(null)
            navigate({ to: '/' })
          }}
          onAddProject={handleAddProject}
          onRemoveProject={handleRemoveProject}
        />

        {selectedProject && (
          <span className="text-xs font-mono text-gray-400 dark:text-gray-500 truncate min-w-0 mt-1 hidden sm:block">
            {selectedProject.path}
          </span>
        )}

        <div className="ml-auto flex items-center gap-3 shrink-0 self-center">
          {spawnedAt.current !== null && (
            <Tooltip content={`Spawned at ${new Date(spawnedAt.current).toUTCString()}`}>
              <span className="text-xs text-gray-400 dark:text-gray-500 cursor-default hidden md:block">
                {formatSpawnedAgo(Date.now() - spawnedAt.current)}
              </span>
            </Tooltip>
          )}
          {development && (
            <Tooltip content="Rebuild and restart the server">
              <button
                onClick={handleRestart}
                disabled={restarting}
                className="text-xs px-2 py-0.5 rounded bg-amber-100 cursor-pointer dark:bg-amber-900 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800 disabled:opacity-50 transition-colors hidden md:block"
              >
                {restarting ? 'Restarting…' : 'Restart'}
              </button>
            </Tooltip>
          )}
          <Tooltip content={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
            <button
              onClick={() => setDark((d) => !d)}
              className="w-7 h-7 flex items-center justify-center rounded-md cursor-pointer text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              {dark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
          </Tooltip>
          <Tooltip content="Settings">
            {currentProjectId ? (
              <Link
                to="/project/$projectId/settings"
                params={{ projectId: currentProjectId }}
                className="w-7 h-7 flex items-center justify-center rounded-md cursor-pointer text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <Settings className="w-5 h-5" />
              </Link>
            ) : (
              <Link
                to="/settings"
                className="w-7 h-7 flex items-center justify-center rounded-md cursor-pointer text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <Settings className="w-5 h-5" />
              </Link>
            )}
          </Tooltip>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Persistent sidebar */}
        <aside
          style={{ width: sidebarWidth }}
          className="relative bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col shrink-0"
        >
          <SpawnForm compact projectId={currentProjectId} onSpawned={handleSpawned} disabled={!currentProjectId} />

          <div className="px-3 py-3 border-b border-gray-100 dark:border-gray-700">
            <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Agents
            </span>
            <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">({filteredAgents.length})</span>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {filteredAgents.length === 0 ? (
              <div className="px-3 py-4 text-xs text-gray-400 dark:text-gray-500 text-center">
                {!currentProjectId
                  ? 'Select a project to view agents'
                  : 'Spawn an agent to get started'}
              </div>
            ) : (
              filteredAgents.map((agent) => (
                <AgentSidebarItem
                  key={agent.id}
                  agent={agent}
                  selected={agent.id === selectedAgentId}
                  onClick={() => {
                    if (!currentProjectId) return
                    if (agent.id === selectedAgentId) {
                      navigate({ to: '/project/$projectId', params: { projectId: currentProjectId } })
                    } else {
                      navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId: currentProjectId, agentId: agent.id } })
                    }
                  }}
                />
              ))
            )}
          </div>

          {/* Resize handle */}
          <div
            onMouseDown={handleSidebarResizeStart}
            className="absolute right-0 top-0 bottom-0 w-3 -mr-1 cursor-col-resize z-10 group flex items-stretch justify-center"
          >
            <div className="w-px group-hover:bg-blue-400/60 group-active:bg-blue-500 transition-colors" />
          </div>
        </aside>

        {/* Main content */}
        <Outlet />
      </div>
      <Dialog />
    </div>
  )
}
