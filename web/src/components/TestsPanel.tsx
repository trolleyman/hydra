import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Check, X, TriangleAlert, LoaderCircle, RefreshCw, FunnelX, ScrollText, ChevronRight, Search, SkipForward, FlaskConical, Sparkles } from 'lucide-react'
import { linkOptions } from '@tanstack/react-router'
import { api } from '../stores/apiClient'
import { apiErrorBody, formatError } from '../api/format_error'
import { PanelError } from './PanelError'
import type { TestRunResult } from '../api/models/TestRunResult'
import type { TestCase } from '../api/models/TestCase'
import { TestCaseStatus } from '../api/models/TestCaseStatus'
import type { ArtifactLogLine, TestsFrame } from '../api'
import { TONE_BADGE, verdictTone } from './badgeTones'
import { CollapsibleCard, MELT_BTN } from './CollapsibleCard'
import { CollapseSlide } from './CollapseSlide'
import { useMeasuredHeight } from '../lib/useMeasuredHeight'
import { LogView } from './ArtifactLogView'
import { InfoTooltip } from './InfoTooltip'
import { Tooltip } from './Tooltip'
import { SettingsPopover, SettingsGroupLabel, SettingsOptionRow } from './SettingsPopover'
import { TagScopeFilter } from './ArtifactFilterBar'
import { CaseTree, NodeBadges, type FixCase, type OpenInRepo } from './CaseTree'
import { loadAgentViewPrefs, patchAgentViewPrefs } from '../lib/agentViewPrefs'
import { formatLineHash } from '../lib/lineRange'
import { buildRepoSplat } from '../lib/repoSplat'
import { buildFixTestMessage } from '../lib/testCases'
import { useDialogStore } from '../stores/dialogStore'
import { useAgentStore } from '../stores/agentStore'
import { useToastStore } from '../stores/toastStore'
import { agentTransitionToast } from '../lib/agentToast'
import { TILE_TONE, TILE_BAR } from '../lib/tileTone'
import { spawnDefaultFields } from '../lib/spawnDefaults'
import { spawnGeometry } from '../lib/terminalGeometry'
import { runWithToast } from '../lib/apiAction'
import { useLogCoalescer } from '../lib/useLogCoalescer'
import { closeWebSocket } from '../lib/ws'
import { AnsiText } from './AnsiText'
import { ElapsedTime } from './ElapsedTime'
import {
  TEST_STATUS_ORDER, type TestFilter,
  defaultHiddenStatuses, defaultTestFilter, isDefaultTestFilter, loadTestFilter, saveTestFilter,
  computeVisibleCases, computeStatusCounts,
} from '../lib/testFilterPrefs'

// The socket's frames are declared in api/openapi.yaml and generated for both
// the daemon and here, so a frame the server sends and one this panel narrows
// on cannot drift. Single-sided (no before/after), so a runner is addressed by
// name alone.

function testsWsUrl(projectId: string, agentId: string, headRef?: string, includeUncommitted?: boolean): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const pid = projectId ? encodeURIComponent(projectId) : '_'
  const params = new URLSearchParams()
  if (headRef) params.set('head_ref', headRef)
  if (includeUncommitted) params.set('include_uncommitted', 'true')
  const qs = params.toString() ? `?${params.toString()}` : ''
  return `${protocol}//${host}/ws/projects/${pid}/agents/${encodeURIComponent(agentId)}/tests${qs}`
}

// TestsPanel renders the head's test-runner verdicts (PLAN #68), styled to match
// the artifacts panel: a "Tests (i)" header over one collapsible card per
// [[tests]] runner. Single-sided - there is no before/after comparison; it reports
// the verdict for whatever the diff viewer has selected as the "after" side (a
// commit, or the uncommitted working tree), defaulting to the branch tip. Streams
// updates over a WebSocket so progress / the live log / the settled verdict land
// instantly, falling back to polling if the socket can't connect or drops.
// memo: hosted by DiffViewer, which re-renders on every diff/panel state change
// (a manual refresh alone updates it several times); all props here are
// primitives or stable setters, so the panel only re-renders for its own
// streaming state or a deliberate refreshKey bump.
export const TestsPanel = memo(TestsPanelImpl)

