import { createRootRoute, Link, Outlet, useNavigate, useParams, useLocation } from '@tanstack/react-router'
import { useEffect, useRef, useState, useCallback, type WheelEvent } from 'react'
import { api } from '../stores/apiClient'
import { useProjectStore } from '../stores/projectStore'
import { useAgentStore, ARCHIVED_PAGE_SIZE } from '../stores/agentStore'
import { usePageActive } from '../lib/usePageActive'
import { startVisibilityPolling } from '../lib/visibilityPolling'
import { useEventStream } from '../lib/useEventStream'

// Fallback poll interval used as a safety net behind the events WebSocket: pushes
// drive refetches immediately, but a slow periodic poll still recovers if the
// socket is briefly down or an event is missed. Much lighter than the old 5–10s.
const EVENT_FALLBACK_MS = 30_000
import type { ProjectInfo, AgentResponse, RepositoryPushStatus } from '../api'
import { ApiError, ErrorResponse } from '../api'
import { formatError } from '../api/format_error'
import { ChevronDown, ChevronRight, Folder, FolderGit2, FolderOpen, Plus, Settings, Check, X, LoaderCircle, AlertTriangle, PanelLeftClose, PanelLeftOpen, RotateCw, ArrowUp, ArrowDown, RefreshCw } from 'lucide-react'
import { useApplyTheme } from '../lib/theme'
import { useSidebarStore, SIDEBAR_OVERLAY_QUERY } from '../lib/sidebar'
import { folderPickerAvailable, openFolderPicker } from '../api/folderPicker'
import { AgentSidebarItem } from '../components/AgentComponents'
import { SpawnForm } from '../components/SpawnForm'

import { Dialog } from '../components/Dialog'
import { Toaster } from '../components/Toaster'
import { NotFound } from '../components/NotFound'
import { Tooltip } from '../components/Tooltip'
import { ClaudeUsageIndicator } from '../components/ClaudeUsageIndicator'
import { TrustProjectModal } from '../components/TrustProjectModal'
import { KeyboardShortcutsModal } from '../components/KeyboardShortcutsModal'
import { useShortcutsStore } from '../stores/shortcutsStore'
import { isTypingTarget } from '../lib/shortcuts'
import { useFinePointer } from '../lib/useFinePointer'

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => <NotFound />,
})

import { useDialogStore } from '../stores/dialogStore'
import { useToastStore } from '../stores/toastStore'
import { pruneArtifactPrefs } from '../lib/artifactPrefs'
import { pruneAgentViewPrefs } from '../lib/agentViewPrefs'
import { StorageKeys, readLocal, writeLocal, readTrustedProjects, trustProject, archivedCollapsedKey } from '../lib/storage'
import { loadProjectView, saveProjectView, type ProjectView } from '../lib/projectView'

// Server uptime, rendered as "up 2 hours" (the exact spawn time is in the
// tooltip). Mirrors a process "uptime" rather than the old "Spawned X ago".
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return 'up <1 min'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `up ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `up ${hours} ${hours === 1 ? 'hour' : 'hours'}`
  const days = Math.floor(hours / 24)
  return `up ${days} ${days === 1 ? 'day' : 'days'}`
}

// Project-switch shortcut hint. We bind Ctrl (not Cmd) on every platform,
// including macOS: macOS reserves Cmd+` for its own "cycle windows within an
// app", so it never reaches the page — Ctrl+` is free there and keeps one
// binding everywhere.
const SWITCH_PROJECT_HINT = 'Hold Ctrl, tap ` to switch · ⇧ for previous'

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

// ── Service Health Warning ─────────────────────────────────────────────────────
// Polls the selected project's service status and shows a warning icon (next to
// the project name) when any supervised service has failed. Tooltip lists them.

function ServiceHealthWarning({ projectId }: { projectId: string | null }) {
  const [failed, setFailed] = useState<string[]>([])
  const refetchRef = useRef<() => void>(() => {})

  useEffect(() => {
    setFailed([])
    if (!projectId) {
      refetchRef.current = () => {}
      return
    }
    let active = true
    const tick = async () => {
      try {
        const resp = await api.default.getServices(projectId)
        if (active) setFailed(resp.services.filter((s) => s.state === 'failed').map((s) => s.name))
      } catch {
        // best-effort
      }
    }
    refetchRef.current = () => void tick()
    const stop = startVisibilityPolling(() => void tick(), EVENT_FALLBACK_MS)
    return () => {
      active = false
      refetchRef.current = () => {}
      stop()
    }
  }, [projectId])

  // Refresh the failed-service indicator the instant a service's state changes.
  useEventStream(projectId, { onServicesChanged: () => refetchRef.current() })

  if (failed.length === 0) return null
  return (
    <span
      className="shrink-0 inline-flex"
      aria-label="service failure"
      title={`Service${failed.length > 1 ? 's' : ''} failed: ${failed.join(', ')}. Open Settings to restart.`}
    >
      <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
    </span>
  )
}

// ── Project Dropdown ───────────────────────────────────────────────────────────

