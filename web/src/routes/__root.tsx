import { createRootRoute, Link, Outlet, useNavigate, useParams, useLocation } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState, useCallback, memo, type WheelEvent, type RefObject } from 'react'
import { api } from '../stores/apiClient'
import { ensureReviewConfig, useProjectStore, visibleProjects } from '../stores/projectStore'
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
import { useProjectFavicon } from '../lib/useProjectFavicon'
import type { AgentResponse } from '../api'
import { ApiError, ErrorResponse, ServerUpdatePhase } from '../api'
import { apiErrorBody } from '../api/format_error'
import { ChevronDown, ChevronRight, FolderGit2, GitBranch, Settings, LoaderCircle, Menu, PanelLeftClose, PanelLeftOpen, RotateCw, ArrowUp, ArrowDown, RefreshCw, X } from 'lucide-react'
import { ProviderIcon } from '../components/ReviewControls'
import { useApplyTheme } from '../lib/theme'
import { useApplyFonts } from '../lib/fontPrefs'
import { useSidebarStore, SIDEBAR_DESKTOP_QUERY } from '../lib/sidebar'
import { useMediaQuery } from '../lib/layout'
import { useTopBarSlot } from '../lib/topBarSlot'
import { AgentSidebarItem } from '../components/AgentComponents'
import { Uptime } from '../components/LiveTime'
import { ServerUpdateToast } from '../components/ServerUpdateToast'
import { connectUpdateStream, useServerUpdateStore } from '../stores/serverUpdateStore'
import { UncommittedChip } from '../components/UncommittedChip'
import { SpawnForm } from '../components/SpawnForm'
import { ProjectDropdown } from '../components/ProjectDropdown'
import { ProjectPathLabel } from '../components/ProjectPathLabel'
import { ResizeGrip } from '../components/ResizeGrip'

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
import { pruneReviewDrafts } from '../lib/reviewDrafts'
import { pruneAgentCaches } from '../lib/agentCache'
import { pruneBranchCaches } from '../lib/branchCache'
import { StorageKeys, readLocal, writeLocal, archivedCollapsedKey } from '../lib/storage'
import {
  loadProjectView,
  parseProjectView,
  saveProjectView,
  splitProjectHref,
  type ProjectViewRoute,
} from '../lib/projectView'

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