function TestsPanelImpl({ projectId, agentId, repoRef, headRef, includeUncommitted, refreshKey, groupResult, onGroupResultChange, useScope, onUseScopeChange, onScopeAvailable }: {
  projectId: string
  agentId: string
  // The ref (the agent's branch) to browse when a case/file/dir row's
  // open-in-repository affordance is used. Undefined → no repo to link into, so
  // the affordance is hidden.
  repoRef?: string
  // The "after" commit/ref to test, mirrored from the diff viewer's right-hand
  // selector. Undefined → the agent's branch tip. includeUncommitted tests the
  // working tree instead of a commit.
  headRef?: string
  includeUncommitted?: boolean
  // Bumped by the diff viewer's refresh control to force a fresh fetch.
  refreshKey?: number
  // View modes (see AgentViewPrefs): groupResult renders per-status sections,
  // useScope trees by class/describe scope instead of filesystem path. Their
  // toggles live in this panel's own header cog (the *Change setters), so the
  // state stays lifted in the diff viewer (shared with persistence) while the
  // controls sit next to the tests they affect.
  groupResult?: boolean
  onGroupResultChange?: (v: boolean) => void
  useScope?: boolean
  onUseScopeChange?: (v: boolean) => void
  // Reports whether any loaded case carries a logical scope, so the cog can
  // grey the "Group by scope" checkbox when the axis doesn't exist.
  onScopeAvailable?: (has: boolean) => void
}) {
  // null = not yet loaded (render nothing); [] = loaded, nothing configured.
  const [runners, setRunners] = useState<TestRunResult[] | null>(null)
  // A server-side failure to surface (e.g. a config that won't parse), reached
  // via the polling fallback; a transient blip stays null and the panel is quiet.
  const [error, setError] = useState<string | null>(null)
  // Connection mode: WS while live, polling if the socket can't connect or drops.
  const [mode, setMode] = useState<'connecting' | 'ws' | 'poll'>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Manual-refresh state for the polling fallback (the WS path sends a message
  // instead): stash the runner name and bump the nonce to re-run the poll effect.
  const [refreshNonce, setRefreshNonce] = useState(0)
  const refreshRunnerRef = useRef<string | null>(null)

  // Coalesce streamed log lines: a chatty runner emits many `log` frames per
  // tick, and appending each on its own would re-copy the whole growing log
  // array per line (O(n^2)). Queue them and apply one batch per ~frame.
  const { enqueue: enqueueLog, flushNow: flushLogs } = useLogCoalescer<ArtifactLogLine>((batches) => {
    setRunners((prev) => prev?.map((r) => {
      const add = batches.get(r.name)
      return add ? { ...r, log: [...(r.log ?? []), ...add] } : r
    }) ?? prev)
  })

  // Apply a server→client WS message to local state.
  const applyMessage = useCallback((msg: TestsFrame) => {
    if (msg.type === 'log') {
      enqueueLog(msg.name, msg.line)
      return
    }
    // Any other message may replace/modify a runner - apply queued log lines
    // first so they land in order on the current runner before it changes.
    flushLogs()
    if (msg.type === 'snapshot') {
      setRunners(msg.runners ?? [])
    } else if (msg.type === 'runner') {
      setRunners((prev) => (prev ? prev.map((r) => (r.name === msg.runner.name ? msg.runner : r)) : [msg.runner]))
    } else if (msg.type === 'progress') {
      setRunners((prev) => prev?.map((r) => (r.name === msg.name ? { ...r, progress: msg.progress } : r)) ?? prev)
    } else if (msg.type === 'counts') {
      // A streamed (type=stdout) run ticking: totals are authoritative, cases
      // are the newly-appended increment (coalesced server-side) - the tree
      // grows in place as they land.
      setRunners((prev) => prev?.map((r) => (r.name === msg.name
        ? {
          ...r,
          passed: msg.counts.passed,
          failed: msg.counts.failed,
          skipped: msg.counts.skipped,
          warnings: msg.counts.warnings,
          total: msg.counts.total > 0 ? msg.counts.total : r.total,
          total_estimated: msg.counts.total > 0 ? msg.counts.total_estimated : r.total_estimated,
          cases: msg.counts.cases?.length ? [...(r.cases ?? []), ...msg.counts.cases] : r.cases,
        }
        : r)) ?? prev)
    }
  }, [enqueueLog, flushLogs])

  // Reset to "connecting" whenever the connection parameters change (during
  // render, before the socket effect below reopens), rather than inside that effect.
  const connKey = `${projectId}\n${agentId}\n${headRef}\n${includeUncommitted}\n${refreshKey}`
  const [prevConnKey, setPrevConnKey] = useState(connKey)
  if (prevConnKey !== connKey) { setPrevConnKey(connKey); setMode('connecting') }

  // Primary path: stream updates over a WebSocket so progress/log/verdict update
  // instantly. Falls back to polling (below) if the socket fails to open or drops.
  useEffect(() => {
    let cancelled = false
    let ws: WebSocket
    try {
      ws = new WebSocket(testsWsUrl(projectId, agentId, headRef, includeUncommitted))
    } catch {
      // The WebSocket constructor threw synchronously (e.g. a malformed URL) -
      // fall back to polling. This error-path setState can't be hoisted out.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMode('poll')
      return
    }
    wsRef.current = ws
    ws.onopen = () => { if (!cancelled) setMode('ws') }
    ws.onmessage = (e) => {
      if (cancelled) return
      try { applyMessage(JSON.parse(e.data) as TestsFrame) } catch { /* ignore malformed frames */ }
    }
    ws.onclose = () => {
      wsRef.current = null
      // Fall back to polling on any non-deliberate close (initial-connect failure
      // or a mid-session drop, e.g. the daemon restarting).
      if (!cancelled) setMode('poll')
    }
    return () => {
      cancelled = true
      closeWebSocket(ws)
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [projectId, agentId, headRef, includeUncommitted, refreshKey, applyMessage])

  // Fallback path: poll the HTTP endpoint while the WS is unavailable, re-fetching
  // every 1.5s while any runner is still running so the live log + counts advance.
  useEffect(() => {
    if (mode !== 'poll') return
    let cancelled = false
    const clear = () => { if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null } }
    const refreshRunner = refreshRunnerRef.current
    refreshRunnerRef.current = null

    const tick = async (first: boolean) => {
      try {
        const resp = await api.default.getAgentTests(projectId, agentId, headRef, includeUncommitted, first ? refreshRunner ?? undefined : undefined)
        if (cancelled) return
        setRunners(resp.runners)
        setError(null)
        if (resp.runners.some((r) => r.status === 'running')) {
          pollTimerRef.current = setTimeout(() => tick(false), 1500)
        }
      } catch (err) {
        if (cancelled) return
        // A structured server error (e.g. a config that won't parse) is surfaced
        // so the panel doesn't silently vanish; a transient blip leaves state be.
        if (apiErrorBody(err)) setError(formatError(err))
      }
    }
    clear()
    void tick(true)
    return () => { cancelled = true; clear() }
  }, [mode, projectId, agentId, headRef, includeUncommitted, refreshKey, refreshNonce])

  // Re-run one runner: discard its cached verdict and run it again. Optimistically
  // flip the card to "running" (cleared log/cases) so the spinner shows at once.
  const requestRefresh = useCallback((name: string) => {
    setRunners((prev) => prev?.map((r) => (r.name === name
      ? { ...r, status: 'running' as TestRunResult['status'], cases: [], log: [], log_url: null, error: null, progress: null }
      : r)) ?? prev)
    const ws = wsRef.current
    if (mode === 'ws' && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'refresh', name }))
    } else {
      // Polling fallback: forward the name to the next poll so the backend discards
      // the cached (possibly errored) result and regenerates.
      refreshRunnerRef.current = name
      setRefreshNonce((n) => n + 1)
    }
  }, [mode])

  // Sticky "Tests" header height, published as the shared --sticky-section-h so the
  // runner card headers dock flush beneath it - the same mechanism the artifacts
  // panel uses (see useMeasuredHeight + CollapsibleCard's sticky option).
  const [testsHeaderRef, testsHeaderH] = useMeasuredHeight(41)

  // The status filter (the tests analog of the artifacts tag filter) and the
  // ephemeral search box. Only an explicit customization is held/persisted;
  // otherwise the mode-dependent default applies (unified tree: passed +
  // skipped hidden; group-by-result: nothing hidden - its sections fold the
  // boring statuses away instead), and follows the cog as the mode changes.
  const [customFilter, setCustomFilter] = useState<TestFilter | null>(() => loadTestFilter(projectId, agentId))
  const [search, setSearch] = useState('')
  // Reload the persisted filter when switching agents (render-time adjust, same
  // pattern as the connKey reset above).
  const filterKey = `${projectId}\n${agentId}`
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey)
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey)
    setCustomFilter(loadTestFilter(projectId, agentId))
    setSearch('')
  }
  const filter = customFilter ?? defaultTestFilter(!!groupResult)
  const updateFilter = useCallback((f: TestFilter) => {
    // A selection matching the mode default is "no customization": drop the
    // stored value so the default keeps tracking the view mode.
    const custom = isDefaultTestFilter(f, !!groupResult) ? null : f
    setCustomFilter(custom)
    saveTestFilter(projectId, agentId, custom)
  }, [projectId, agentId, groupResult])

  // The head's own branch, for a "Spawn agent" that starts from the code the
  // test is failing in. A selector, not a whole-store subscribe: this panel
  // re-renders on every streamed test frame as it is.
  const branchName = useAgentStore((s) => s.agents.find((a) => a.id === agentId)?.branch_name ?? '')

  // Every parsed case across all runners: drives the status dropdown's counts
  // and the scope-axis availability the cog needs.
  const allCases = useMemo(() => (runners ?? []).flatMap((r) => r.cases ?? []), [runners])
  const statusCounts = useMemo(() => computeStatusCounts(allCases), [allCases])

  // Deep-link a case/file/dir row to the repository browser at the agent's
  // branch. Omitted when there's no ref to browse, which hides the affordance. A
  // case's line is carried as an #L<n> hash, which the repo view scrolls to and
  // highlights (see RepositoryView's selRange). Returns <Link> props (not a
  // navigate call) so the row renders a real anchor - that's what makes
  // middle-click / Ctrl-click open the target in a new tab.
  const onOpenInRepo = useMemo<OpenInRepo | undefined>(() => {
    if (!repoRef) return undefined
    return (path: string, line?: number | null) => linkOptions({
      to: '/project/$projectId/repository/$',
      params: { projectId, _splat: buildRepoSplat(repoRef, path) },
      hash: line != null && line > 0 ? formatLineHash(line, line) : undefined,
    })
  }, [projectId, repoRef])

  // Hand the same message to a NEW head instead of this one.
  //
  // Branched from THIS AGENT'S branch, not the project's default branch (the
  // spawn composer's own default), and that is the deliberate part: this panel
  // is single-sided - the verdict it shows is for the head's own ref - so a
  // failure you click the sparkle on is usually one the head's changes
  // introduced. A head spawned off main often cannot reproduce it at all, and
  // its fix would land on main while the failing branch stays failing until it
  // updates from base. Stacking on a `hydra/<id>` branch is a supported spawn
  // (it is what the composer's branch selector offers), and the fix merges back
  // into the branch that has the bug. Which is also why the option is hidden
  // when the head has no branch to start from.
  //
  // Only the committed tip travels: uncommitted work in this worktree is not in
  // the new head's, and the dialog says so.
  const spawnFixAgent = useCallback(async (prompt: string, branch: string) => {
    const geom = spawnGeometry()
    const res = await runWithToast(
      () => api.default.spawnAgent(projectId, {
        prompt,
        // The agent type / model / chat mode the user last spawned with. There is
        // no composer here to choose them in, and a hardcoded default would spawn
        // an agent they don't use.
        ...spawnDefaultFields(),
        base_branch: branch,
        ...(geom.cols ? { cols: geom.cols } : {}),
        rows: geom.rows,
      }),
      { errorPrefix: 'Failed to spawn an agent' },
    )
    if (!res.ok) return
    const agent = res.value
    // Into the store immediately, so the head is in the sidebar before the next
    // poll - the toast links to it, and a link to an agent the list doesn't know
    // about yet lands on a page with nothing on it.
    useAgentStore.getState().addAgent(agent)
    useToastStore.getState().show({
      ...agentTransitionToast({
        agentName: agent.title || agent.id,
        agentId: agent.id,
        projectId,
        // No status pill: the head is a second old and has yet to report one.
        // The sentence is the whole message, and the name above it is the link.
        before: 'is on the test failure',
      }),
      // The tile says WHAT HAPPENED (see agentToast) - here that's the same
      // sparkle as the fix affordance this was started from, not the neutral dot
      // a status-less transition would otherwise get.
      icon: <Sparkles className="w-[18px] h-[18px]" />,
      accent: { wrap: TILE_TONE.indigo, bar: TILE_BAR.indigo },
    })
  }, [projectId])

  // "Ask the agent to fix this test": build the message, show it in full, and
  // only send once the user confirms. Nothing is sent from the row click itself
  // - starting an agent turn is not something to discover after the fact. The
  // same message can go to a fresh head instead (the secondary action), for a
  // failure you don't want to interrupt this agent with.
  const fixCase = useCallback((runner: string, c: TestCase) => {
    const prompt = buildFixTestMessage(runner, c)
    useDialogStore.getState().show({
      variant: 'sendPrompt',
      title: 'Ask the agent to fix this test?',
      message: branchName
        ? 'This is sent to the agent as a new chat message, and starts a turn (or queues behind the one running). Spawn agent gives it to a new head branched off this one instead - uncommitted work stays here.'
        : 'This is sent to the agent as a new chat message, and starts a turn (or queues behind the one running).',
      confirmLabel: 'Send to agent',
      secondaryLabel: 'Spawn agent',
      details: { prompt },
      onConfirm: () => {
        void runWithToast(() => api.default.sendAgentInput(projectId, agentId, { text: prompt }), {
          success: 'Sent the test failure to the agent',
          errorPrefix: 'Failed to send to the agent',
        })
      },
      // Omitted without a branch, which hides the button rather than offering a
      // spawn that would start from the wrong code.
      onSecondary: branchName ? () => { void spawnFixAgent(prompt, branchName) } : undefined,
    })
  }, [projectId, agentId, branchName, spawnFixAgent])

  const hasScope = useMemo(() => allCases.some((c) => (c.scope?.length ?? 0) > 0), [allCases])
  useEffect(() => { onScopeAvailable?.(hasScope) }, [hasScope, onScopeAvailable])

  // Nothing configured (or not loaded yet) → render nothing, like the artifacts
  // panel, so the diff viewer doesn't reserve empty space for an absent feature.
  if (error && (!runners || runners.length === 0)) {
    return <PanelError title="Tests" icon={<FlaskConical className="w-3.5 h-3.5" />} message={error} />
  }
  if (!runners || runners.length === 0) return null

  const runningCount = runners.filter((r) => r.status === 'running').length
  const statusOff = filter.status

  return (
    <div className="mb-4" style={{ '--sticky-section-h': `${testsHeaderH}px` } as CSSProperties}>
      {/* The "Tests" header docks flush below the Changes bar (sticky) while the
          runner cards scroll under it - mirroring the artifacts filter bar. The `top`
          is the measured Changes-bar height minus the scroll container's pt-4. z-20
          sits below the Changes bar but above the cards (whose headers stick at z-10);
          an opaque bg lets cards scroll cleanly underneath, and -mx-1/px-1 bleeds it
          to the Changes bar's width. min-h reserves the row height so the running
          progress chip can't jump the layout. */}
      <div
        ref={testsHeaderRef}
        style={{ top: 'calc(var(--sticky-changes-h, 45px) - 16px)' }}
        className="sticky z-20 flex flex-wrap items-center gap-2 mb-2 min-h-[1.625rem] bg-gray-50 dark:bg-gray-900 -mx-1 px-1 py-1.5 border-b border-gray-200 dark:border-gray-800 shadow-sm"
      >
        <FlaskConical className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
        <h3 className="text-xs font-semibold tracking-wide text-gray-500 dark:text-gray-400">Tests</h3>
        {/* Info trigger before the status chip: the chip comes and goes (and
            rewidths as runners finish), which would otherwise shift the `i`
            sideways out from under a stationary cursor. */}
        <InfoTooltip title="Tests" width={520}>
          <p>Per-runner pass/fail verdicts for the selected commit - the diff viewer's <strong>after</strong> side (a commit, or your uncommitted working tree), defaulting to the branch tip. Single-sided: there's no before/after comparison.</p>
          <p>Each runner is a project-defined <code className="text-blue-300">[tests.&lt;name&gt;]</code> command in <code className="text-blue-300">.hydra/config.toml</code>. Hydra runs it against the ref, parses the report it writes to <code className="text-blue-300">$HYDRA_TEST_OUTPUT</code> (JUnit XML or Hydra-JSON; otherwise a plain pass/fail from the exit code), and caches the verdict per commit. The verdict <strong>soft-gates the merge button</strong> - a failing run needs a force-merge.</p>
          <p>Expand a card for its cases as a location tree - <strong>passed and skipped cases are hidden by default</strong> (grouping by result hides nothing; its sections fold them away instead); the status filter (right) reveals them, and the search box fuzzy-matches case paths and names. Node tallies always count everything beneath, filtered or not. The changes cog offers grouping by result and by class/describe scope. The <strong>build log</strong> (the scroll icon) is the runner's stdout/stderr, streamed live while it runs. The refresh icon re-runs that runner, discarding the cached verdict.</p>
        </InfoTooltip>
        {/* leading-4, not the inherited 1.5: 11px * 1.5 = 16.5px, a half pixel,
            which knocks whatever it is the tallest thing in (this bar once it
            wraps) onto a fractional height - and a box on a fractional height
            paints 1px taller or shorter depending on its subpixel offset. */}
        {runningCount > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] leading-4 font-normal text-gray-400 dark:text-gray-500">
            <LoaderCircle className="w-3 h-3 animate-spin" />
            Running {runners.length - runningCount}/{runners.length}
          </span>
        )}
        {/* Filter cluster, right-floated - the tests analog of ArtifactFilterBar:
            search + reset + the status scope dropdown (passed hidden by default). */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400 dark:text-gray-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search"
              aria-label="Search test cases by path or name"
              className="h-7 w-36 pl-7 pr-6 rounded-md border text-[11px] bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-600 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
            />
            {search && (
              // The absolute placement is relative to the search box, so it moves
              // to the wrapper - which is what the box now positions.
              <Tooltip content="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2">
                <button
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </Tooltip>
            )}
          </div>
          {customFilter !== null && (
            <Tooltip content="Reset filters">
              <button
                onClick={() => updateFilter(defaultTestFilter(!!groupResult))}
                className="flex items-center gap-1 h-7 px-2.5 rounded-md border text-[11px] font-medium cursor-pointer transition-colors bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600"
              >
                <FunnelX className="w-3 h-3" />
                <span className="lowercase">reset</span>
              </button>
            </Tooltip>
          )}
          <TagScopeFilter
            label="status"
            values={[...TEST_STATUS_ORDER]}
            off={statusOff}
            defaultOff={defaultHiddenStatuses(!!groupResult)}
            counts={statusCounts}
            onToggle={(val) => updateFilter({ ...filter, status: statusOff.includes(val) ? statusOff.filter((x) => x !== val) : [...statusOff, val] })}
            onIsolate={(val) => updateFilter({ ...filter, status: TEST_STATUS_ORDER.filter((x) => x !== val) })}
            onAll={() => updateFilter({ ...filter, status: [] })}
            onClear={() => updateFilter({ ...filter, status: [...TEST_STATUS_ORDER] })}
          />
          {/* Tests view options (were in the diff-toolbar cog): group cases into
              per-status sections, and tree by class/describe scope. Scope greys
              out when no loaded case carries one. */}
          <SettingsPopover label="Test options" width={176}>
            <SettingsGroupLabel className="mb-2">Group by</SettingsGroupLabel>
            <div className="flex flex-col gap-0.5">
              <SettingsOptionRow type="checkbox" checked={!!groupResult}
                onChange={(v) => onGroupResultChange?.(v)} label="Result" />
              <SettingsOptionRow type="checkbox" checked={!!useScope} disabled={!hasScope}
                onChange={(v) => onUseScopeChange?.(v)} label="Scope"
                title={hasScope ? undefined : 'No test case carries a class/describe scope'} />
            </div>
          </SettingsPopover>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {runners.map((r) => (
          <TestRunnerCard
            // Keyed by agent too, so switching agents remounts the cards and they
            // re-read their persisted expansion state for the new agent.
            key={`${agentId}::${r.name}`}
            projectId={projectId}
            agentId={agentId}
            runner={r}
            filter={filter}
            search={search}
            groupResult={!!groupResult}
            useScope={!!useScope}
            onRefresh={() => requestRefresh(r.name)}
            onOpenInRepo={onOpenInRepo}
            onFixCase={fixCase}
          />
        ))}
      </div>
    </div>
  )
}

