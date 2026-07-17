import { createRootRoute, Link, Outlet, useNavigate, useParams, useLocation } from '@tanstack/react-router'
import { useEffect, useRef, useState, useCallback, type WheelEvent } from 'react'
import { api } from '../stores/apiClient'
import { ensureReviewConfig, useProjectStore } from '../stores/projectStore'
import { useAgentStore } from '../stores/agentStore'
import { usePageActive } from '../lib/usePageActive'
import { useEventStream } from '../lib/useEventStream'
import { useAgentPolling } from '../lib/useAgentPolling'
import { usePushStatus } from '../lib/usePushStatus'
import { useSystemStatus } from '../lib/useSystemStatus'
import { useArchivedAgents } from '../lib/useArchivedAgents'
import { useGlobalShortcuts } from '../lib/useGlobalShortcuts'
import { ProjectSwitcher } from '../components/ProjectSwitcher'
import { touchProject } from '../lib/projectRecency'
import { useAgentNotifications } from '../lib/useAgentNotifications'
import type { AgentResponse } from '../api'
import { ApiError, ErrorResponse } from '../api'
import { apiErrorBody } from '../api/format_error'
import { ChevronDown, ChevronRight, FolderGit2, Settings, LoaderCircle, PanelLeftClose, PanelLeftOpen, RotateCw, ArrowUp, ArrowDown, RefreshCw } from 'lucide-react'
import { ProviderIcon } from '../components/ReviewControls'
import { useApplyTheme } from '../lib/theme'
import { useSidebarStore, SIDEBAR_DESKTOP_QUERY } from '../lib/sidebar'
import { useMediaQuery } from '../lib/layout'
import { useTopBarSlot } from '../lib/topBarSlot'
import { AgentSidebarItem } from '../components/AgentComponents'
import { Uptime } from '../components/LiveTime'
import { UncommittedChip } from '../components/UncommittedChip'
import { SpawnForm } from '../components/SpawnForm'
import { ProjectDropdown } from '../components/ProjectDropdown'
import { ProjectPathLabel } from '../components/ProjectPathLabel'

import { Dialog } from '../components/Dialog'
import { Toaster } from '../components/Toaster'
import { NotFound } from '../components/NotFound'
import { Tooltip } from '../components/Tooltip'
import { ClaudeUsageIndicator } from '../components/ClaudeUsageIndicator'
import { TrustProjectModal } from '../components/TrustProjectModal'
import { KeyboardShortcutsModal } from '../components/KeyboardShortcutsModal'

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => <NotFound />,
})

import { useDialogStore } from '../stores/dialogStore'
import { useToastStore } from '../stores/toastStore'
import { pruneArtifactPrefs } from '../lib/artifactPrefs'
import { pruneAgentViewPrefs } from '../lib/agentViewPrefs'
import { StorageKeys, readLocal, writeLocal, archivedCollapsedKey } from '../lib/storage'
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

const SIDEBAR_MIN = 160
const SIDEBAR_MAX = 600
const SIDEBAR_DEFAULT = 264