function ProjectDropdown({
  projects,
  selectedId,
  onSelect,
  onDeselect,
  onAddProject,
  onRemoveProject,
  keyboardIndex,
}: {
  projects: ProjectInfo[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDeselect: () => void
  onAddProject: (path: string) => Promise<void>
  onRemoveProject: (id: string) => Promise<void>
  // Drives the Ctrl+` alt-tab switcher: when non-null the dropdown is forced open
  // and the row at this index is highlighted (committed on Ctrl release by the
  // handler in RootLayout). null = normal click-driven dropdown.
  keyboardIndex: number | null
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
  const activeRowRef = useRef<HTMLDivElement>(null)
  // The Ctrl+` switch hint is keyboard-only — hide it on touch devices.
  const finePointer = useFinePointer()

  // The Ctrl+` switcher forces the dropdown open and highlights a row; otherwise
  // it's the usual click-to-open menu.
  const keyboardActive = keyboardIndex !== null
  const isOpen = open || keyboardActive

  // Keep the keyboard-highlighted row in view as the user steps through a long
  // project list.
  useEffect(() => {
    if (keyboardActive) activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [keyboardIndex, keyboardActive])

  const selected = projects.find((p) => p.id === selectedId)
  // Unread agents sitting in projects other than the one you're looking at —
  // drives the dot on the folder button ("updates waiting elsewhere").
  const otherProjectsUnread = projects
    .filter((p) => p.id !== selectedId)
    .reduce((n, p) => n + (p.unread_count ?? 0), 0)

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
        aria-label="Select project"
        onClick={() => { setOpen((o) => !o); setShowAddInput(false); setAddError(null) }}
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-md text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors max-w-xs cursor-pointer"
      >
        <span className="relative shrink-0">
          <Folder className="w-3.5 h-3.5" />
          {otherProjectsUnread > 0 && (
            <span
              aria-label="updates waiting in other projects"
              className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-sky-400 ring-2 ring-white dark:ring-gray-900"
            />
          )}
        </span>
        <span className="truncate max-w-[160px]">{selected?.name ?? 'Select project'}</span>
        <ServiceHealthWarning projectId={selectedId} />
        <ChevronDown className="w-3 h-3" />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full mt-1 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 max-h-[70vh] overflow-y-auto">
          {projects.length > 0 && (
            <div className="py-1 border-b border-gray-100 dark:border-gray-700">
              {projects.map((p, i) => (
                <div
                  key={p.id}
                  ref={keyboardActive && i === keyboardIndex ? activeRowRef : undefined}
                  className={`relative flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
                    keyboardActive && i === keyboardIndex
                      ? 'bg-blue-100 dark:bg-blue-900/40'
                      : p.id === selectedId ? 'bg-blue-50 dark:bg-blue-900/20' : ''
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
                  {(p.unread_count ?? 0) > 0 && (
                    <span
                      aria-label={`${p.unread_count} agents with unread changes`}
                      className="shrink-0 mt-1.5 w-2 h-2 rounded-full bg-sky-500"
                    />
                  )}
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

          {projects.length > 1 && finePointer && (
            <div className="px-3 py-1.5 border-t border-gray-100 dark:border-gray-700 text-[10px] text-gray-400 dark:text-gray-500 font-mono">
              {SWITCH_PROJECT_HINT}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Root Layout ────────────────────────────────────────────────────────────────

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
  // When restoring a project view lands on the bare project page *because* the
  // remembered agent had unread changes (see restoreProjectView), this holds
  // that project id for one persist cycle so the deflection doesn't overwrite
  // the remembered agent with `{ kind: 'project' }`. The memory is kept so a
  // later switch back restores the agent once it's been read.
  const deflectedUnreadProject = useRef<string | null>(null)
  const [, setTick] = useState(0)
  const [development, setDevelopment] = useState(false)
  const [restarting, setRestarting] = useState(false)
  // Alt-tab-style project switcher: while Ctrl is held, each Ctrl+` press steps
  // the highlight through this overlay (Shift reverses); releasing Ctrl commits.
  // `null` = overlay closed; otherwise the highlighted index into `projects`.
  const [switcherIndex, setSwitcherIndex] = useState<number | null>(null)
  // The sidebar can be hidden on any screen size via the collapse button in its
  // header (revealed again by the floating button / agent top bar over the
  // content). On wide screens collapsing reclaims the space; below the overlay
  // breakpoint the sidebar is an off-canvas overlay, so collapsed means "closed".
  // State lives in a shared store so the agent page's top bar can host the toggle.
  const sidebarCollapsed = useSidebarStore((s) => s.collapsed)
  const toggleSidebar = useSidebarStore((s) => s.toggle)
  // Which projects the user has trusted, mirrored from localStorage so the trust
  // prompt re-evaluates reactively when one is accepted (see lib/storage).
  const [trustedProjectIds, setTrustedProjectIds] = useState<Set<string>>(() => readTrustedProjects())

  const { projects, selectedProjectId, setProjects, setSelectedProjectId, setSystemStatus } = useProjectStore()
  const { agents, setAgents, addAgent, markRead } = useAgentStore()
  const archived = useAgentStore((s) => s.archived)
  const archivedLoading = useAgentStore((s) => s.archivedLoading)
  const archivedHasMore = useAgentStore((s) => s.archivedHasMore)
  const resetArchived = useAgentStore((s) => s.resetArchived)
  const setArchivedLoading = useAgentStore((s) => s.setArchivedLoading)
  const setArchivedFirstPage = useAgentStore((s) => s.setArchivedFirstPage)
  const appendArchived = useAgentStore((s) => s.appendArchived)
  const dialog = useDialogStore()
  const navigate = useNavigate()
  const location = useLocation()
  const routeParams = useParams({ strict: false }) as { projectId?: string; agentId?: string }
  const currentProjectId = routeParams.projectId ?? selectedProjectId
  const selectedAgentId = routeParams.agentId
  // Whether the user actually has this page in front of them (foreground tab +
  // focused window). Gates the unread auto-clear so a backgrounded page doesn't
  // silently dismiss agents the user hasn't actually looked at.
  const pageActive = usePageActive()

  // Navigate to a project's remembered view (agent / repository / bare project).
  // Used by the boot restore and the project-switch dropdown. A remembered agent
  // that no longer exists is corrected to the project page by the agent page
  // itself (which redirects + resets the memory once a getAgent lookup confirms
  // it's truly gone), so it's safe to route to it optimistically here without
  // first waiting for the agent list.
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

  // Restore a project's remembered view when switching into it — but never
  // auto-open a remembered agent that currently has unread changes. Opening an
  // agent clears its unread dot (the auto-clear effect below), so silently
  // restoring an unread agent on a project switch would "read" a notification
  // the user never looked at. In that case land on the bare project page
  // instead; the agent stays in the sidebar (dot lit) for the user to open
  // deliberately, and its remembered view is preserved (deflectedUnreadProject)
  // so a later switch back restores it once read. A remembered agent that's
  // already read — or whose lookup fails (gone / offline) — is opened as before;
  // the agent page self-corrects a truly-dead one.
  const restoreProjectView = useCallback(async (projectId: string, view: ProjectView) => {
    if (view.kind === 'agent') {
      try {
        const agent = await api.default.getAgent(projectId, view.agentId)
        if (agent.has_unread_changes) {
          deflectedUnreadProject.current = projectId
          navigate({ to: '/project/$projectId', params: { projectId } })
          return
        }
      } catch { /* lookup failed — fall through and open optimistically */ }
    }
    navigateToProjectView(projectId, view)
  }, [navigate, navigateToProjectView])

  // Switch the active project: record the selection and route to its remembered
  // view (or stay on settings if that's the current page). Shared by the header
  // dropdown and the Ctrl/Cmd+` keyboard shortcut so both behave identically.
  const selectProject = useCallback((id: string) => {
    setSelectedProjectId(id)
    const isOnSettings = window.location.pathname.endsWith('/settings')
    if (isOnSettings) {
      navigate({ to: '/project/$projectId/settings', params: { projectId: id } })
      return
    }
    restoreProjectView(id, loadProjectView(id))
  }, [setSelectedProjectId, navigate, restoreProjectView])

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = readLocal(StorageKeys.sidebarWidth)
    if (saved) return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, parseInt(saved, 10)))
    return SIDEBAR_DEFAULT
  })
  const sidebarWidthRef = useRef(sidebarWidth)
  // The Archived section's collapse state is per-project (long archives differ
  // wildly between projects) and persisted; expanded by default. Re-read it when
  // the selected project changes; absence of the key means expanded.
  const [archivedCollapsed, setArchivedCollapsed] = useState(false)
  useEffect(() => {
    if (!currentProjectId) { setArchivedCollapsed(false); return }
    setArchivedCollapsed(readLocal(archivedCollapsedKey(currentProjectId)) === '1')
  }, [currentProjectId])

  // Toggle + persist the per-project collapse state. Collapsing hides the whole
  // archived list, so if the currently open agent is an archived one it would
  // disappear from the sidebar while still showing — deselect it back to the
  // project page so the selection never points at a hidden item.
  const toggleArchivedCollapsed = useCallback(() => {
    if (!currentProjectId) return
    const next = !archivedCollapsed
    setArchivedCollapsed(next)
    writeLocal(archivedCollapsedKey(currentProjectId), next ? '1' : null)
    if (next && selectedAgentId && archived.some((a) => a.id === selectedAgentId)) {
      navigate({ to: '/project/$projectId', params: { projectId: currentProjectId } })
    }
  }, [currentProjectId, archivedCollapsed, selectedAgentId, archived, navigate])

  // Pointer events (not mouse) so the drag works with touch + pen too — e.g. a
  // large phone in landscape where the sidebar is a persistent column rather
  // than the floating overlay. `touch-none` on the handle keeps the browser
  // from hijacking the gesture for scrolling.
  const handleSidebarResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidthRef.current

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    function onMove(ev: PointerEvent) {
      const newWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + ev.clientX - startX))
      sidebarWidthRef.current = newWidth
      setSidebarWidth(newWidth)
    }
    function onUp() {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      writeLocal(StorageKeys.sidebarWidth, String(sidebarWidthRef.current))
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [])

  // Apply the theme (`dark` class on <html>) from the shared theme store; the
  // control itself now lives on the Settings page.
  useApplyTheme()

  // Agent list for the selected project: refreshed by the events stream (below),
  // with a slow visibility-gated poll as a fallback. refetchAgentsRef lets the
  // event handler trigger a fetch without restarting this effect.
  const refetchAgentsRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!currentProjectId) {
      setAgents([])
      refetchAgentsRef.current = () => {}
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

    refetchAgentsRef.current = () => void fetchAgents()
    const stop = startVisibilityPolling(fetchAgents, EVENT_FALLBACK_MS)
    return () => {
      cancelled = true
      refetchAgentsRef.current = () => {}
      stop()
    }
  }, [currentProjectId, setAgents])

  // Clear agents when project deselected
  useEffect(() => {
    if (!currentProjectId) setAgents([])
  }, [currentProjectId, setAgents])

  // Push/pull status for the project's current branch: drives the sidebar Sync
  // button, which shows how far ahead/behind the remote the branch is and, when
  // clicked, pulls then pushes. Refreshed on the same slow poll as the agent
  // list, plus on demand after a sync or when the events stream reports a change.
  // refetchPushStatusRef lets those triggers fire a fetch without restarting it.
  const [pushStatus, setPushStatus] = useState<RepositoryPushStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const refetchPushStatusRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!currentProjectId) {
      setPushStatus(null)
      refetchPushStatusRef.current = () => {}
      return
    }

    let cancelled = false
    const projectId = currentProjectId

    async function fetchPushStatus() {
      try {
        const result = await api.default.getRepositoryPushStatus(projectId)
        if (!cancelled) setPushStatus(result)
      } catch {
        if (!cancelled) setPushStatus(null)
      }
    }

    refetchPushStatusRef.current = () => void fetchPushStatus()
    const stop = startVisibilityPolling(fetchPushStatus, EVENT_FALLBACK_MS)
    return () => {
      cancelled = true
      refetchPushStatusRef.current = () => {}
      stop()
    }
  }, [currentProjectId])

  const handleSync = useCallback(async () => {
    if (!currentProjectId || syncing) return
    const projectId = currentProjectId
    const toast = useToastStore.getState()
    setSyncing(true)
    const toastId = toast.show({ message: 'Syncing with remote…', type: 'info', duration: 0 })
    try {
      const result = await api.default.syncRepository(projectId)
      setPushStatus(result)
      toast.dismiss(toastId)
      const where = result.remote && result.branch ? ` with ${result.remote}/${result.branch}` : ''
      toast.show({ message: `Synced${where}`, type: 'success' })
    } catch (err) {
      toast.dismiss(toastId)
      // A 409 means the pull couldn't merge cleanly; surface it distinctly.
      const conflict = err instanceof ApiError && err.status === 409
      toast.show({
        message: conflict
          ? `Sync failed: pull conflicts — resolve in the repository, then retry`
          : `Sync failed: ${formatError(err)}`,
        type: 'error',
        duration: 6000,
      })
    } finally {
      setSyncing(false)
      refetchPushStatusRef.current()
    }
  }, [currentProjectId, syncing])

  // Archived (killed/merged) history list. Loaded lazily and paginated for
  // infinite scroll — it is historical, so unlike the live list it is not
  // polled. Reset + load the first page whenever the selected project changes.
  const archivedLoadingRef = useRef(false)
  useEffect(() => {
    resetArchived()
    if (!currentProjectId) return
    let cancelled = false
    archivedLoadingRef.current = true
    setArchivedLoading(true)
    api.default.listArchivedAgents(currentProjectId, ARCHIVED_PAGE_SIZE, 0)
      .then((page) => { if (!cancelled) setArchivedFirstPage(page) })
      .catch(() => { if (!cancelled) setArchivedLoading(false) })
      .finally(() => { archivedLoadingRef.current = false })
    return () => { cancelled = true }
  }, [currentProjectId, resetArchived, setArchivedLoading, setArchivedFirstPage])

  const loadMoreArchived = useCallback(() => {
    if (!currentProjectId || archivedLoadingRef.current) return
    const { archivedHasMore: hasMore, archived: current } = useAgentStore.getState()
    if (!hasMore) return
    archivedLoadingRef.current = true
    setArchivedLoading(true)
    api.default.listArchivedAgents(currentProjectId, ARCHIVED_PAGE_SIZE, current.length)
      .then((page) => appendArchived(page))
      .catch(() => setArchivedLoading(false))
      .finally(() => { archivedLoadingRef.current = false })
  }, [currentProjectId, setArchivedLoading, appendArchived])

  // Trigger the next archived page when the sentinel scrolls into view.
  const archivedSentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = archivedSentinelRef.current
    if (!el || !archivedHasMore) return
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreArchived()
    }, { rootMargin: '120px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [archivedHasMore, loadMoreArchived, archived.length])

  // Auto-clear an agent's unread dot when it's the one currently open AND the
  // page is actually in front of the user. Covers both opening an unread agent
  // (the click) and an already-open agent transitioning to waiting/finished
  // while you watch it (the next poll marks it unread, this clears it again).
  // If the page isn't active (backgrounded tab / unfocused window), we leave the
  // dot lit so the change isn't silently dismissed — `pageActive` is a dep, so
  // returning to the page re-runs this and clears it then. Optimistic locally +
  // a fire-and-forget POST.
  useEffect(() => {
    if (!pageActive || !currentProjectId || !selectedAgentId) return
    // Respect an explicit "mark as unread": that command sets an unread override
    // and only then navigates away, but the store update lands before the route
    // changes — so for one render the agent is still selected *and* freshly
    // unread, and without this guard we'd immediately clear it again (the POST
    // /unread → POST /read flip-flop). Skip auto-clear while the override holds.
    const unreadUntil = useAgentStore.getState().unreadUntil[selectedAgentId] ?? 0
    if (unreadUntil > Date.now()) return
    const sel = agents.find((a) => a.id === selectedAgentId)
    if (sel?.has_unread_changes) {
      markRead(selectedAgentId)
      api.default.markAgentRead(currentProjectId, selectedAgentId).catch(() => {})
    }
  }, [agents, selectedAgentId, currentProjectId, markRead, pageActive])

  // Reflect unread changes in the browser tab title with a leading dot, so a
  // backgrounded tab signals "something's waiting" without the page in focus.
  // We use a plain U+25CF glyph (not a color emoji like 🔵) so it renders as a
  // small, consistent dot across platforms — Linux/Chrome draws emoji via Noto
  // Color Emoji as an oversized glossy ball that looks out of place in a tab.
  // We count the live (optimistically-cleared) agents for the current project
  // and trust the backend per-project counts for the others — so the dot tracks
  // the same state as the in-app indicators and clears the moment they do.
  const currentProjectUnread = agents.filter((a) => a.has_unread_changes).length
  const otherProjectsUnread = projects
    .filter((p) => p.id !== currentProjectId)
    .reduce((n, p) => n + (p.unread_count ?? 0), 0)
  const anyUnread = currentProjectUnread + otherProjectsUnread > 0
  // Build the rest of the title from the current view: project, then the open
  // agent (its title, falling back to id) or the repository browser. Computed as
  // primitive strings so the effect only fires when the displayed text changes.
  const titleProjectName = projects.find((p) => p.id === currentProjectId)?.name
  const titleAgent = selectedAgentId ? agents.find((a) => a.id === selectedAgentId) : undefined
  const titleAgentName = titleAgent ? titleAgent.title || titleAgent.id : undefined
  const onRepository = /\/repository(\/|$)/.test(location.pathname)
  useEffect(() => {
    const parts = [anyUnread ? '● Hydra' : 'Hydra']
    if (titleProjectName) parts.push(titleProjectName)
    if (titleAgentName) parts.push(titleAgentName)
    else if (onRepository) parts.push('Repository')
    document.title = parts.join(' · ')
  }, [anyUnread, titleProjectName, titleAgentName, onRepository])

  // System status + project list: refreshed by the events stream, with a slow
  // visibility-gated fallback poll. refetchStatusRef lets the event handler
  // trigger a refresh without restarting the effect (which owns the uptime ticker).
  const refetchStatusRef = useRef<() => void>(() => {})
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

    refetchStatusRef.current = () => void fetchStatus()
    const stop = startVisibilityPolling(fetchStatus, EVENT_FALLBACK_MS)
    return () => {
      cancelled = true
      refetchStatusRef.current = () => {}
      stop()
      if (ticker !== null) clearInterval(ticker)
    }
  }, [setProjects, setSelectedProjectId])

  // Server-push: refetch agents / projects the moment the daemon signals a change,
  // instead of relying on the (now slow) fallback polls above. The stream also
  // fires once on connect, so selecting a project loads it immediately.
  useEventStream(currentProjectId, {
    onAgentsChanged: () => {
      refetchAgentsRef.current()
      // A merge advances the project's branch, changing what's left to push.
      refetchPushStatusRef.current()
    },
    onProjectsChanged: () => refetchStatusRef.current(),
    // A background fetch found the branch's ahead/behind changed.
    onPushStatusChanged: () => refetchPushStatusRef.current(),
  })

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
      restoreProjectView(selectedProjectId, loadProjectView(selectedProjectId))
    }
  }, [selectedProjectId, projects, restoreProjectView])

  // Persist the current view per project so switching back (or reloading)
  // restores it. Keyed off the actual route params (not currentProjectId, which
  // falls back to the stored project on "/" and would let this overwrite the
  // memory before the boot restore above runs). Single writer for the three view
  // kinds: agent, repository (path included), and the bare project page.
  //
  // Correcting a remembered-but-dead agent is deliberately NOT done here. A
  // killed/merged head is now a valid read-only *archived* page, so it must not
  // be bounced; and the only place that can distinguish a genuinely-gone agent
  // from an archived one whose record simply hasn't loaded into the sidebar list
  // yet (deep in the paginated history, or on a cold load) is the agent page
  // itself — it does a one-shot getAgent and, only if truly missing, redirects
  // off the dead agent and resets this memory to the project page.
  useEffect(() => {
    const projectId = routeParams.projectId
    if (!projectId) return // not on a project route ("/", "/settings") — leave storage alone
    const agentId = routeParams.agentId
    // The deflection from restoreProjectView lands on the bare project page,
    // but that isn't a deliberate navigation — skip it so the remembered agent
    // survives (one cycle only, then resume normal persistence). If the user
    // has already moved on to an agent, just drop the stale marker and persist
    // as usual.
    if (deflectedUnreadProject.current === projectId) {
      deflectedUnreadProject.current = null
      if (agentId == null) return
    }
    if (agentId == null) {
      // Repository browser or bare project page — persisted verbatim.
      saveProjectView(projectId, currentViewFromRoute(projectId, undefined, location.pathname))
      return
    }
    saveProjectView(projectId, { kind: 'agent', agentId })
  }, [routeParams.projectId, routeParams.agentId, location.pathname])

  // Drop expired per-artifact and per-agent-view UI prefs once on boot.
  useEffect(() => { pruneArtifactPrefs(); pruneAgentViewPrefs() }, [])

  // On small screens (overlay mode) close the sidebar on any navigation so it
  // never lingers over the content. This is transient — it does NOT persist, so
  // it can't clobber the wide-screen collapse preference (only the explicit
  // toggle writes storage). On wide screens the sidebar stays as the user left it.
  useEffect(() => {
    if (!window.matchMedia(SIDEBAR_OVERLAY_QUERY).matches) {
      useSidebarStore.getState().setCollapsed(true, false)
    }
  }, [location.pathname])

  // Ctrl/Cmd + . collapses or expands the sidebar from anywhere (mirrors the
  // collapse button). Treated as an explicit toggle, so it persists.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === '.') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar])

  // `?` toggles the keyboard-shortcuts help overlay from anywhere — except while
  // typing (a terminal, a form field), where `?` is just a character. No modifier
  // so it's as quick to reach as a real cheat-sheet key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      e.preventDefault()
      useShortcutsStore.getState().toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Alt-tab-style project switcher. Hold Ctrl and tap ` to open the project
  // dropdown (the same selector in the sidebar header) with the *next* project
  // highlighted; each further ` steps forward, Shift+` steps back (both wrap).
  // Releasing Ctrl commits the highlight; Escape or losing focus cancels. The
  // highlight index is fed to ProjectDropdown via its keyboardIndex prop, which
  // forces the dropdown open and styles the active row — so the switcher reuses
  // the real selector UI rather than a separate overlay. We reveal the sidebar
  // first (transient, non-persisted) so the dropdown is on screen when collapsed.
  // We bind Ctrl on every platform — macOS reserves Cmd+` for its own "cycle
  // windows within an app", so Cmd never reaches us; Ctrl+` is free there too,
  // keeping one binding everywhere. We match on e.code === 'Backquote' so it's
  // keyboard-layout independent (Shift+` is '~' on US layouts).
  //
  // selectProject is read through a ref so committing on Ctrl-up doesn't force
  // this listener to re-bind every render; the keydown/keyup handlers are
  // otherwise stable and use functional state updates.
  const selectProjectRef = useRef(selectProject)
  selectProjectRef.current = selectProject
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const currentProjectIdRef = useRef(currentProjectId)
  currentProjectIdRef.current = currentProjectId
  const switcherIndexRef = useRef(switcherIndex)
  switcherIndexRef.current = switcherIndex
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setSwitcherIndex(null) // no-op (React bails) if already closed
        return
      }
      if (e.code !== 'Backquote' || !e.ctrlKey || e.altKey || e.metaKey) return
      const list = projectsRef.current
      if (list.length < 2) return
      e.preventDefault()
      if (e.repeat) return // one step per physical press, not per auto-repeat
      // Reveal the sidebar (transient, non-persisted) so the dropdown the switcher
      // drives is actually on screen when the sidebar is collapsed.
      if (switcherIndexRef.current === null) useSidebarStore.getState().setCollapsed(false, false)
      const dir = e.shiftKey ? -1 : 1
      setSwitcherIndex((cur) => {
        // First press steps off the current project; later presses step off the
        // current highlight. With nothing selected, land on first/last.
        const base = cur ?? list.findIndex((p) => p.id === currentProjectIdRef.current)
        const start = base === -1 ? (dir === 1 ? -1 : 0) : base
        return (start + dir + list.length) % list.length
      })
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key !== 'Control') return
      const cur = switcherIndexRef.current
      if (cur === null) return
      setSwitcherIndex(null)
      const proj = projectsRef.current[cur]
      if (proj && proj.id !== currentProjectIdRef.current) selectProjectRef.current(proj.id)
    }
    function onBlur() { setSwitcherIndex(null) }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

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
    // Spawn in the background: only jump to the new agent if the user isn't
    // already focused on one. When an agent is open, leave it in front so a
    // spawn from the sidebar doesn't yank them away from their current work —
    // the new agent just appears in the list. If nothing is selected (e.g. the
    // project home / repository view), select it so the spawn isn't a no-op.
    if (currentProjectId && !selectedAgentId) {
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
    <div className="h-full bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 flex overflow-hidden">
      {/* Backdrop behind the sidebar overlay (small screens only, when open). */}
      {!sidebarCollapsed && (
        <div
          aria-hidden
          onClick={toggleSidebar}
          className="lg:hidden fixed inset-0 z-30 bg-black/40"
        />
      )}
      {/* Sidebar: a persistent, resizable column at lg+, an off-canvas overlay
          below that (so it never squeezes a tablet / landscape phone). With the
          top bar gone it now holds the whole app chrome: the project selector +
          collapse button in its header, the spawn box / repository / agents list
          in the middle, and settings + usage in its footer. Collapsed removes it
          from the flow (lg+) or slides it off-canvas (overlay); the floating
          button over the content reveals it again. */}
      <aside
        style={{ width: sidebarWidth }}
        className={`relative max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-40 max-lg:!w-[80vw] max-lg:!max-w-[20rem] max-lg:shadow-2xl bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex-col shrink-0 transition-transform duration-200 ${sidebarCollapsed ? 'hidden max-lg:flex max-lg:-translate-x-full' : 'flex translate-x-0'}`}
      >
        {/* Sidebar header — app icon, project selector, and the collapse button
            to its right. This is what replaced the global top bar. */}
        <div className="flex items-center gap-1 h-12 px-2 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <Link
            to={currentProjectId ? '/project/$projectId' : '/'}
            params={currentProjectId ? { projectId: currentProjectId } : {}}
            aria-label="Hydra home"
            className="shrink-0 w-7 h-7 flex items-center justify-center overflow-hidden rounded-sm"
          >
            <img className="w-6 h-6 object-cover object-center" srcSet="/icon.png, /icon.avif" src="/icon.png" alt="Hydra icon" />
          </Link>
          <div className="flex-1 min-w-0">
            <ProjectDropdown
              projects={projects}
              selectedId={currentProjectId}
              // Restore the view (agent / repository / project) last open in the
              // project we're switching to (see selectProject / restoreProjectView).
              onSelect={selectProject}
              onDeselect={() => {
                setSelectedProjectId(null)
                navigate({ to: '/' })
              }}
              onAddProject={handleAddProject}
              onRemoveProject={handleRemoveProject}
              keyboardIndex={switcherIndex}
            />
          </div>
          <Tooltip content="Hide sidebar (Ctrl+.)">
            <button
              type="button"
              aria-label="Hide sidebar"
              onClick={toggleSidebar}
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
            >
              <PanelLeftClose className="w-5 h-5" />
            </button>
          </Tooltip>
        </div>

          <SpawnForm compact projectId={currentProjectId} onSpawned={handleSpawned} disabled={!currentProjectId} />

          {/* Repository view + Sync — sit between the spawn box and the agents list */}
          <div className="px-2 pt-2 pb-1 border-b border-gray-100 dark:border-gray-700">
            {currentProjectId ? (
              (() => {
                const repositoryActive = /\/repository(\/|$)/.test(location.pathname)
                const ahead = pushStatus?.ahead ?? 0
                const behind = pushStatus?.behind ?? 0
                const canSync = (ahead > 0 || behind > 0) && !!pushStatus?.has_remote && !!pushStatus?.branch && !syncing
                const remote = pushStatus?.remote ?? 'remote'
                const statusTooltip = [
                  behind > 0 ? `${behind} behind` : null,
                  ahead > 0 ? `${ahead} ahead` : null,
                ].filter(Boolean).join(', ') + ` ${remote}`
                const syncTooltip = syncing
                  ? 'Syncing…'
                  : !pushStatus
                    ? 'Sync with remote'
                    : !pushStatus.has_remote
                      ? 'No remote to sync with'
                      : !pushStatus.branch
                        ? 'Detached HEAD — cannot sync'
                        : behind > 0 && ahead > 0
                          ? `Sync: pull ${behind}, push ${ahead}`
                          : behind > 0
                            ? `Pull ${behind} commit${behind === 1 ? '' : 's'} from ${remote}`
                            : ahead > 0
                              ? `Push ${ahead} commit${ahead === 1 ? '' : 's'} to ${remote}`
                              : `Up to date with ${remote}`
                return (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        if (repositoryActive) {
                          // Toggle off: clicking the active Repository button returns
                          // to the project home screen, mirroring agent deselection.
                          navigate({ to: '/project/$projectId', params: { projectId: currentProjectId } })
                        } else {
                          navigate({ to: '/project/$projectId/repository', params: { projectId: currentProjectId } })
                        }
                      }}
                      className={
                        repositoryActive
                          ? 'flex-1 min-w-0 flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm font-medium cursor-pointer bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                          : 'flex-1 min-w-0 flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm font-medium cursor-pointer text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors'
                      }
                    >
                      <FolderGit2 className="w-4 h-4 shrink-0" />
                      Repository
                    </button>
                    {/* Ahead/behind status indicator (read-only) */}
                    {(behind > 0 || ahead > 0) && (
                      <Tooltip content={statusTooltip} className="shrink-0">
                        <span className="flex items-center gap-1 text-xs font-medium tabular-nums text-gray-500 dark:text-gray-400 select-none">
                          {behind > 0 && (
                            <span className="flex items-center text-amber-600 dark:text-amber-400">
                              <ArrowDown className="w-3.5 h-3.5 shrink-0" />{behind}
                            </span>
                          )}
                          {ahead > 0 && (
                            <span className="flex items-center">
                              <ArrowUp className="w-3.5 h-3.5 shrink-0" />{ahead}
                            </span>
                          )}
                        </span>
                      </Tooltip>
                    )}
                    {/* Sync button (pull then push) */}
                    <Tooltip content={syncTooltip} className="shrink-0">
                      <button
                        type="button"
                        onClick={handleSync}
                        disabled={!canSync}
                        aria-label={syncTooltip}
                        className={
                          canSync
                            ? 'inline-flex items-center p-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer'
                            : 'inline-flex items-center p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-300 dark:text-gray-600 cursor-not-allowed'
                        }
                      >
                        <RefreshCw className={`w-4 h-4 shrink-0 ${syncing ? 'animate-spin' : ''}`} />
                      </button>
                    </Tooltip>
                  </div>
                )
              })()
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm font-medium text-gray-400 dark:text-gray-600 cursor-not-allowed">
                  <FolderGit2 className="w-4 h-4 shrink-0" />
                  Repository
                </span>
                <span className="inline-flex items-center p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-300 dark:text-gray-600 cursor-not-allowed">
                  <RefreshCw className="w-4 h-4 shrink-0" />
                </span>
              </div>
            )}
          </div>

          <div className="px-3 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center gap-1.5">
            <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 tracking-wide">
              Agents
            </span>
            <span className="text-xs text-gray-300 dark:text-gray-600">·</span>
            <span className="text-xs text-gray-400 dark:text-gray-500">{filteredAgents.length}</span>
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

            {/* Archived (killed/merged) history — read-only, paginated and loaded
                lazily as it scrolls into view (infinite scroll). */}
            {currentProjectId && archived.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={toggleArchivedCollapsed}
                  className="w-full flex items-center gap-1.5 px-1 pt-3 pb-1 mt-1 group cursor-pointer rounded-md transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/40"
                >
                  {archivedCollapsed ? (
                    <ChevronRight className="w-3 h-3 text-gray-400 dark:text-gray-500 shrink-0 transition-colors group-hover:text-gray-600 dark:group-hover:text-gray-300" />
                  ) : (
                    <ChevronDown className="w-3 h-3 text-gray-400 dark:text-gray-500 shrink-0 transition-colors group-hover:text-gray-600 dark:group-hover:text-gray-300" />
                  )}
                  <span className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 tracking-wide transition-colors group-hover:text-gray-600 dark:group-hover:text-gray-300">
                    Archived
                  </span>
                  <span className="text-[10px] text-gray-300 dark:text-gray-600">·</span>
                  <span className="text-[10px] text-gray-300 dark:text-gray-600">{archived.length}</span>
                  <div className="flex-1 h-px bg-gray-100 dark:bg-gray-700" />
                </button>
                {!archivedCollapsed &&
                  archived.map((agent) => (
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
                  ))}
              </>
            )}
            {/* Sentinel + spinner for archived infinite scroll. */}
            {currentProjectId && !archivedCollapsed && archivedHasMore && (
              <div ref={archivedSentinelRef} className="py-3 flex items-center justify-center">
                {archivedLoading && <LoaderCircle className="w-4 h-4 text-gray-400 animate-spin" />}
              </div>
            )}
          </div>

          {/* Sidebar footer — a single row: restart (icon) + uptime on the left,
              Claude usage + Settings (icon) on the right. The theme switcher now
              lives inside Settings, not here. */}
          <div className="border-t border-gray-200 dark:border-gray-700 px-2 py-2 flex items-center gap-1.5 shrink-0">
            {development && (
              <Tooltip content={restarting ? 'Restarting…' : 'Rebuild and restart the server'}>
                <button
                  onClick={handleRestart}
                  disabled={restarting}
                  aria-label="Restart server"
                  className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <RotateCw className={`w-4 h-4 ${restarting ? 'animate-spin' : ''}`} />
                </button>
              </Tooltip>
            )}
            {spawnedAt.current !== null && (
              <Tooltip content={`Spawned at ${new Date(spawnedAt.current).toUTCString()}`}>
                <span className="text-[11px] text-gray-400 dark:text-gray-500 cursor-default truncate">
                  {formatUptime(Date.now() - spawnedAt.current)}
                </span>
              </Tooltip>
            )}
            <div className="ml-auto shrink-0">
              <ClaudeUsageIndicator />
            </div>
            {(() => {
              const settingsActive = /\/settings(\/|$)/.test(location.pathname)
              const cls = settingsActive
                ? 'shrink-0 w-7 h-7 flex items-center justify-center rounded-lg cursor-pointer bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300'
                : 'shrink-0 w-7 h-7 flex items-center justify-center rounded-lg cursor-pointer text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors'
              return (
                <Tooltip content="Settings">
                  {currentProjectId ? (
                    <Link to="/project/$projectId/settings" params={{ projectId: currentProjectId }} aria-label="Settings" className={cls}>
                      <Settings className="w-5 h-5 shrink-0" />
                    </Link>
                  ) : (
                    <Link to="/settings" aria-label="Settings" className={cls}>
                      <Settings className="w-5 h-5 shrink-0" />
                    </Link>
                  )}
                </Tooltip>
              )
            })()}
          </div>

          {/* Resize handle (lg+ only — the overlay sidebar has a fixed width) */}
          <div
            onPointerDown={handleSidebarResizeStart}
            className="hidden lg:flex absolute right-0 top-0 bottom-0 w-3 -mr-1 cursor-col-resize z-10 group items-stretch justify-center touch-none"
          >
            <div className="w-px group-hover:bg-blue-400/60 group-active:bg-blue-500 transition-colors" />
          </div>
        </aside>

        {/* Main content. When the sidebar is collapsed a floating button at the
            top-left brings it back — except on pages that host the toggle in
            their own header bar (the agent page, the repository browser, and
            settings). */}
        {sidebarCollapsed && !selectedAgentId && !/\/(repository|settings)(\/|$)/.test(location.pathname) && (
          <Tooltip content="Show sidebar (Ctrl+.)">
            <button
              type="button"
              aria-label="Show sidebar"
              onClick={toggleSidebar}
              className="fixed top-2 left-2 z-30 w-9 h-9 flex items-center justify-center rounded-lg bg-white/90 dark:bg-gray-800/90 backdrop-blur border border-gray-200 dark:border-gray-700 shadow-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
            >
              <PanelLeftOpen className="w-5 h-5" />
            </button>
          </Tooltip>
        )}
        {/* The floating reveal button (when collapsed) just overlays the top-left
            corner — no reserved strip, so the content keeps the full width. */}
        <div className="flex-1 flex min-w-0 overflow-hidden">
          <Outlet />
        </div>
      <Dialog />
      <Toaster />
      <KeyboardShortcutsModal />
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