function StatusIcon({ status }: { status: TestRunResult['status'] }) {
  switch (status) {
    case 'passing':
      return <Check className="w-3 h-3" strokeWidth={3} />
    case 'failing':
      return <X className="w-3 h-3" strokeWidth={3} />
    case 'running':
      return <LoaderCircle className="w-3 h-3 animate-spin" />
    default:
      return <TriangleAlert className="w-3 h-3" />
  }
}

// statusLabel is the runner chip's text. It is deliberately NOT the enum value:
// this chip is the verdict for a whole RUN, and printing `passing` raw put it two
// lines above a "group by result" section headed `passed` - a near-rhyme that read
// as an inconsistency when it is really two different scopes.
//
// The words are GitHub's commit-status vocabulary (`error | failure | pending |
// success`), onto which our states map one-to-one. So a run gets an OUTCOME noun
// and an individual case keeps its past participle (RESULT_SECTIONS below), and
// the two can no longer be mistaken for each other. Prose stays pass-as-a-verb
// ("Tests passing - 79 passed", "No passing test verdict for this commit"), the
// way GitHub's own "All checks have passed" does.
//
// `running` stays `running` rather than GitHub's `pending` - the chip is a live
// spinner carrying progress text, so naming the state beats naming the queue.
// `errored` reads `error`: the awkward participle only exists because the enum
// value can't be `error` (it collides with Go's predeclared `error` and makes
// oapi-codegen prefix the whole enum).
const STATUS_LABEL: Partial<Record<TestRunResult['status'], string>> = {
  passing: 'success',
  failing: 'failure',
  errored: 'error',
}

