import { createRootRoute, Link, Outlet, useNavigate, useParams, useLocation } from '@tanstack/react-router'
import { useEffect, useRef, useState, useCallback, type WheelEvent } from 'react'
import { api } from '../stores/apiClient'
import { useProjectStore } from '../stores/projectStore'
import { useAgentStore } from '../stores/agentStore'
import type { ProjectInfo, AgentResponse } from '../api'
import { ApiError, ErrorResponse } from '../api'
import { formatError } from '../api/format_error'
import { Sun, Moon, Monitor, ChevronDown, Folder, FolderGit2, FolderOpen, Plus, Settings, Check, X } from 'lucide-react'
import { folderPickerAvailable, openFolderPicker } from '../api/folderPicker'
import { AgentSidebarItem } from '../components/AgentComponents'
import { SpawnForm } from '../components/SpawnForm'

import { Dialog } from '../components/Dialog'
import { Toaster } from '../components/Toaster'
import { NotFound } from '../components/NotFound'
import { Tooltip } from '../components/Tooltip'
import { ClaudeUsageIndicator } from '../components/ClaudeUsageIndicator'
import { TrustProjectModal } from '../components/TrustProjectModal'

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => <NotFound />,
})

import { useDialogStore } from '../stores/dialogStore'
import { pruneArtifactPrefs } from '../lib/artifactPrefs'
import { pruneAgentViewPrefs } from '../lib/agentViewPrefs'
import { StorageKeys, readLocal, writeLocal, readTrustedProjects, trustProject } from '../lib/storage'
import { loadProjectView, saveProjectView, type ProjectView } from '../lib/projectView'

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
const SIDEBAR_DEFAULT = 264