// When the agents sidebar can't consume a wheel event (no scrollbar, or already
// at the top/bottom edge), forward the scroll to the main content area (the
// archived page's single scroll container, or the split layout's inspector
// pane) so the wheel isn't swallowed by the sidebar's dead space.
function forwardSidebarWheelToMain(e: WheelEvent<HTMLDivElement>) {
  const list = e.currentTarget
  const atTop = list.scrollTop <= 0
  const atBottom = Math.ceil(list.scrollTop + list.clientHeight) >= list.scrollHeight
  const canConsume =
    list.scrollHeight > list.clientHeight &&
    ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom))
  if (canConsume) return

  const main = document.querySelector<HTMLElement>('[data-main-scroll], [data-inspector-scroll]')
  if (main && main.scrollHeight > main.clientHeight) {
    main.scrollTop += e.deltaY
  }
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
  // Guards the one-time redirect from the bare root path to the selected
  // project (see effect below).
  const didAutoNavigate = useRef(false)
  // When restoring a project view lands on the bare project page *because* the
  // remembered agent had unread changes (see restoreProjectView), this holds
  // that project id for one persist cycle so the deflection doesn't overwrite
  // the remembered agent with `{ kind: 'project' }`. The memory is kept so a
  // later switch back restores the agent once it's been read.
  const deflectedUnreadProject = useRef<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  // Sidebar visibility: the persisted desktop collapse preference and the
  // transient mobile panel state are independent flags (see lib/sidebar.ts), so
  // resizing across the breakpoint never pops the sidebar open. The top bar
  // hosts the show toggle; the sidebar's sync row hosts the hide toggle.
  const desktopCollapsed = useSidebarStore((s) => s.desktopCollapsed)
  const mobileSidebarOpen = useSidebarStore((s) => s.mobileOpen)
  const toggleSidebar = useSidebarStore((s) => s.toggle)
  const isDesktopViewport = useMediaQuery(SIDEBAR_DESKTOP_QUERY)
  // When adding a project, the user first reviews its repo-controlled
  // .hydra/config.toml (which can run code) before it's registered. This holds
  // the pending review; its callbacks resolve the in-flight add (see
  // handleAddProject). Trust is decided once, at add time - no client-side trust
  // state is kept, so opening an already-added project never re-prompts.
  const [trustPrompt, setTrustPrompt] = useState<{
    name: string
    path: string
    onTrusted: () => void
    onCancel: () => void
  } | null>(null)

  // Subscribe with per-field selectors (never the whole store): RootLayout owns
  // the entire app chrome, so a whole-store subscription would re-render the
  // sidebar, spawn box and every tooltip each time ANY store field changes -
  // which, while an agent is streaming output, is about once a second.
  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const setProjects = useProjectStore((s) => s.setProjects)
  const setSelectedProjectId = useProjectStore((s) => s.setSelectedProjectId)
  const agents = useAgentStore((s) => s.agents)
  const addAgent = useAgentStore((s) => s.addAgent)
  const markRead = useAgentStore((s) => s.markRead)
  const patchAgentTests = useAgentStore((s) => s.patchAgentTests)
  const archived = useAgentStore((s) => s.archived)
  const archivedLoading = useAgentStore((s) => s.archivedLoading)
  const archivedHasMore = useAgentStore((s) => s.archivedHasMore)
  const showDialog = useDialogStore((s) => s.show)
  const navigate = useNavigate()
  const location = useLocation()
  const routeParams = useParams({ strict: false }) as { projectId?: string; agentId?: string }
  const currentProjectId = routeParams.projectId ?? selectedProjectId
  const selectedAgentId = routeParams.agentId

  // Record every project you land on (via dropdown, switcher, direct nav, or
  // boot restore) so the Ctrl+` switcher can order by last-visited.
  useEffect(() => {
    if (currentProjectId) touchProject(currentProjectId)
  }, [currentProjectId])
  // Resolved [review] config for the current project, cached in the project
  // store (the agent page and settings load it too - ensureReviewConfig dedupes
  // concurrent fetches, so only one request runs). The sidebar uses its
  // browse_url for the forge web link next to Repository
  // (NON_LOCAL_INTEGRATION.md 3.8).
  const reviewConfig = useProjectStore((s) => (currentProjectId ? s.reviewConfigs[currentProjectId] : undefined))
  useEffect(() => {
    if (currentProjectId && !reviewConfig) void ensureReviewConfig(currentProjectId)
  }, [currentProjectId, reviewConfig])
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

  // Restore a project's remembered view when switching into it - but never
  // auto-open a remembered agent that currently has unread changes. Opening an
  // agent clears its unread dot (the auto-clear effect below), so silently
  // restoring an unread agent on a project switch would "read" a notification
  // the user never looked at. In that case land on the bare project page
  // instead; the agent stays in the sidebar (dot lit) for the user to open
  // deliberately, and its remembered view is preserved (deflectedUnreadProject)
  // so a later switch back restores it once read. A remembered agent that's
  // already read - or whose lookup fails (gone / offline) - is opened as before;
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
      } catch { /* lookup failed - fall through and open optimistically */ }
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
  // True while the user is dragging the resize handle. We suppress the
  // width/transform transition during a drag so the sidebar tracks the pointer
  // instantly instead of lagging 200ms behind it; the transition is only for the
  // collapse/expand animation.
  const [sidebarResizing, setSidebarResizing] = useState(false)
  // The Archived section's collapse state is per-project (long archives differ
  // wildly between projects) and persisted; collapsed by default so the rarely-
  // wanted archived history stays out of the way. Re-read it when the selected
  // project changes; absence of the key means collapsed, and only an explicit
  // '0' (the user expanded it) keeps it open.
  const [archivedCollapsed, setArchivedCollapsed] = useState(true)
  useEffect(() => {
    if (!currentProjectId) { setArchivedCollapsed(true); return }
    setArchivedCollapsed(readLocal(archivedCollapsedKey(currentProjectId)) !== '0')
  }, [currentProjectId])

  // Toggle + persist the per-project collapse state. Collapsing hides the whole
  // archived list, so if the currently open agent is an archived one it would
  // disappear from the sidebar while still showing - deselect it back to the
  // project page so the selection never points at a hidden item.
  const toggleArchivedCollapsed = useCallback(() => {
    if (!currentProjectId) return
    const next = !archivedCollapsed
    setArchivedCollapsed(next)
    // Collapsed is the default, so store nothing for it; only persist an explicit
    // expand ('0'). Toggling back to collapsed clears the key.
    writeLocal(archivedCollapsedKey(currentProjectId), next ? null : '0')
    if (next && selectedAgentId && archived.some((a) => a.id === selectedAgentId)) {
      navigate({ to: '/project/$projectId', params: { projectId: currentProjectId } })
    }
  }, [currentProjectId, archivedCollapsed, selectedAgentId, archived, navigate])

  // Pointer events (not mouse) so the drag works with touch + pen too - e.g. a
  // large phone in landscape where the sidebar is a persistent column rather
  // than the floating overlay. `touch-none` on the handle keeps the browser
  // from hijacking the gesture for scrolling.
  const handleSidebarResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidthRef.current

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    setSidebarResizing(true)

    function onMove(ev: PointerEvent) {
      const newWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + ev.clientX - startX))
      sidebarWidthRef.current = newWidth
      setSidebarWidth(newWidth)
    }
    function onUp() {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setSidebarResizing(false)
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

  // The four server-data loops - agent list, push status, archived history and
  // system status - are each owned by a dedicated hook built on useServerData
  // (PLAN #58). They land their data in the relevant store and expose stable
  // `refetch` handles + the bits of derived state RootLayout still renders; the
  // refetches are wired into the single events stream below so a push triggers a
  // fetch without restarting the hooks.
  const { refetchAgents } = useAgentPolling(currentProjectId)
  const { pushStatus, syncing, handleSync, committing, handleCommit, refetchPushStatus } = usePushStatus(currentProjectId)
  const { sentinelRef: archivedSentinelRef } = useArchivedAgents(currentProjectId)
  useAgentNotifications(currentProjectId, pageActive, selectedAgentId)
  const { refetchStatus, development, spawnedAt } = useSystemStatus()

  // Auto-clear an agent's unread dot when it's the one currently open AND the
  // page is actually in front of the user. Covers both opening an unread agent
  // (the click) and an already-open agent transitioning to waiting/finished
  // while you watch it (the next poll marks it unread, this clears it again).
  // If the page isn't active (backgrounded tab / unfocused window), we leave the
  // dot lit so the change isn't silently dismissed - `pageActive` is a dep, so
  // returning to the page re-runs this and clears it then. Optimistic locally +
  // a fire-and-forget POST.
  useEffect(() => {
    if (!pageActive || !currentProjectId || !selectedAgentId) return
    // Respect an explicit "mark as unread": that command sets an unread override
    // and only then navigates away, but the store update lands before the route
    // changes - so for one render the agent is still selected *and* freshly
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
  // small, consistent dot across platforms - Linux/Chrome draws emoji via Noto
  // Color Emoji as an oversized glossy ball that looks out of place in a tab.
  // We count the live (optimistically-cleared) agents for the current project
  // and trust the backend per-project counts for the others - so the dot tracks
  // the same state as the in-app indicators and clears the moment they do.
  const currentProjectUnread = agents.filter((a) => a.has_unread_changes).length
  const otherProjectsUnread = projects
    .filter((p) => p.id !== currentProjectId)
    .reduce((n, p) => n + (p.unread_count ?? 0), 0)
  const anyUnread = currentProjectUnread + otherProjectsUnread > 0
  // Build the rest of the title from the current view: project, then the open
  // agent (its title, falling back to id) or the repository browser. Computed as
  // primitive strings so the effect only fires when the displayed text changes.
  const currentProject = projects.find((p) => p.id === currentProjectId)
  const titleProjectName = currentProject?.name
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

  // Server-push: refetch agents / projects the moment the daemon signals a change,
  // instead of relying on the (now slow) fallback polls above. The stream also
  // fires once on connect, so selecting a project loads it immediately.
  useEventStream(currentProjectId, {
    onAgentsChanged: () => {
      refetchAgents()
      // A merge advances the project's branch, changing what's left to push.
      refetchPushStatus()
    },
    onProjectsChanged: () => refetchStatus(),
    // A background fetch found the branch's ahead/behind changed.
    onPushStatusChanged: () => refetchPushStatus(),
    // A streamed test run ticking: the event carries the new summary, so patch
    // the one agent's chip in place - no agent-list refetch.
    onAgentTestsChanged: (agentId, tests) => patchAgentTests(agentId, tests),
  })

  // When the app lands on the bare root path ("/") but a project is already
  // selected - restored from localStorage, or auto-selected above - the index
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
      // project. Read up front so the persist effect below - which momentarily
      // sees the bare project route - can't overwrite it before we navigate.
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
  // itself - it does a one-shot getAgent and, only if truly missing, redirects
  // off the dead agent and resets this memory to the project page.
  useEffect(() => {
    const projectId = routeParams.projectId
    if (!projectId) return // not on a project route ("/", "/settings") - leave storage alone
    const agentId = routeParams.agentId
    // The deflection from restoreProjectView lands on the bare project page,
    // but that isn't a deliberate navigation - skip it so the remembered agent
    // survives (one cycle only, then resume normal persistence). If the user
    // has already moved on to an agent, just drop the stale marker and persist
    // as usual.
    if (deflectedUnreadProject.current === projectId) {
      deflectedUnreadProject.current = null
      if (agentId == null) return
    }
    if (agentId == null) {
      // Repository browser or bare project page - persisted verbatim.
      saveProjectView(projectId, currentViewFromRoute(projectId, undefined, location.pathname))
      return
    }
    saveProjectView(projectId, { kind: 'agent', agentId })
  }, [routeParams.projectId, routeParams.agentId, location.pathname])

  // Drop expired per-artifact and per-agent-view UI prefs once on boot, plus
  // the retired split-layout opt-out key (the toggle is gone; split is always
  // on).
  useEffect(() => {
    pruneArtifactPrefs()
    pruneAgentViewPrefs()
    try { localStorage.removeItem('hydra-split-layout') } catch { /* storage unavailable */ }
  }, [])

  // Close the mobile sidebar panel on any navigation so it never lingers over
  // the content. mobileOpen is transient and mobile-only, so this can't touch
  // the desktop collapse preference - no breakpoint check needed.
  useEffect(() => {
    useSidebarStore.getState().closeMobile()
  }, [location.pathname])

  // App-wide keyboard shortcuts: Ctrl+. sidebar toggle, `?` help overlay, and the
  // Ctrl+` alt-tab project switcher - all merged into one hook. The switcher state
  // (projects in last-visited order + the highlighted index) is rendered by the
  // dedicated ProjectSwitcher overlay below.
  const { state: switcherState, setIndex: switcherSetIndex, commit: switcherCommit } =
    useGlobalShortcuts({ projects, currentProjectId, selectProject })

  async function handleRestart() {
    setRestarting(true)
    // Persistent (duration: 0) toast for the length of the rebuild + health poll,
    // mirroring the "Syncing with remote..." indicator. It stays up until the
    // page reloads below, which wipes it - so no success toast is needed.
    const toast = useToastStore.getState()
    const toastId = toast.show({ message: 'Restarting server...', type: 'info', duration: 0 })
    try {
      await api.default.devRestart()
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        toast.dismiss(toastId)
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

  // registerProject performs the actual add once the user has trusted the
  // project. On a missing / non-git directory it offers to create+init it, then
  // retries with those flags (no second trust prompt - the config was already
  // reviewed).
  const registerProject = useCallback(async function register(
    path: string,
    opts?: { create_if_missing?: boolean; init_git?: boolean },
  ): Promise<void> {
    try {
      const p = await api.default.addProject({ path, ...opts })
      const exists = projects.some((existing) => existing.id === p.id)
      if (!exists) {
        setProjects([...projects, p])
      }
      setSelectedProjectId(p.id)
      const isOnSettings = window.location.pathname.endsWith('/settings')
      navigate({ to: isOnSettings ? '/project/$projectId/settings' : '/project/$projectId', params: { projectId: p.id } })
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        const errorType = apiErrorBody(err)?.error
        const isNotFound = errorType === ErrorResponse.error.PATH_NOT_FOUND
        const isNotGit = errorType === ErrorResponse.error.NOT_A_GIT_REPO

        if (isNotFound || isNotGit) {
          return new Promise<void>((resolve, reject) => {
            showDialog({
              title: isNotFound ? 'Directory Not Found' : 'Not a Git Repository',
              message: isNotFound
                ? `The directory "${path}" does not exist. Do you want to create it and initialize a git repository?`
                : `The directory "${path}" is not a git repository. Do you want to initialize one?`,
              type: 'confirm',
              showCancel: true,
              onConfirm: () => {
                register(path, { create_if_missing: isNotFound, init_git: true }).then(resolve, reject)
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
  }, [projects, setProjects, setSelectedProjectId, navigate, showDialog])

  // Adding a project reads its .hydra/config.toml from the repo and, once
  // registered, starts its [[services]] - both of which can run code. So the
  // user reviews and trusts the config *before* we register it. Trust is decided
  // here, once, at add time; there is no persisted trust state, so opening an
  // already-added project never re-prompts. Declining leaves nothing registered.
  const handleAddProject = useCallback(async (path: string) => {
    const name = path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path
    const trusted = await new Promise<boolean>((resolve) => {
      setTrustPrompt({
        name,
        path,
        onTrusted: () => {
          setTrustPrompt(null)
          resolve(true)
        },
        onCancel: () => {
          setTrustPrompt(null)
          resolve(false)
        },
      })
    })
    if (!trusted) return
    await registerProject(path)
  }, [registerProject])

  const handleSpawned = useCallback((agent: AgentResponse) => {
    addAgent(agent)
    // Spawn in the background: only jump to the new agent if the user isn't
    // already focused on one. When an agent is open, leave it in front so a
    // spawn from the sidebar doesn't yank them away from their current work -
    // the new agent just appears in the list. If nothing is selected (e.g. the
    // project home / repository view), select it so the spawn isn't a no-op.
    if (currentProjectId && !selectedAgentId) {
      navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId: currentProjectId, agentId: agent.id } })
    }
  }, [addAgent, currentProjectId, selectedAgentId, navigate])

  // One shared deselect handler for every sidebar row (clicking the already-open
  // agent toggles back to the project home). Stable so the memo()'d rows don't
  // re-render just because RootLayout did.
  const handleAgentDeselect = useCallback(() => {
    if (currentProjectId) navigate({ to: '/project/$projectId', params: { projectId: currentProjectId } })
  }, [currentProjectId, navigate])

  // Deselect the project entirely (dropdown "deselect" action).
  const handleProjectDeselect = useCallback(() => {
    setSelectedProjectId(null)
    navigate({ to: '/' })
  }, [setSelectedProjectId, navigate])

  const filteredAgents = agents.filter((a) => !a.ephemeral)

  // Breadcrumb shown in the top bar after the "/" on non-agent pages. Agent
  // pages portal their own status/title/actions into the slot instead
  // (TopBarPortal), so the crumb stays out of their way.
  const crumb = selectedAgentId
    ? null
    : onRepository
      ? 'Repository'
      : /\/settings(\/|$)/.test(location.pathname)
        ? 'Settings'
        : null

  // The top bar's route-content slot element, registered into a store so route
  // content can portal into it from an unrelated router subtree.
  const registerTopBarSlot = useCallback((el: HTMLDivElement | null) => {
    useTopBarSlot.getState().setEl(el)
  }, [])

  // Whether the sidebar is on screen for the current breakpoint - drives the
  // top bar toggle's icon/tooltip. On desktop the toggle only renders while
  // the sidebar is hidden (the sidebar's own sync row hosts the hide button);
  // on mobile it stays as a true toggle.
  const sidebarVisible = isDesktopViewport ? !desktopCollapsed : mobileSidebarOpen

  return (
    <div className="h-full bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 flex flex-col overflow-hidden">
      {/* Global top bar: sidebar toggle (while hidden), project icon + selector,
          then the route's slice after the "/". The agent page portals its status
          dot, title and action toolbar into the slot (TopBarPortal); the
          repository browser and settings render a static crumb. */}
      <header className="shrink-0 h-12 flex items-center gap-1.5 px-2 sm:px-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        {(!isDesktopViewport || desktopCollapsed) && (
          <Tooltip content={`${sidebarVisible ? 'Hide' : 'Show'} sidebar (Ctrl+.)`}>
            <button
              type="button"
              aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
              onClick={toggleSidebar}
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
            >
              {sidebarVisible ? <PanelLeftClose className="w-5 h-5" /> : <PanelLeftOpen className="w-5 h-5" />}
            </button>
          </Tooltip>
        )}
        <ProjectDropdown
          projects={projects}
          selectedId={currentProjectId}
          // Restore the view (agent / repository / project) last open in the
          // project we're switching to (see selectProject / restoreProjectView).
          onSelect={selectProject}
          onDeselect={handleProjectDeselect}
          onAddProject={handleAddProject}
        />
        {(selectedAgentId != null || crumb != null) && (
          <span aria-hidden className="shrink-0 text-gray-300 dark:text-gray-600 select-none">/</span>
        )}
        <div ref={registerTopBarSlot} className="flex-1 min-w-0 flex items-center gap-2">
          {crumb != null && (
            <span className="min-w-0 truncate text-sm font-semibold text-gray-800 dark:text-gray-100 px-1">
              {crumb}
            </span>
          )}
        </div>
      </header>

      {/* Content row below the bar: sidebar + routed page. relative so the
          mobile sidebar panel can cover exactly this region (the bar stays). */}
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
      {/* Sidebar: a persistent, resizable column at md+; below that a
          full-screen panel over the content row (its own screen - the top bar
          stays visible above it). Collapsing animates: at md+ the column's
          width tweens to 0 (the inner content keeps its full width and is
          clipped by overflow-hidden, so it slides away cleanly without
          reflowing); the mobile panel slides off-canvas via translate. The top
          bar's toggle reveals it again. */}
      <aside
        style={{ width: desktopCollapsed ? 0 : sidebarWidth }}
        className={`relative overflow-hidden max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:!w-full bg-white dark:bg-gray-800 flex shrink-0 ${sidebarResizing ? '' : 'transition-[width,transform] duration-200'} ${mobileSidebarOpen ? 'translate-x-0' : 'max-md:-translate-x-full'}`}
      >
        {/* Inner content at a fixed width (the expanded sidebar width, or the full
            panel width below md) so the collapse width-tween clips it instead of
            squishing/reflowing every row. shrink-0 keeps it from shrinking with the
            aside; the right border rides its trailing edge. */}
        <div
          style={{ width: sidebarWidth }}
          className="flex flex-col h-full shrink-0 max-md:!w-full border-r border-gray-200 dark:border-gray-700"
        >
          {/* Repository view + Sync - above the spawn box, adjacent to the project
              selector it describes: context (repo/branch/sync) -> action (spawn)
              -> results (agents list). NON_LOCAL_INTEGRATION.md 3.8. */}
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
                  ? 'Syncing...'
                  : !pushStatus
                    ? 'Sync with remote'
                    : !pushStatus.has_remote
                      ? 'No remote to sync with'
                      : !pushStatus.branch
                        ? 'Detached HEAD - cannot sync'
                        : behind > 0 && ahead > 0
                          ? `Sync: pull ${behind}, push ${ahead}`
                          : behind > 0
                            ? `Pull ${behind} commit${behind === 1 ? '' : 's'} from ${remote}`
                            : ahead > 0
                              ? `Push ${ahead} commit${ahead === 1 ? '' : 's'} to ${remote}`
                              : `Up to date with ${remote}`
                return (
                  <div className="flex items-center gap-1.5">
                    <Link
                      to="/project/$projectId/repository"
                      params={{ projectId: currentProjectId }}
                      aria-label="Repository"
                      onClick={(e) => {
                        if (repositoryActive) {
                          // Toggle off: left-clicking the active Repository button
                          // returns to the project home screen, mirroring agent
                          // deselection. Middle/Ctrl-click ignore this and open the
                          // repository in a new tab (it's a real link).
                          e.preventDefault()
                          navigate({ to: '/project/$projectId', params: { projectId: currentProjectId } })
                        }
                      }}
                      className={
                        repositoryActive
                          ? 'flex-1 min-w-0 flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm font-medium cursor-pointer bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                          : 'flex-1 min-w-0 flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm font-medium cursor-pointer text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors'
                      }
                    >
                      <FolderGit2 className="w-4 h-4 shrink-0" />
                      {/* The label is the project's path (HOME abbreviated to
                          "~" server-side), middle-elided to fit the row - see
                          ProjectPathLabel. Falls back to "Repository" until
                          the project list has loaded. */}
                      {currentProject ? (
                        <ProjectPathLabel
                          path={currentProject.display_path ?? currentProject.path}
                          title={currentProject.path}
                        />
                      ) : (
                        <span className="truncate">Repository</span>
                      )}
                    </Link>
                    {/* Forge web link, derived from the remote URL (read-only, no
                        auth - NON_LOCAL_INTEGRATION.md 3.8). Hidden when there is
                        no remote or no https browse URL could be derived. */}
                    {reviewConfig?.browse_url && (
                      <Tooltip
                        content={`Open on ${reviewConfig.provider === 'github' ? 'GitHub' : reviewConfig.provider === 'gitlab' ? 'GitLab' : 'the forge'}`}
                        // ml-1/-mr-1 shifts the forge glyph rightward within the
                        // uniform gap-1.5 row: a touch more air after "Repository",
                        // a touch less before the status chips.
                        className="shrink-0 ml-1 -mr-1"
                      >
                        <a
                          href={reviewConfig.browse_url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label="Open repository on the forge"
                          className="inline-flex items-center p-1.5 rounded-lg text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                        >
                          <ProviderIcon provider={reviewConfig.provider} className="w-4 h-4 shrink-0" />
                        </a>
                      </Tooltip>
                    )}
                    {/* Uncommitted-changes warning: the project checkout is dirty
                        (e.g. a Settings save rewrote .hydra/config.toml). Click to
                        review the paths and commit them all. */}
                    {pushStatus && pushStatus.uncommitted.total > 0 && (
                      <UncommittedChip
                        uncommitted={pushStatus.uncommitted}
                        committing={committing}
                        onCommit={handleCommit}
                      />
                    )}
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
                    {/* Hide-sidebar toggle, at the row's trailing edge (the show
                        toggle lives in the global top bar). */}
                    <Tooltip content="Hide sidebar (Ctrl+.)" className="shrink-0">
                      <button
                        type="button"
                        aria-label="Hide sidebar"
                        onClick={toggleSidebar}
                        className="inline-flex items-center p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
                      >
                        <PanelLeftClose className="w-4 h-4 shrink-0" />
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
                <Tooltip content="Hide sidebar (Ctrl+.)" className="shrink-0">
                  <button
                    type="button"
                    aria-label="Hide sidebar"
                    onClick={toggleSidebar}
                    className="inline-flex items-center p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
                  >
                    <PanelLeftClose className="w-4 h-4 shrink-0" />
                  </button>
                </Tooltip>
              </div>
            )}
          </div>

          <SpawnForm compact projectId={currentProjectId} onSpawned={handleSpawned} disabled={!currentProjectId} />

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
              currentProjectId && filteredAgents.map((agent) => (
                <AgentSidebarItem
                  key={agent.id}
                  agent={agent}
                  selected={agent.id === selectedAgentId}
                  projectId={currentProjectId}
                  onDeselect={handleAgentDeselect}
                />
              ))
            )}

            {/* Archived (killed/merged) history - read-only, paginated and loaded
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
                      projectId={currentProjectId}
                      onDeselect={handleAgentDeselect}
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

          {/* Sidebar footer - a single row: restart (icon) + uptime on the left,
              Claude usage + Settings (icon) on the right. The theme switcher now
              lives inside Settings, not here. */}
          <div className="border-t border-gray-200 dark:border-gray-700 px-2 py-2 flex items-center gap-1.5 shrink-0">
            {development && (
              <Tooltip content={restarting ? 'Restarting...' : 'Rebuild and restart the server'}>
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
                  <Uptime spawnedAt={spawnedAt.current} format={formatUptime} />
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
              // While on Settings, the button acts as a toggle: clicking it again
              // deselects Settings and returns to the project page (or the root
              // when no project is selected).
              return (
                <Tooltip content={settingsActive ? 'Close settings' : 'Settings'}>
                  {settingsActive ? (
                    <button
                      type="button"
                      aria-label="Close settings"
                      className={cls}
                      onClick={() => {
                        if (currentProjectId) {
                          navigate({ to: '/project/$projectId', params: { projectId: currentProjectId } })
                        } else {
                          navigate({ to: '/' })
                        }
                      }}
                    >
                      <Settings className="w-5 h-5 shrink-0" />
                    </button>
                  ) : currentProjectId ? (
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
        </div>

          {/* Resize handle (lg+ only - the overlay sidebar has a fixed width) */}
          <div
            onPointerDown={handleSidebarResizeStart}
            className="hidden md:flex absolute right-0 top-0 bottom-0 w-3 -mr-1 cursor-col-resize z-10 group items-stretch justify-center touch-none"
          >
            <div className="w-px group-hover:bg-blue-400/60 group-active:bg-blue-500 transition-colors" />
          </div>
        </aside>

        <div className="flex-1 flex min-w-0 overflow-hidden">
          <Outlet />
        </div>
      </div>
      <Dialog />
      <Toaster />
      <KeyboardShortcutsModal />
      <ProjectSwitcher state={switcherState} onHover={switcherSetIndex} onSelect={switcherCommit} />
      {trustPrompt && (
        <TrustProjectModal
          name={trustPrompt.name}
          path={trustPrompt.path}
          onTrusted={trustPrompt.onTrusted}
          onCancel={trustPrompt.onCancel}
        />
      )}
    </div>
  )
}