function statusLabel(status: TestRunResult['status']): string {
  return STATUS_LABEL[status] ?? status
}

// TestRunnerCard renders one runner through the shared CollapsibleCard, so it lays
// out identically to an artifact set card: the runner name + verdict chip +
// summary on the left, the build-log toggle and Re-run melt buttons on the right,
// and the filtered case tree / live log behind the collapse toggle.
function TestRunnerCard({ projectId, agentId, runner, filter, search, groupResult, useScope, onRefresh, onOpenInRepo, onFixCase }: {
  projectId: string
  agentId: string
  runner: TestRunResult
  filter: TestFilter
  search: string
  groupResult: boolean
  useScope: boolean
  onRefresh: () => void
  onOpenInRepo?: OpenInRepo
  // Bound to this card's runner name before it reaches the tree, so a row only
  // has to hand back the case it belongs to.
  onFixCase?: (runner: string, c: TestCase) => void
}) {
  const cases = useMemo(() => runner.cases ?? [], [runner.cases])
  // Bind this card's runner name in once, so everything below only deals in the
  // tree's own FixCase shape.
  const fixCase = useMemo<FixCase | undefined>(
    () => (onFixCase ? (c: TestCase) => onFixCase(runner.name, c) : undefined),
    [onFixCase, runner.name],
  )
  const running = runner.status === 'running'
  const errored = runner.status === 'errored'
  // A failing or errored runner reads as a failure: its log gets a red border.
  const failed = runner.status === 'failing' || errored
  const tone = verdictTone(runner.status)

  // Card + tree expansion persist per agent (keyed by runner name) so a card the
  // user opened - and the tree nodes they collapsed inside it - restore on
  // return to the agent page. Seeded once on mount; the card is remounted on
  // agent switch (via its key) so the seed re-reads the new agent's prefs.
  // Default collapsed (per design choice): every card opens via its chevron.
  const [collapsed, setCollapsedState] = useState<boolean>(
    () => loadAgentViewPrefs(projectId, agentId).testCardCollapsed?.[runner.name] ?? true,
  )
  const setCollapsed = useCallback((update: boolean | ((c: boolean) => boolean)) => {
    setCollapsedState((prev) => {
      const next = typeof update === 'function' ? update(prev) : update
      const cur = loadAgentViewPrefs(projectId, agentId).testCardCollapsed ?? {}
      patchAgentViewPrefs(projectId, agentId, { testCardCollapsed: { ...cur, [runner.name]: next } })
      return next
    })
  }, [projectId, agentId, runner.name])
  // Which tree nodes the user has collapsed within this card's case tree.
  const [treeCollapsed, setTreeCollapsed] = useState<Set<string>>(
    () => new Set(loadAgentViewPrefs(projectId, agentId).testTreeCollapsed?.[runner.name] ?? []),
  )
  const onToggleNode = useCallback((key: string) => {
    setTreeCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      const cur = loadAgentViewPrefs(projectId, agentId).testTreeCollapsed ?? {}
      patchAgentViewPrefs(projectId, agentId, { testTreeCollapsed: { ...cur, [runner.name]: [...next] } })
      return next
    })
  }, [projectId, agentId, runner.name])
  // A log exists while running (live `log`) or once settled (`log_url`).
  const hasLog = running || !!runner.log_url
  // A *build*/infra failure has no failing test cases to explain it: an exit-code-only
  // runner (its "cases" are a synthetic exit-code line whose message is just the log
  // tail), a runner that errored before producing a report, or a non-zero exit with an
  // empty report. There the log is the only surface, so we open it by default. A
  // "normal" test failure - one with actual failing cases - does NOT auto-open the log:
  // the failing-case rows explain it and the log stays tucked behind the toggle. This
  // is deliberately unlike artifact cards, which always force their log open on error;
  // here the toggle can always hide it (see the always-present button below).
  const buildFailure = failed && (runner.format === 'exit' || !cases.some((c) => c.status === 'failed'))
  // Seed the log open if the card mounts already in a build failure, and re-open it
  // whenever a runner *settles into* one - a false→true transition adjusted during
  // render (React's sanctioned pattern, same as the connKey reset above) rather than
  // in an effect. Firing only on the edge lets the user hide the log again afterward
  // without it springing back open; a re-run (false→true again) re-arms it.
  const [buildLogOpen, setBuildLogOpen] = useState(buildFailure)
  const [prevBuildFailure, setPrevBuildFailure] = useState(buildFailure)
  if (prevBuildFailure !== buildFailure) {
    setPrevBuildFailure(buildFailure)
    if (buildFailure) setBuildLogOpen(true)
  }
  // Show the log live while running (the tail is the surface), otherwise whenever the
  // toggle - or the build-failure auto-open above - has opened it.
  const logVisible = hasLog && (buildLogOpen || running)
  // An `exit`-format runner has no structured test report: its "cases" are a
  // single synthetic "(command exited 0/non-zero)" derived from the exit code,
  // whose message is just the tail of the build log. When that log is on screen
  // the case box is a pure duplicate of it, so suppress the case list and let the
  // xterm log be the only surface - the header verdict already carries the
  // pass/fail count. Keep the cases as a fallback only when there's no log to show.
  const syntheticOnly = runner.format === 'exit' && logVisible
  // The one place the status filter + search narrow this card's cases; the
  // tree (or the per-status sections) render only what survives.
  const visible = useMemo(
    () => (syntheticOnly ? [] : computeVisibleCases(cases, filter, search)),
    [syntheticOnly, cases, filter, search],
  )
  const hiddenCount = (syntheticOnly ? 0 : cases.length) - visible.length
  const toggleBuildLog = () =>
    setBuildLogOpen((o) => {
      const next = !o
      if (next) setCollapsed(false)
      return next
    })

  const status = (
    <>
      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${TONE_BADGE[tone]}`}>
        <StatusIcon status={runner.status} />
        {statusLabel(runner.status)}
      </span>
      <Summary runner={runner} />
      {/* Format + duration, right-aligned against the actions cluster. Inside the
          collapse button (rather than beside it) so the whole header row stays
          one click target. */}
      <RunnerMeta runner={runner} />
    </>
  )

  const actions = (
    <>
      {/* Show/hide the build log. Available whenever there's a log to toggle - even
          on failure, so an auto-opened build-failure log can be hidden again. It is
          always RENDERED, just disabled while the run is in flight (the log streams
          live below, so there's nothing to toggle) or when a settled run kept no
          log: the actions cluster then keeps its width, instead of the re-run button
          sliding sideways the instant a run finishes. Tinted blue while open. */}
      <Tooltip content={running ? 'Build log - streaming live below' : hasLog ? (buildLogOpen ? 'Hide build log' : 'Show build log') : 'No build log for this run'}>
        <button
          onClick={toggleBuildLog}
          disabled={running || !hasLog}
          aria-label={buildLogOpen ? 'Hide build log' : 'Show build log'}
          className={`h-7 px-2 inline-flex items-center justify-center rounded-md transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default ${
            buildLogOpen ? 'text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300' : MELT_BTN
          }`}
        >
          <ScrollText className="w-3.5 h-3.5" />
        </button>
      </Tooltip>
      {/* Re-run this runner: busts the cached verdict and runs it again. Styled
          like the artifact regenerate button (single - tests are single-sided, so
          there's no before/after side to re-run separately). */}
      <Tooltip content="Re-run this test runner">
        <button
          onClick={onRefresh}
          disabled={running}
          aria-label="Re-run this test runner"
          className={`h-7 px-2 inline-flex items-center justify-center rounded-md disabled:opacity-50 disabled:cursor-default ${MELT_BTN}`}
        >
          {/* Spins while the run is in flight (a fresh re-run flips the card to
              running immediately via the optimistic update). */}
          <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />
        </button>
      </Tooltip>
    </>
  )

  return (
    <CollapsibleCard
      sticky
      // translate-y-px optically re-centres the bottom-heavy flask glyph against
      // the lowercase runner name - geometric centering leaves it reading high.
      icon={<FlaskConical className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400 shrink-0 translate-y-px" />}
      name={runner.name}
      status={status}
      actions={actions}
      // Running: a thin progress fill under the header (card chrome) - determinate
      // (completed cases over the declared total) when the run streams a denominator,
      // an indeterminate sliding barber pole otherwise. The card owns the track.
      progress={
        running
          ? liveDenominator(runner) > 0
            ? (
              <div
                className="h-full bg-blue-500 transition-[width] duration-300"
                style={{ width: `${Math.min(100, (completedCases(runner) / liveDenominator(runner)) * 100)}%` }}
              />
            )
            : <div className="h-full w-full bg-blue-500 animate-barber-pole" />
          : undefined
      }
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((c) => !c)}
      // Toggling the build log is a deliberate in-place swap - glide the card to
      // its new height rather than snapping (nested case-tree/section expands
      // deliberately don't bump this, so they keep mirroring instantly).
      glideKey={logVisible}
    >
      {/* Build log (xterm) - live `log` while running, the persisted `log_url`
          once settled (red border on failure, green on a clean finish). */}
      {logVisible && <TestLog runner={runner} failed={failed} />}

      {/* Errored with no log to show: surface the captured error text. */}
      {errored && runner.error && !hasLog ? (
        <AnsiText
          text={runner.error}
          className="mb-2 px-3 py-2 rounded-md bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 font-mono text-xs text-yellow-700 dark:text-yellow-400 whitespace-pre-wrap break-words"
        />
      ) : null}

      {/* The filtered case tree - or its per-status sections when "Group by
          result" is on. Both take every case (badges tally everything) plus
          the filter-surviving subset actually rendered as rows. Full-bleed
          (-mx-3 cancels the card body inset). */}
      {visible.length > 0 && (
        <div className="-mx-3 flex flex-col">
          {groupResult
            ? <ResultSections cases={cases} visible={visible} useScope={useScope} onOpenInRepo={onOpenInRepo} onFixCase={fixCase} />
            : <CaseTree cases={cases} visible={visible} useScope={useScope} onOpenInRepo={onOpenInRepo} onFixCase={fixCase} toggled={treeCollapsed} onToggle={onToggleNode} />}
        </div>
      )}

      {/* What the status filter / search hid, so a quiet card never reads as
          "no tests" - the counts remain in the header regardless. */}
      {hiddenCount > 0 && (
        <div className="-mx-3 px-4 py-1.5 text-[11px] text-gray-400 dark:text-gray-500 border-t border-gray-100 dark:border-gray-800">
          {hiddenCount} case{hiddenCount === 1 ? '' : 's'} hidden by filters
        </div>
      )}
    </CollapsibleCard>
  )
}

// ResultSections renders the "Group by result" view: one section per status
// (worst first), styled as a ROOT TREE NODE - chevron + status icon + label
// with the everything-counted badge on the right, its CaseTree indented one
// level beneath it under a guide line - so the view reads as one tree whose
// first level is the result. Failed/warning sections open by default; skipped
// and passed start collapsed (folded away rather than filtered out), since
// neither is actionable and a green run can be huge - and a folded section
// mounts no rows at all (see ResultSection), so leaving it shut costs nothing
// until it is opened.
//
// The labels are the case statuses themselves (failed / skipped / passed, plus
// "warnings" as a plural noun since "warned" isn't a word anyone says about a
// test). The set used to mix tenses - "failing"/"passing" beside "skipped" -
// which also read as though the run were still going; these are settled results.
// These stay past participles precisely so they contrast with the runner chip
// above, which names a whole run's outcome instead (see STATUS_LABEL).
//
// `defaultOpen` doubles as the tree's `defaultExpanded` inside the section: a
// section worth opening on sight is worth unfolding, and one you had to open
// yourself opens a level at a time instead of dumping its whole subtree.
const RESULT_SECTIONS: { status: TestCaseStatus; label: string; defaultOpen: boolean }[] = [
  { status: TestCaseStatus.TestCaseFailed, label: 'failed', defaultOpen: true },
  { status: TestCaseStatus.TestCaseWarning, label: 'warnings', defaultOpen: true },
  { status: TestCaseStatus.TestCaseSkipped, label: 'skipped', defaultOpen: false },
  { status: TestCaseStatus.TestCasePassed, label: 'passed', defaultOpen: false },
]

function ResultSections({ cases, visible, useScope, onOpenInRepo, onFixCase }: { cases: TestCase[]; visible: TestCase[]; useScope: boolean; onOpenInRepo?: OpenInRepo; onFixCase?: FixCase }) {
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({})
  // Which nodes the user has flipped inside each section's tree, held HERE
  // rather than inside the tree: a section drops its CaseTree when it closes
  // (that's what keeps a shut wall of green free), so state kept down there
  // would be thrown away every time you folded a section and reopened it.
  const [toggled, setToggled] = useState<Record<string, Set<string>>>({})
  const toggleNode = useCallback((status: string, key: string) => {
    setToggled((prev) => {
      const next = new Set(prev[status] ?? [])
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { ...prev, [status]: next }
    })
  }, [])
  return (
    <>
      {RESULT_SECTIONS.map(({ status, label, defaultOpen }) => {
        const all = cases.filter((c) => c.status === status)
        const vis = visible.filter((c) => c.status === status)
        if (vis.length === 0) return null
        const open = openOverride[status] ?? defaultOpen
        return (
          <ResultSection
            key={status}
            status={status}
            label={label}
            all={all}
            vis={vis}
            open={open}
            onToggle={() => setOpenOverride((o) => ({ ...o, [status]: !open }))}
            defaultExpanded={defaultOpen}
            toggled={toggled[status] ?? EMPTY_KEYS}
            onToggleNode={toggleNode}
            useScope={useScope}
            onOpenInRepo={onOpenInRepo}
            onFixCase={onFixCase}
          />
        )
      })}
    </>
  )
}

// A shared empty set for sections nobody has expanded into yet, so an untouched
// section hands its tree the same identity every render (the tree memoises on it).
const EMPTY_KEYS: Set<string> = new Set()

// ResultSection is one status section. Its CaseTree body mounts on open and is
// dropped a beat after collapse (CollapseSlide), so a folded section - a wall of
// passed cases, say - builds no rows until it is opened. Same
// mount-on-open/unmount-after-glide idiom CollapsibleCard and the diff viewer's
// file bodies use for their heavy children.
function ResultSection({ status, label, all, vis, open, onToggle, defaultExpanded, toggled, onToggleNode, useScope, onOpenInRepo, onFixCase }: {
  status: TestCaseStatus
  label: string
  all: TestCase[]
  vis: TestCase[]
  open: boolean
  onToggle: () => void
  // Whether the tree inside opens fully or a level at a time (see RESULT_SECTIONS).
  defaultExpanded: boolean
  // The tree's per-node overrides, owned by ResultSections so they outlive the
  // body's unmount.
  toggled: Set<string>
  onToggleNode: (status: string, key: string) => void
  useScope: boolean
  onOpenInRepo?: OpenInRepo
  onFixCase?: FixCase
}) {
  const icon = status === 'failed' ? <X className="w-3.5 h-3.5 text-red-600 dark:text-red-400 shrink-0" strokeWidth={3} />
    : status === 'warning' ? <TriangleAlert className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
      : status === 'skipped' ? <SkipForward className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 shrink-0" />
        : <Check className="w-3.5 h-3.5 text-green-600 shrink-0" strokeWidth={3} />
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 py-1 pl-2 pr-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer min-w-0"
      >
        {/* One chevron, rotated 90° when open, so the twist animates. */}
        <ChevronRight className={`w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
        {icon}
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate min-w-0">{label}</span>
        {/* Badge counts the status's FULL tally, like every tree node. */}
        <NodeBadges counts={{ [status]: all.length }} />
      </button>
      {/* Animated open/close, matching the tree's own slide. A default-open
          section renders open from its first paint with no glide; only a user
          toggle animates. */}
      <CollapseSlide open={open}>
        <CaseTree
          cases={all}
          visible={vis}
          useScope={useScope}
          depth={1}
          rootConnect
          defaultExpanded={defaultExpanded}
          toggled={toggled}
          onToggle={(key) => onToggleNode(status, key)}
          onOpenInRepo={onOpenInRepo}
          onFixCase={onFixCase}
        />
      </CollapseSlide>
    </div>
  )
}