// When the agents sidebar can't consume a wheel event (no scrollbar, or already
// at the top/bottom edge), forward the scroll to the main content area (e.g. the
// diff view) so the wheel isn't swallowed by the sidebar's dead space.
function forwardSidebarWheelToMain(e: WheelEvent<HTMLDivElement>) {
  const list = e.currentTarget
  const atTop = list.scrollTop <= 0
  const atBottom = Math.ceil(list.scrollTop + list.clientHeight) >= list.scrollHeight
  const canConsume =
    list.scrollHeight > list.clientHeight &&
    ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom))
  if (canConsume) return

  const main = document.querySelector<HTMLElement>('[data-main-scroll]')
  if (main && main.scrollHeight > main.clientHeight) {
    main.scrollTop += e.deltaY
  }
}

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
  // Native folder picker: only offered to local clients on a system with a
  // dialog tool (the daemon checks both). `browsing` is true while the OS
  // dialog is open and we're awaiting the user's pick.
  const [pickerAvailable, setPickerAvailable] = useState(false)
  const [browsing, setBrowsing] = useState(false)
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

  useEffect(() => {
    let cancelled = false
    void folderPickerAvailable().then((a) => {
      if (!cancelled) setPickerAvailable(a)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Open the native OS folder dialog, then add the picked project immediately.
  async function handleBrowse() {
    if (browsing) return
    setBrowsing(true)
    setAddError(null)
    try {
      const res = await openFolderPicker()
      if (res.cancelled || !res.path) return
      await onAddProject(res.path)
      setShowAddInput(false)
      setOpen(false)
    } catch (err) {
      setAddError(formatError(err))
    } finally {
      setBrowsing(false)
    }
  }

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
            {pickerAvailable && !showAddInput && (
              <>
                <button
                  onClick={handleBrowse}
                  disabled={browsing}
                  className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer text-left text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-default"
                >
                  <FolderOpen className="w-3 h-3" />
                  {browsing ? 'Waiting for folder…' : 'Browse…'}
                </button>
                {addError && (
                  <p className="text-[10px] text-red-500 px-3 pb-1 leading-snug">{addError}</p>
                )}
              </>
            )}
            {!showAddInput ? (
              <button
                onClick={() => { setShowAddInput(true); setAddError(null) }}
                className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer text-left text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <Plus className="w-3 h-3" />
                {pickerAvailable ? 'Enter path manually…' : 'Open folder…'}
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

// Theme preference: an explicit light/dark choice, or `system` to follow the OS
// `prefers-color-scheme` and react to changes while the app is open.
type ThemeMode = 'light' | 'dark' | 'system'
// Cycle order used by the header selector button.
const NEXT_THEME_MODE: Record<ThemeMode, ThemeMode> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
}
const THEME_MODE_ICON: Record<ThemeMode, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
}
const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
}

function loadThemeMode(): ThemeMode {
  const stored = readLocal(StorageKeys.themeMode)
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  // Migrate the legacy boolean preference (`hydra-dark-mode`) if present.
  const legacy = readLocal(StorageKeys.darkModeLegacy)
  if (legacy !== null) return legacy === 'true' ? 'dark' : 'light'
  return 'system'
}

// Derive the current view from the active route so it can be persisted as the
// project's last-open view. Agent routes set agentId; the repository browser is
// recognised by its path (and its splat preserved so a deep file path restores);
// anything else is the bare project page.
function currentViewFromRoute(projectId: string, agentId: string | undefined, pathname: string): ProjectView {
  if (agentId != null) return { kind: 'agent', agentId }
  const repoBase = `/project/${projectId}/repository`
  if (pathname === repoBase || pathname.startsWith(`${repoBase}/`)) {
    const path = pathname.startsWith(`${repoBase}/`)
      ? decodeURIComponent(pathname.slice(repoBase.length + 1))
      : ''
    return { kind: 'repository', path }
  }
  return { kind: 'project' }
}

function RootLayout() {
  const spawnedAt = useRef<number | null>(null)
  // Guards the one-time redirect from the bare root path to the selected
  // project (see effect below).
  const didAutoNavigate = useRef(false)
  const [, setTick] = useState(0)
  const [development, setDevelopment] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadThemeMode)
  // Which projects the user has trusted, mirrored from localStorage so the trust
  // prompt re-evaluates reactively when one is accepted (see lib/storage).
  const [trustedProjectIds, setTrustedProjectIds] = useState<Set<string>>(() => readTrustedProjects())

  const { projects, selectedProjectId, setProjects, setSelectedProjectId, setSystemStatus } = useProjectStore()
  const { agents, setAgents, addAgent } = useAgentStore()
  const dialog = useDialogStore()
  const navigate = useNavigate()
  const location = useLocation()
  const routeParams = useParams({ strict: false }) as { projectId?: string; agentId?: string }
  const currentProjectId = routeParams.projectId ?? selectedProjectId
  const selectedAgentId = routeParams.agentId

  // Navigate to a project's remembered view (agent / repository / bare project).
  // Used by the boot restore and the project-switch dropdown. A remembered agent
  // that no longer exists is corrected to the project page once that project's
  // agents load (see the persist effect below), so it's safe to route to it
  // optimistically here without first waiting for the agent list.
  const navigateToProjectView = useCallback((projectId: string, view: ProjectView) => {
    if (view.kind === 'agent') {
      navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId, agentId: view.agentId } })
    } else if (view.kind === 'repository' && view.path) {
      navigate({ to: '/project/$projectId/repository/$', params: { projectId, _splat: view.path } })
    } else if (view.kind === 'repository') {
      navigate({ to: '/project/$projectId/repository', params: { projectId } })
    } else {
      navigate({ to: '/project/$projectId', params: { projectId } })
    }
  }, [navigate])

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = readLocal(StorageKeys.sidebarWidth)
    if (saved) return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, parseInt(saved, 10)))
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
      writeLocal(StorageKeys.sidebarWidth, String(sidebarWidthRef.current))
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  useEffect(() => {
    writeLocal(StorageKeys.themeMode, themeMode)
    writeLocal(StorageKeys.darkModeLegacy, null) // drop the migrated legacy key
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const isDark = themeMode === 'dark' || (themeMode === 'system' && mql.matches)
      document.documentElement.classList.toggle('dark', isDark)
    }
    apply()
    // In `system` mode, track OS preference changes live.
    if (themeMode === 'system') {
      mql.addEventListener('change', apply)
      return () => mql.removeEventListener('change', apply)
    }
  }, [themeMode])

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
              // Just record the selection; the redirect effect below moves the
              // UI onto the project's page if we're sitting on the root route.
              setSelectedProjectId(newId)
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

  // When the app lands on the bare root path ("/") but a project is already
  // selected — restored from localStorage, or auto-selected above — the index
  // route just shows "Select a project to get started" even though the dropdown
  // shows a project. Redirect onto that project's page once, on initial load.
  // Gated by a ref so a deliberate deselect (which navigates back to "/") is not
  // undone by the 10s status poll re-selecting a project.
  useEffect(() => {
    if (didAutoNavigate.current) return
    // Only redirect from the exact root path, never from /settings or a project route.
    if (window.location.pathname !== '/') {
      didAutoNavigate.current = true
      return
    }
    if (selectedProjectId != null && projects.some((p) => p.id === selectedProjectId)) {
      didAutoNavigate.current = true
      // Restore the view (agent / repository / project) last open in this
      // project. Read up front so the persist effect below — which momentarily
      // sees the bare project route — can't overwrite it before we navigate.
      navigateToProjectView(selectedProjectId, loadProjectView(selectedProjectId))
    }
  }, [selectedProjectId, projects, navigateToProjectView])

  // Persist the current view per project so switching back (or reloading)
  // restores it. Keyed off the actual route params (not currentProjectId, which
  // falls back to the stored project on "/" and would let this overwrite the
  // memory before the boot restore above runs). Single writer for the three view
  // kinds: agent, repository (path included), and the bare project page.
  //
  // A remembered agent that's been killed/merged (possibly in another session)
  // is detected here once the project's agents have loaded: we drop the memory
  // to the project page AND redirect off the dead agent so you never get stuck
  // on "Agent Not Found".
  useEffect(() => {
    const projectId = routeParams.projectId
    if (!projectId) return // not on a project route ("/", "/settings") — leave storage alone
    const agentId = routeParams.agentId
    if (agentId == null) {
      // Repository browser or bare project page — persisted verbatim.
      saveProjectView(projectId, currentViewFromRoute(projectId, undefined, location.pathname))
      return
    }
    // `agents` is loaded for this project once every entry's project_path matches
    // it; until then (e.g. mid project-switch) keep the optimistic value.
    const proj = projects.find((p) => p.id === projectId)
    const agentsLoaded = proj != null && agents.length > 0 && agents.every((a) => a.project_path === proj.path)
    if (agentsLoaded && !agents.some((a) => a.id === agentId)) {
      saveProjectView(projectId, { kind: 'project' })
      navigate({ to: '/project/$projectId', params: { projectId } })
    } else {
      saveProjectView(projectId, { kind: 'agent', agentId })
    }
  }, [routeParams.projectId, routeParams.agentId, location.pathname, agents, projects, navigate])

  // Drop expired per-artifact and per-agent-view UI prefs once on boot.
  useEffect(() => { pruneArtifactPrefs(); pruneAgentViewPrefs() }, [])

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

  // A project's config.toml is read from the repo and can run code / weaken the
  // sandbox, so the UI prompts the user to review it the first time they open a
  // project. Trust is a client-side, one-time decision kept in localStorage, so
  // this shows until the user accepts; later config edits don't re-prompt.
  const untrustedProject = selectedProject && !trustedProjectIds.has(selectedProject.id) ? selectedProject : null

  function handleProjectTrusted() {
    if (!untrustedProject) return
    trustProject(untrustedProject.id)
    setTrustedProjectIds((prev) => new Set(prev).add(untrustedProject.id))
  }

  function handleTrustDeclined() {
    setSelectedProjectId(null)
    setAgents([])
    navigate({ to: '/' })
  }

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
            if (isOnSettings) {
              navigate({ to: '/project/$projectId/settings', params: { projectId: id } })
              return
            }
            // Restore the view (agent / repository / project) last open in the
            // project we're switching to, so it comes back rather than the bare
            // project page.
            navigateToProjectView(id, loadProjectView(id))
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
          <ClaudeUsageIndicator />
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
          <Tooltip content={`Theme: ${THEME_MODE_LABEL[themeMode]} (switch to ${THEME_MODE_LABEL[NEXT_THEME_MODE[themeMode]]})`}>
            <button
              onClick={() => setThemeMode((m) => NEXT_THEME_MODE[m])}
              className="w-7 h-7 flex items-center justify-center rounded-md cursor-pointer text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              {(() => {
                const Icon = THEME_MODE_ICON[themeMode]
                return <Icon className="w-5 h-5" />
              })()}
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

          {/* Repository view — sits between the spawn box and the agents list */}
          <div className="px-2 pt-2 pb-1 border-b border-gray-100 dark:border-gray-700">
            {currentProjectId ? (
              <Link
                to="/project/$projectId/repository"
                params={{ projectId: currentProjectId }}
                className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                activeProps={{ className: 'flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm font-medium bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' }}
              >
                <FolderGit2 className="w-4 h-4 shrink-0" />
                Repository
              </Link>
            ) : (
              <span className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm font-medium text-gray-400 dark:text-gray-600 cursor-not-allowed">
                <FolderGit2 className="w-4 h-4 shrink-0" />
                Repository
              </span>
            )}
          </div>

          <div className="px-3 py-3 border-b border-gray-100 dark:border-gray-700">
            <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Agents
            </span>
            <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">({filteredAgents.length})</span>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-0.5" onWheel={forwardSidebarWheelToMain}>
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
      <Toaster />
      {untrustedProject && (
        <TrustProjectModal
          project={untrustedProject}
          onTrusted={handleProjectTrusted}
          onCancel={handleTrustDeclined}
        />
      )}
    </div>
  )
}