// The sidebar's live agent list (active + archived). Split out of RootLayout and
// given its OWN agent-store subscription so the rest of the shell - top bar,
// project path, forge/settings buttons, footer, resize handles, tooltips - no
// longer re-renders on the ~1/s agent-store refresh a working agent drives. This
// component still re-renders each tick (it shows live status), but its rows are
// memo'd AgentSidebarItems that skip untouched agents. All its props are stable
// across those ticks (ids, the collapse flag, the sentinel ref, the memo'd
// handlers), so a tick only re-renders here - not the whole layout.
const AgentSidebarList = memo(function AgentSidebarList({
  currentProjectId,
  selectedAgentId,
  archivedCollapsed,
  onToggleArchivedCollapsed,
  onDeselect,
  archivedSentinelRef,
}: {
  currentProjectId: string | null | undefined
  selectedAgentId: string | undefined
  archivedCollapsed: boolean
  onToggleArchivedCollapsed: () => void
  onDeselect: () => void
  archivedSentinelRef: RefObject<HTMLDivElement | null>
}) {
  // Select the raw arrays (stable identity across a no-op refresh via the store's
  // reconcileList) and filter in the body, so an unchanged refresh bails here too.
  const agents = useAgentStore((s) => s.agents)
  const archived = useAgentStore((s) => s.archived)
  const archivedLoading = useAgentStore((s) => s.archivedLoading)
  const archivedHasMore = useAgentStore((s) => s.archivedHasMore)
  const filteredAgents = agents.filter((a) => !a.ephemeral)
  return (
    <>
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
              onDeselect={onDeselect}
            />
          ))
        )}

        {/* Archived (killed/merged) history - read-only, paginated and loaded
            lazily as it scrolls into view (infinite scroll). */}
        {currentProjectId && archived.length > 0 && (
          <>
            <button
              type="button"
              onClick={onToggleArchivedCollapsed}
              className="w-full flex items-center gap-1.5 px-1 pt-3 pb-1 mt-1 group cursor-pointer rounded-md transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/40"
            >
              {archivedCollapsed ? (
                <ChevronRight className="w-3 h-3 text-gray-400 dark:text-gray-500 shrink-0 transition-colors group-hover:text-gray-600 dark:group-hover:text-gray-300" />
              ) : (
                <ChevronDown className="w-3 h-3 text-gray-400 dark:text-gray-500 shrink-0 transition-colors group-hover:text-gray-600 dark:group-hover:text-gray-300" />
              )}
              <span className="text-3xs font-semibold text-gray-400 dark:text-gray-500 tracking-wide transition-colors group-hover:text-gray-600 dark:group-hover:text-gray-300">
                Archived
              </span>
              <span className="text-3xs text-gray-300 dark:text-gray-600">·</span>
              <span className="text-3xs text-gray-300 dark:text-gray-600">{archived.length}</span>
              <div className="flex-1 h-px bg-gray-100 dark:bg-gray-700" />
            </button>
            {!archivedCollapsed &&
              archived.map((agent) => (
                <AgentSidebarItem
                  key={agent.id}
                  agent={agent}
                  selected={agent.id === selectedAgentId}
                  projectId={currentProjectId}
                  onDeselect={onDeselect}
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
    </>
  )
})

// ── Root Layout ────────────────────────────────────────────────────────────────

function RootLayout() {
  // Guards the one-time redirect from the bare root path to the selected
  // project (see effect below).
  const didAutoNavigate = useRef(false)
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
  const addAgent = useAgentStore((s) => s.addAgent)
  const markRead = useAgentStore((s) => s.markRead)
  const patchAgentTests = useAgentStore((s) => s.patchAgentTests)
  const patchAgentStatus = useAgentStore((s) => s.patchAgentStatus)
  const showDialog = useDialogStore((s) => s.show)
  const navigate = useNavigate()
  const location = useLocation()
  const routeParams = useParams({ strict: false }) as { projectId?: string; agentId?: string }
  const currentProjectId = routeParams.projectId ?? selectedProjectId
  const selectedAgentId = routeParams.agentId
  // Narrow slices of the agent store, so the layout re-renders only when one of
  // THESE derived values changes - not on every ~1/s agent refresh. The live
  // agent list itself lives in <AgentSidebarList>, which owns its own
  // subscription (see above), keeping the whole shell out of the per-tick churn.
  // - the selected agent's unread bit drives the auto-clear effect below;
  // - its display name and the project's unread count feed the tab title.
  const selectedAgentUnread = useAgentStore((s) =>
    selectedAgentId ? !!s.agents.find((a) => a.id === selectedAgentId)?.has_unread_changes : false,
  )
  const selectedAgentName = useAgentStore((s) => {
    if (!selectedAgentId) return undefined
    const a = s.agents.find((x) => x.id === selectedAgentId)
    return a ? a.title || a.id : undefined
  })
  const currentProjectUnread = useAgentStore((s) => s.agents.reduce((n, a) => n + (a.has_unread_changes ? 1 : 0), 0))

  // Record every project you land on (via dropdown, switcher, direct nav, or
  // boot restore) so the Ctrl+` switcher can order by last-visited.
  useEffect(() => {
    if (currentProjectId) touchProject(currentProjectId)
  }, [currentProjectId])
  // Resolved [review] config for the current project, cached in the project
  // store (the agent page and settings load it too - ensureReviewConfig dedupes
  // concurrent fetches, so only one request runs). The sidebar uses its
  // browse_url for the forge web link next to Repository
  // (docs/non-local-integration.md).
  const reviewConfig = useProjectStore((s) => (currentProjectId ? s.reviewConfigs[currentProjectId] : undefined))
  useEffect(() => {
    // Unconditional: the store may hold a persisted snapshot (rendered
    // immediately), and ensureReviewConfig itself decides whether a refresh
    // is still needed this session.
    if (currentProjectId) void ensureReviewConfig(currentProjectId)
  }, [currentProjectId])
  // Whether the user actually has this page in front of them (foreground tab +
  // focused window). Gates the unread auto-clear so a backgrounded page doesn't
  // silently dismiss agents the user hasn't actually looked at.
  const pageActive = usePageActive()

  // Navigate to a project's remembered view (agent / repository / settings /
  // bare project). Used by the boot restore and the project-switch dropdown.
  //
  // Deliberately unconditional: no lookup runs first, so the switch is instant.
  // That means a remembered agent is opened even if it has unread changes (which
  // opening it clears - the point of a switch is to get back to what you were
  // doing, not to preserve a dot) and even if it no longer exists, in which case
  // the agent page corrects itself once its own getAgent confirms it is gone.
  const navigateToProjectView = useCallback((projectId: string, view: ProjectViewRoute) => {
    if (view.kind === 'agent') {
      navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId, agentId: view.agentId } })
    } else if (view.kind === 'settings') {
      navigate({ to: '/project/$projectId/settings', params: { projectId } })
    } else if (view.kind === 'repository') {
      // The compare-diff selection and its line anchor ride the search params /
      // hash, so a remembered diff restores on the same file and line.
      const search = { compare: view.compare, dfile: view.dfile }
      if (view.path) {
        navigate({ to: '/project/$projectId/repository/$', params: { projectId, _splat: view.path }, search, hash: view.hash })
      } else {
        navigate({ to: '/project/$projectId/repository', params: { projectId }, search, hash: view.hash })
      }
    } else {
      navigate({ to: '/project/$projectId', params: { projectId } })
    }
  }, [navigate])

  // Restore a project's remembered view when switching into it.
  const restoreProjectView = useCallback((projectId: string, stored: string) => {
    navigateToProjectView(projectId, parseProjectView(stored))
  }, [navigateToProjectView])

  // Switch the active project: record the selection and route to its remembered
  // view. Shared by the header dropdown and the Ctrl/Cmd+` keyboard shortcut so
  // both behave identically. The one exception is the *global* settings page,
  // which belongs to no project and so has no memory to restore - picking a
  // project there opens that project's settings, as it always has. Project
  // settings pages need no such special case any more: they are remembered like
  // any other view, so a project you left on its settings page comes back to it.
  const selectProject = useCallback((id: string) => {
    setSelectedProjectId(id)
    if (window.location.pathname === '/settings') {
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
    if (next && selectedAgentId && useAgentStore.getState().archived.some((a) => a.id === selectedAgentId)) {
      navigate({ to: '/project/$projectId', params: { projectId: currentProjectId } })
    }
  }, [currentProjectId, archivedCollapsed, selectedAgentId, navigate])

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

  // Apply the theme (`dark` class on <html>) and the chosen fonts (the
  // --app-font-* variables on <html>) from their shared stores; the controls
  // themselves now live on the Settings page.
  useApplyTheme()
  useApplyFonts()

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
  // Paint the selected project's icon into the tab, so one-tab-per-project
  // setups are tellable apart (matches the OS notification icon).
  useProjectFavicon(currentProjectId)
  const { refetchStatus, canRestart, canUpdate, spawnedAt } = useSystemStatus()

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
    if (selectedAgentUnread) {
      markRead(selectedAgentId)
      api.default.markAgentRead(currentProjectId, selectedAgentId).catch(() => {})
    }
  }, [selectedAgentUnread, selectedAgentId, currentProjectId, markRead, pageActive])

  // Reflect unread changes in the browser tab title with a leading dot, so a
  // backgrounded tab signals "something's waiting" without the page in focus.
  // We use a plain U+25CF glyph (not a color emoji like 🔵) so it renders as a
  // small, consistent dot across platforms - Linux/Chrome draws emoji via Noto
  // Color Emoji as an oversized glossy ball that looks out of place in a tab.
  // We count the live (optimistically-cleared) agents for the current project
  // and trust the backend per-project counts for the others - so the dot tracks
  // the same state as the in-app indicators and clears the moment they do.
  const otherProjectsUnread = projects
    .filter((p) => p.id !== currentProjectId)
    .reduce((n, p) => n + (p.unread_count ?? 0), 0)
  const anyUnread = currentProjectUnread + otherProjectsUnread > 0
  // Build the rest of the title from the current view: project, then the open
  // agent (its title, falling back to id) or the repository browser. Computed as
  // primitive strings so the effect only fires when the displayed text changes.
  const currentProject = projects.find((p) => p.id === currentProjectId)
  const titleProjectName = currentProject?.name
  const titleAgentName = selectedAgentName
  const onRepository = /\/repository(\/|$)/.test(location.pathname)
  // The project home - the bare /project/<id>, with no agent, repository browser
  // or settings below it. The one page a spawn is allowed to navigate away from
  // (see handleSpawned). "/" never matches, and doesn't need to: it is a
  // redirect to the last project, not a page you sit on.
  const onProjectHome = /^\/project\/[^/]+\/?$/.test(location.pathname)
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
    // A head's live status/activity/last-message changed: the event carries the
    // bundle, so patch the one row in place - no agent-list refetch. (A real status
    // flip also fires agents_changed above for the unread / push-status paths.)
    onAgentStatusChanged: (agentId, patch) => patchAgentStatus(agentId, patch),
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
      return
    }
    // Nothing to restore (first run, or the remembered project was removed):
    // land in the built-in scratch project rather than on a dead-end page. The
    // `scratch` guard also holds this off until the project list has loaded, so
    // we never bounce off "/" before the remembered project arrives.
    const scratch = projects.find((p) => p.builtin)
    if (scratch) {
      didAutoNavigate.current = true
      navigate({ to: '/project/$projectId', params: { projectId: scratch.id } })
    }
  }, [selectedProjectId, projects, restoreProjectView, navigate])

  // Persist the current view per project so switching back (or reloading)
  // restores it. Both the project id and the suffix to remember come from the
  // one location string (splitProjectHref): route params lag the location by a
  // render mid-navigation, and pairing the *old* project id with the *new*
  // pathname is what used to wipe the memory of the project being left. A
  // non-project location ("/", "/settings") has no memory and is left alone -
  // in particular the fall-back-to-stored-project id is never used here, so this
  // cannot overwrite a project's memory before the boot restore above runs.
  //
  // Correcting a remembered-but-dead agent is deliberately NOT done here. A
  // killed/merged head is now a valid read-only *archived* page, so it must not
  // be bounced; and the only place that can distinguish a genuinely-gone agent
  // from an archived one whose record simply hasn't loaded into the sidebar list
  // yet (deep in the paginated history, or on a cold load) is the agent page
  // itself - it does a one-shot getAgent and, only if truly missing, redirects
  // off the dead agent and resets this memory to the project page.
  useEffect(() => {
    const here = splitProjectHref(location.href)
    if (!here) return // not on a project route ("/", "/settings") - leave storage alone
    saveProjectView(here.projectId, here.view)
  }, [location.href])

  // Drop expired per-artifact, per-agent-view and cached-agent-list entries once
  // on boot, plus the retired split-layout opt-out key (the toggle is gone;
  // split is always on).
  useEffect(() => {
    pruneArtifactPrefs()
    pruneAgentViewPrefs()
    pruneReviewDrafts()
    pruneAgentCaches()
    pruneBranchCaches()
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
  // Hidden projects are left out of the switcher, except the one you're in (see
  // visibleProjects) - a project you told Hydra to keep out of the list has no
  // business turning up in the middle of an alt-tab cycle.
  const switcherProjects = useMemo(
    () => visibleProjects(projects, currentProjectId),
    [projects, currentProjectId],
  )
  const { state: switcherState, setIndex: switcherSetIndex, commit: switcherCommit } =
    useGlobalShortcuts({ projects: switcherProjects, currentProjectId, selectProject })

  // restartErrorText pulls the server's own explanation out of an ApiError, so a
  // 403 reads as "not running from a Hydra checkout" rather than "Forbidden".
  function restartErrorText(err: unknown): string {
    if (err instanceof ApiError) {
      return (err.body as { details?: string } | undefined)?.details ?? err.message
    }
    return String(err)
  }

  // waitForHealthy polls until the replacement image answers. The new process
  // inherited the listening socket, so connections queue rather than being
  // refused - this normally settles on the first attempt.
  async function waitForHealthy(): Promise<void> {
    for (let i = 0; i < 120; i++) {
      await new Promise<void>((r) => setTimeout(r, 500))
      try {
        const resp = await fetch('/health')
        if (resp.ok && (await resp.text()).trim() === 'OK') return
      } catch { /* still restarting */ }
    }
  }

  // runServerRestart drives both the plain restart and the rebuild-then-restart.
  //
  // The interesting part is how a SUCCESSFUL update ends: the server re-execs,
  // so the log websocket dies mid-stream with no terminal frame. That is not an
  // error, and the store distinguishes it (outcome 'restarting') from genuinely
  // losing the server mid-build. A FAILED build, by contrast, leaves the server
  // running and reports through the toast, so there is nothing to wait for and
  // nothing to reload.
  async function runServerRestart(mode: 'restart' | 'update') {
    setRestarting(true)
    const updates = useServerUpdateStore.getState()
    updates.begin({ restartOnly: mode === 'restart' })

    const toast = useToastStore.getState()
    // Keyed + persistent: the body follows the update store on its own, so this
    // is shown once and never re-shown as several hundred build lines arrive.
    // ONE toast for the whole run, keyed so a second press replaces it in place
    // rather than stacking. Its body reads the update store, so "Building..."
    // becomes "Update failed" (or the reload) by re-rendering - there is never a
    // second card, and never a gap where the first has gone and the next has not
    // arrived. Wide because the body is a terminal (see TOAST_CARD_WIDTH_WIDE).
    toast.show({
      key: 'server-update',
      message: <ServerUpdateToast />,
      richMessage: true,
      type: 'info',
      duration: 0,
      wide: true,
    })

    // A plain restart has no build to report, and the server may be gone before
    // a stream could even connect - so don't open one. Say what is happening and
    // wait for the socket to answer again.
    if (mode === 'restart') {
      try {
        await api.default.restartServer()
      } catch (err) {
        updates.apply({ kind: 'done', error: restartErrorText(err) })
        setRestarting(false)
        return
      }
      updates.apply({ kind: 'phase', phase: ServerUpdatePhase.ServerUpdatePhaseRestarting })
      await waitForHealthy()
      window.location.reload()
      return
    }

    // Start the job BEFORE subscribing. Subscribers are replayed the events so
    // far, which is what lets a late tab catch up - but it also means connecting
    // first would hand us the *previous* run's history, terminal frame and all,
    // and we would call this update finished before it began. Both the server
    // and the simulation clear that history synchronously as the job starts, so
    // subscribing afterwards sees this run and only this run.
    try {
      await api.default.updateServer()
    } catch (err) {
      updates.apply({ kind: 'done', error: restartErrorText(err) })
      setRestarting(false)
      return
    }
    const closeStream = connectUpdateStream()

    // Wait for the outcome the stream reports rather than a fixed delay: a
    // rebuild takes as long as it takes, and a failure must not end in a reload.
    const outcome = await new Promise<string | null>((resolve) => {
      const settled = (state: { running: boolean; outcome: string | null }) => {
        if (!state.running && state.outcome != null) {
          unsubscribe()
          resolve(state.outcome)
        }
      }
      const unsubscribe = useServerUpdateStore.subscribe(settled)
      // The job may already have finished between the POST and this subscribe.
      settled(useServerUpdateStore.getState())
    })
    closeStream()

    if (outcome === 'failed') {
      setRestarting(false)
      return
    }

    await waitForHealthy()
    window.location.reload()
  }

  // handleRestart confirms first when heads are live, because a restart stops
  // every running agent: they come back via --continue, but an in-flight turn is
  // lost. Cheap to say, expensive to discover.
  function handleRestart(mode: 'restart' | 'update') {
    // Read at click time rather than subscribing - this is a one-shot count.
    const live = useAgentStore.getState().agents.filter((a) => a.session_status === 'running').length
    if (live === 0) {
      void runServerRestart(mode)
      return
    }
    useDialogStore.getState().show({
      title: mode === 'update' ? 'Update and restart?' : 'Restart the server?',
      message:
        `${live} agent${live === 1 ? ' is' : 's are'} running. Restarting stops ` +
        `${live === 1 ? 'it' : 'them'} and resumes ${live === 1 ? 'it' : 'them'} afterwards, ` +
        'but whatever turn is in flight right now will be lost.',
      type: 'confirm',
      confirmLabel: mode === 'update' ? 'Update and restart' : 'Restart',
      showCancel: true,
      onConfirm: () => void runServerRestart(mode),
    })
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
  const handleAddProject = useCallback(async (typedPath: string) => {
    // Resolve first, so everything from here on - the trust prompt, the
    // create/init dialogs, the error messages - names the absolute path the
    // server will actually use, not the "~/code/x" shorthand that was typed.
    // Only the server can do this (it knows its own home directory). If the
    // resolve call itself fails, carry on with what was typed and let
    // registerProject produce the real error.
    let path = typedPath.trim()
    try {
      path = (await api.default.resolvePath(path)).path
    } catch { /* fall back to the typed path */ }
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
    // Spawn in the background: only the project home jumps to the new agent.
    // That page is the one place with nothing of the user's own on it, so
    // opening the head there is the obvious next step rather than an
    // interruption. Every other page - an open agent, the repository browser,
    // settings - is somewhere they deliberately went, so leave it in front and
    // let the new head just appear in the sidebar list. (Settings especially:
    // navigating away from a draft trips its unsaved-changes blocker, so a
    // spawn would ask them to discard edits they never meant to leave.)
    if (currentProjectId && onProjectHome) {
      navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId: currentProjectId, agentId: agent.id } })
    }
  }, [addAgent, currentProjectId, onProjectHome, navigate])

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
        {/* Sidebar toggle: always present, so it never jumps in and out of the
            bar - the icon flips between hide and show. On mobile it's the
            hamburger for the full-screen sidebar panel. */}
        <Tooltip content={`${sidebarVisible ? 'Hide' : 'Show'} sidebar`} shortcut={{ keys: ['Ctrl', '.'] }}>
          <button
            type="button"
            aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
            onClick={toggleSidebar}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
          >
            {isDesktopViewport ? (
              sidebarVisible ? <PanelLeftClose className="w-5 h-5" /> : <PanelLeftOpen className="w-5 h-5" />
            ) : sidebarVisible ? (
              <X className="w-5 h-5" />
            ) : (
              <Menu className="w-5 h-5" />
            )}
          </button>
        </Tooltip>
        <ProjectDropdown
          projects={projects}
          selectedId={currentProjectId}
          // Restore the view (agent / repository / project) last open in the
          // project we're switching to (see selectProject / restoreProjectView).
          onSelect={selectProject}
          onDeselect={handleProjectDeselect}
          onAddProject={handleAddProject}
        />
        {/* mr-2.5 balances the separator: the selector's trailing padding sits
            10px left of it, so match that on the right (the slot content has no
            leading padding of its own). */}
        {(selectedAgentId != null || crumb != null) && (
          <span aria-hidden className="shrink-0 mr-2.5 text-gray-300 dark:text-gray-600 select-none">/</span>
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
        className={`relative overflow-hidden max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:!w-full bg-white dark:bg-gray-800 flex shrink-0 ${sidebarResizing ? '' : 'transition-[width,transform,translate] duration-200'} ${mobileSidebarOpen ? 'translate-x-0' : 'max-md:-translate-x-full'}`}
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
              -> results (agents list). See docs/non-local-integration.md */}
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
                const inSync = !!pushStatus && ahead === 0 && behind === 0
                return (
                  <>
                    {/* Row 1: the Repository link (labelled with the project's
                        path) with the forge web link right-aligned after it. */}
                    <div className="flex items-center gap-1">
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
                          auth - docs/non-local-integration.md). Hidden when there is
                          no remote or no https browse URL could be derived. */}
                      {reviewConfig?.browse_url && (
                        <Tooltip
                          content={
                            <>
                              <div>
                                Open on{' '}
                                {reviewConfig.provider === 'github'
                                  ? 'GitHub'
                                  : reviewConfig.provider === 'gitlab'
                                    ? 'GitLab'
                                    : 'the forge'}
                              </div>
                              {/* The URL is the useful part - which remote this
                                  actually points at. The hint wraps at 320px. */}
                              <div className="text-gray-500 dark:text-gray-400">{reviewConfig.browse_url}</div>
                            </>
                          }
                          className="shrink-0"
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
                    </div>
                    {/* Row 2: the git status line - ALWAYS rendered (a row that
                        came and went with every merge made the layout jump
                        constantly). Branch fills the left; dirty/ahead-behind
                        chips and Sync sit right. When clean and in sync it
                        reads "up to date" instead of emptying. */}
                    <div className="px-2.5 mt-0.5 pb-1 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                      <GitBranch className="w-3.5 h-3.5 shrink-0" />
                      <span className="font-mono truncate" title={pushStatus?.branch || undefined}>
                        {pushStatus ? (pushStatus.branch || 'detached') : '...'}
                      </span>
                      <div className="flex-1" />
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
                      {behind > 0 || ahead > 0 ? (
                        <Tooltip content={statusTooltip} className="shrink-0">
                          <span className="flex items-center gap-1 font-medium tabular-nums select-none">
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
                      ) : (
                        <span className="select-none text-gray-400 dark:text-gray-500">
                          {!pushStatus ? '' : !pushStatus.has_remote ? 'no remote' : inSync ? 'up to date' : ''}
                        </span>
                      )}
                      <Tooltip content={syncTooltip} className="shrink-0">
                        <button
                          type="button"
                          onClick={handleSync}
                          disabled={!canSync}
                          aria-label={syncTooltip}
                          className={
                            canSync
                              ? 'inline-flex items-center p-1 rounded-md text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer'
                              : 'inline-flex items-center p-1 rounded-md text-gray-300 dark:text-gray-600 cursor-not-allowed'
                          }
                        >
                          <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${syncing ? 'animate-spin' : ''}`} />
                        </button>
                      </Tooltip>
                    </div>
                  </>
                )
              })()
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm font-medium text-gray-400 dark:text-gray-600 cursor-not-allowed">
                  <FolderGit2 className="w-4 h-4 shrink-0" />
                  Repository
                </span>
              </div>
            )}
          </div>

          <SpawnForm compact projectId={currentProjectId} onSpawned={handleSpawned} disabled={!currentProjectId} />

          <AgentSidebarList
            currentProjectId={currentProjectId}
            selectedAgentId={selectedAgentId}
            archivedCollapsed={archivedCollapsed}
            onToggleArchivedCollapsed={toggleArchivedCollapsed}
            onDeselect={handleAgentDeselect}
            archivedSentinelRef={archivedSentinelRef}
          />

          {/* Sidebar footer - a single row: restart (icon) + uptime on the left,
              Claude usage + Settings (icon) on the right. The theme switcher now
              lives inside Settings, not here.

              The two halves are grouped, and only the left one may shrink. The
              sidebar is a fixed width but its footer is not: the icon buttons
              are fixed squares and the usage strip is three tabular figures that
              mean nothing clipped, so the uptime label - which already
              truncates, and is the one thing here you can still read half of -
              is what gives when the row runs out of room. That is what keeps the
              strip from drawing over the settings gear, which it did at every
              size before this (the row simply overflowed), and it is why a
              larger Interface size costs a few characters of "up 2 hours"
              instead of a second line. */}
          <div className="group border-t border-gray-200 dark:border-gray-700 px-2 py-2 flex items-center gap-1.5 shrink-0">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {canRestart && (
              // Primary action is whichever one is actually useful here: a server
              // that can rebuild itself gets "update", one that can't gets a plain
              // restart. The secondary is offered as a hold-Alt variant rather
              // than a second control, to keep the footer a single row - and it
              // is a `shortcut` rather than prose in brackets, so the modifier
              // reads as a key.
              //
              // The uptime rides along here because this button is what it is
              // about (the server, and how long this one has been up), and
              // because the label beside it gives way to the usage strip.
              <Tooltip
                content={
                  restarting
                    ? 'Restarting...'
                    : canUpdate
                      ? 'Rebuild and restart the server'
                      : 'Restart the server'
                }
                shortcut={canUpdate && !restarting ? { keys: ['Alt'], note: 'restart without rebuilding' } : undefined}
                footnote={
                  spawnedAt.current !== null ? <Uptime spawnedAt={spawnedAt.current} format={formatUptime} /> : undefined
                }
              >
                <button
                  onClick={(e) => handleRestart(canUpdate && !e.altKey ? 'update' : 'restart')}
                  disabled={restarting}
                  aria-label={canUpdate ? 'Update and restart server' : 'Restart server'}
                  className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <RotateCw className={`w-4 h-4 ${restarting ? 'animate-spin' : ''}`} />
                </button>
              </Tooltip>
            )}
            {spawnedAt.current !== null && (
              // Hidden outright once the Claude usage strip is on screen, rather
              // than truncated to "up 2 h...": the two of them do not fit beside
              // the icon buttons in a 264px sidebar, and half a word is worth
              // less than the strip's figures. `group-has-[[data-usage]]` reads
              // the strip's own marker off the footer row, so this needs no
              // second copy of the poll that decides whether it renders.
              //
              // Only when there is a restart button to hold it: that button's
              // tooltip is where the uptime goes, so with no button the label
              // stays and truncates as before (min-w-0 on the Tooltip's own
              // inline-flex wrapper, or the label's `truncate` never engages).
              <Tooltip
                className={`min-w-0 ${canRestart ? 'group-has-[[data-usage]]:hidden' : ''}`}
                content={`Spawned at ${new Date(spawnedAt.current).toUTCString()}`}
              >
                <span className="block min-w-0 truncate text-2xs text-gray-400 dark:text-gray-500 cursor-default">
                  <Uptime spawnedAt={spawnedAt.current} format={formatUptime} />
                </span>
              </Tooltip>
            )}
            </div>
            {/* The right half, as one group: usage strip + settings, neither of
                which may shrink - see above. */}
            <div className="flex shrink-0 items-center gap-1.5">
              <ClaudeUsageIndicator />
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
        </div>
      </aside>

        {/* Resize handle (md+ only - the mobile panel has a fixed width).
            Invisible strip; the shared pill appears on hover.

            It lives OUTSIDE the <aside>, positioned over the seam, because the
            aside is `overflow-hidden`: a handle parked at its inner right edge
            sat squarely on top of the agent list's scrollbar and swallowed all
            but a couple of pixels of the thumb. Straddling the seam (3px over
            the sidebar, 7px over the content) leaves the scrollbar grabbable
            while keeping a comfortable drag target. */}
        {!desktopCollapsed && (
          <div
            onPointerDown={handleSidebarResizeStart}
            title="Drag to resize"
            style={{ left: sidebarWidth - 3 }}
            className={`hidden md:flex absolute inset-y-0 w-2.5 cursor-col-resize z-30 group/resize items-center justify-center touch-none ${sidebarResizing ? '' : 'transition-[left] duration-200'}`}
          >
            <ResizeGrip orientation="vertical" />
          </div>
        )}

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