// completedCases is how many cases a runner has reported so far (every status).
// While a streamed run is in flight these are the ticking live tallies.
function completedCases(runner: TestRunResult): number {
  return (runner.passed ?? 0) + (runner.failed ?? 0) + (runner.warnings ?? 0) + (runner.skipped ?? 0)
}

// liveDenominator is an in-flight runner's declared ::hydra:test:total::
// denominator. The backend reports 0 (on every path - stream and poll) when no
// total was declared, so a positive total is always a real, meaningful
// denominator: we keep it even once the completed cases catch up to it, so the
// determinate bar holds at 100% instead of snapping back to the indeterminate
// pulse for "the final bit" of the run. 0 = don't show one. Settled runs always
// have total == the case sum, so this is inherently running-only.
function liveDenominator(runner: TestRunResult): number {
  const total = runner.total ?? 0
  return total > 0 ? total : 0
}

function Summary({ runner }: { runner: TestRunResult }) {
  const denom = liveDenominator(runner)
  // items-center (not items-baseline): the header height must not depend on the
  // summary's contents, or it grows by a pixel when a settled run swaps in its
  // mono `junit . 4.2s` column (see RunnerMeta) - a visible layout jump the
  // moment the loading bar finishes. Centering pins every child to the row's
  // natural height.
  return (
    <span className="flex items-center gap-2 text-sm font-medium shrink-0">
      <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
        <Check className="w-3.5 h-3.5" strokeWidth={3} />
        <span>
          {runner.passed ?? 0}
          {denom > 0 ? (
            // A "~" marks an estimated denominator carried over from a prior run
            // (the runner declared no ::hydra:test:total::).
            // Runners are a short list (one card each), so a Tooltip here is not
            // the per-row cost the native-title carve-out exists to avoid.
            <Tooltip content={runner.total_estimated ? 'Estimated total from a previous run - this run declared no test total' : undefined}>
              <span className="text-gray-400 dark:text-gray-500">
                /{runner.total_estimated ? '~' : ''}{denom}
              </span>
            </Tooltip>
          ) : null}
        </span>
      </span>
      {(runner.failed ?? 0) > 0 ? (
        <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
          <X className="w-3 h-3" strokeWidth={3} />
          {runner.failed}
        </span>
      ) : null}
      {(runner.warnings ?? 0) > 0 ? (
        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
          <TriangleAlert className="w-3 h-3" />
          {runner.warnings}
        </span>
      ) : null}
      {(runner.skipped ?? 0) > 0 ? (
        <span className="inline-flex items-center gap-1 text-gray-500">
          <SkipForward className="w-3 h-3" />
          {runner.skipped}
        </span>
      ) : null}
    </span>
  )
}

// RunnerMeta is the card header's right-hand column: the run's report format and
// its duration, mono, hugging the actions cluster (ml-auto pushes it off the
// counts, which stay left). The duration is the RIGHTMOST field and the one
// field a running card also has - the elapsed seconds ticking up from
// started_at, which become the exact wall-clock when the run settles - so the
// clock never moves sideways as a run finishes; the format simply appears to
// its left. There is deliberately no format while running: which format a run
// settles with (junit/hydra/stdout, or "exit" when it produces no report at all)
// is only known once that report has been parsed, so there is nothing honest to
// show until then.
function RunnerMeta({ runner }: { runner: TestRunResult }) {
  const running = runner.status === 'running'
  const settled = runner.duration_ms != null && runner.duration_ms > 0
  const format = !running && runner.format ? runner.format : null
  const time = settled
    ? `${((runner.duration_ms ?? 0) / 1000).toFixed(1)}s`
    : running && runner.started_at
      ? <ElapsedTime startedAt={runner.started_at} />
      : null
  // A runner is marked in-flight before it gets a slot, so "running" covers both
  // actually-running and waiting-its-turn - and test concurrency defaults to 1,
  // which makes queueing the NORMAL state for a project with several runners.
  // Without this the clock beside a queued runner reads as time spent testing.
  const queued = runner.queued ?? 0
  if (!format && !time && !queued) return null
  return (
    <span className="ml-auto pl-2 shrink-0 font-mono text-xs text-gray-400">
      {queued > 0 ? (queued === 1 ? 'queued, next' : `queued, ${queued - 1} ahead`) : format}
      {(queued > 0 || format) && time ? ' · ' : null}
      {time}
      {queued > 0 && time ? ' waiting' : null}
    </span>
  )
}

// TestLog renders the runner's build log through the shared xterm LogView: the
// live `log` lines while running, the persisted `log_url` once settled (fetched
// lazily). A failed runner gets a red border, a clean finish a green one.
function TestLog({ runner, failed }: { runner: TestRunResult; failed: boolean }) {
  const running = runner.status === 'running'
  const url = runner.log_url
  const [fetched, setFetched] = useState<ArtifactLogLine[] | null>(null)

  // Drop the fetched log while the runner is running (or has no persisted url) -
  // during render, so the next settle shows "Loading..." not the previous output.
  if ((running || !url) && fetched !== null) setFetched(null)

  useEffect(() => {
    if (running || !url) return
    let cancelled = false
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { lines?: ArtifactLogLine[] } | null) => {
        if (!cancelled && j) setFetched(j.lines ?? [])
      })
      .catch(() => {
        /* ignore; the empty-text placeholder covers it */
      })
    return () => {
      cancelled = true
    }
  }, [running, url])

  const log = running ? runner.log ?? [] : fetched ?? []
  const emptyText = running ? 'starting...' : url ? 'Loading...' : 'No output'
  return (
    <div className="pb-1">
      <LogView log={log} emptyText={emptyText} failed={failed} succeeded={!running && !failed} />
    </div>
  )
}
