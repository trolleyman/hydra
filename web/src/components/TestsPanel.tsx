import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Check, X, AlertTriangle, LoaderCircle, RefreshCw, RotateCcw, ScrollText, ChevronRight, Search, SkipForward, FlaskConical } from 'lucide-react'
import { linkOptions } from '@tanstack/react-router'
import { api } from '../stores/apiClient'
import type { TestRunResult } from '../api/models/TestRunResult'
import type { TestCase } from '../api/models/TestCase'
import { TestCaseStatus } from '../api/models/TestCaseStatus'
import type { ArtifactLogLine } from '../api'
import { TONE_BADGE, verdictTone } from './badgeTones'
import { CollapsibleCard, MELT_BTN } from './CollapsibleCard'
import { useMeasuredHeight } from '../lib/useMeasuredHeight'
import { LogView } from './ArtifactLogView'
import { InfoTooltip } from './InfoTooltip'
import { TagScopeFilter } from './ArtifactFilterBar'
import { CaseTree, NodeBadges, type OpenInRepo } from './CaseTree'
import { loadAgentViewPrefs, patchAgentViewPrefs } from '../lib/agentViewPrefs'
import { formatLineHash } from '../lib/lineRange'
import { closeWebSocket } from '../lib/ws'
import {
  TEST_STATUS_ORDER, type TestFilter,
  defaultHiddenStatuses, defaultTestFilter, isDefaultTestFilter, loadTestFilter, saveTestFilter,
  computeVisibleCases, computeStatusCounts,
} from '../lib/testFilterPrefs'

// Server→client message on the tests WebSocket. Mirrors internal/http/tests_ws.go.
// Single-sided (no before/after), so a runner is addressed by name alone.
type TestWSCounts = {
  passed: number
  failed: number
  skipped: number
  warnings: number
  total: number // denominator, 0 = unknown
  total_estimated?: boolean // total is a carried-over estimate (no ::hydra:test:total::)
  cases?: TestCase[]
}
type TestWSMessage =
  | { type: 'snapshot'; runners: TestRunResult[] }
  | { type: 'runner'; runner: TestRunResult }
  | { type: 'log'; name: string; line: ArtifactLogLine }
  | { type: 'progress'; name: string; progress: string }
  | { type: 'counts'; name: string; counts: TestWSCounts }

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
export function TestsPanel({ projectId, agentId, repoRef, headRef, includeUncommitted, refreshKey, groupResult, useScope, onScopeAvailable }: {
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
  // View modes from the diff viewer's settings cog (see AgentViewPrefs):
  // groupResult renders per-status sections, useScope trees by class/describe
  // scope instead of filesystem path.
  groupResult?: boolean
  useScope?: boolean
  // Reports whether any loaded case carries a logical scope, so the cog can
  // grey the "Group by scope" checkbox when the axis doesn't exist.
  onScopeAvailable?: (has: boolean) => void
}) {
  // null = not yet loaded (render nothing); [] = loaded, nothing configured.
  const [runners, setRunners] = useState<TestRunResult[] | null>(null)
  // Connection mode: WS while live, polling if the socket can't connect or drops.
  const [mode, setMode] = useState<'connecting' | 'ws' | 'poll'>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Manual-refresh state for the polling fallback (the WS path sends a message
  // instead): stash the runner name and bump the nonce to re-run the poll effect.
  const [refreshNonce, setRefreshNonce] = useState(0)
  const refreshRunnerRef = useRef<string | null>(null)

  // Apply a server→client WS message to local state.
  const applyMessage = useCallback((msg: TestWSMessage) => {
    if (msg.type === 'snapshot') {
      setRunners(msg.runners ?? [])
    } else if (msg.type === 'runner') {
      setRunners((prev) => (prev ? prev.map((r) => (r.name === msg.runner.name ? msg.runner : r)) : [msg.runner]))
    } else if (msg.type === 'log') {
      setRunners((prev) => prev?.map((r) => (r.name === msg.name ? { ...r, log: [...(r.log ?? []), msg.line] } : r)) ?? prev)
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
  }, [])

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
      try { applyMessage(JSON.parse(e.data) as TestWSMessage) } catch { /* ignore malformed frames */ }
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
        if (resp.runners.some((r) => r.status === 'running')) {
          pollTimerRef.current = setTimeout(() => tick(false), 1500)
        }
      } catch {
        // leave previous state; a transient error shouldn't blank the panel
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
      params: { projectId, _splat: `${repoRef}/${path}` },
      hash: line != null && line > 0 ? formatLineHash(line, line) : undefined,
    })
  }, [projectId, repoRef])
  const hasScope = useMemo(() => allCases.some((c) => (c.scope?.length ?? 0) > 0), [allCases])
  useEffect(() => { onScopeAvailable?.(hasScope) }, [hasScope, onScopeAvailable])

  // Nothing configured (or not loaded yet) → render nothing, like the artifacts
  // panel, so the diff viewer doesn't reserve empty space for an absent feature.
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
        {runningCount > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] font-normal text-gray-400 dark:text-gray-500">
            <LoaderCircle className="w-3 h-3 animate-spin" />
            Running {runners.length - runningCount}/{runners.length}
          </span>
        )}
        <InfoTooltip title="Tests" width={520}>
          <p>Per-runner pass/fail verdicts for the selected commit - the diff viewer's <strong>after</strong> side (a commit, or your uncommitted working tree), defaulting to the branch tip. Single-sided: there's no before/after comparison.</p>
          <p>Each runner is a project-defined <code className="text-blue-300">[[tests]]</code> command in <code className="text-blue-300">.hydra/config.toml</code>. Hydra runs it against the ref, parses the report it writes to <code className="text-blue-300">$HYDRA_TEST_OUTPUT</code> (JUnit XML or Hydra-JSON; otherwise a plain pass/fail from the exit code), and caches the verdict per commit. The verdict <strong>soft-gates the merge button</strong> - a failing run needs a force-merge.</p>
          <p>Expand a card for its cases as a location tree - <strong>passing and skipped cases are hidden by default</strong> (grouping by result hides nothing; its sections fold them away instead); the status filter (right) reveals them, and the search box fuzzy-matches case paths and names. Node tallies always count everything beneath, filtered or not. The changes cog offers grouping by result and by class/describe scope. The <strong>build log</strong> (the scroll icon) is the runner's stdout/stderr, streamed live while it runs. The refresh icon re-runs that runner, discarding the cached verdict.</p>
        </InfoTooltip>
        {/* Filter cluster, right-floated - the tests analog of ArtifactFilterBar:
            search + reset + the status scope dropdown (passing hidden by default). */}
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
              <button
                onClick={() => setSearch('')}
                title="Clear search"
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          {customFilter !== null && (
            <button
              onClick={() => updateFilter(defaultTestFilter(!!groupResult))}
              title="Reset filters"
              className="flex items-center gap-1 h-7 px-2.5 rounded-md border text-[11px] font-medium cursor-pointer transition-colors bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600"
            >
              <RotateCcw className="w-3 h-3" />
              <span className="lowercase">reset</span>
            </button>
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
      return <AlertTriangle className="w-3 h-3" />
  }
}

// TestRunnerCard renders one runner through the shared CollapsibleCard, so it lays
// out identically to an artifact set card: the runner name + verdict chip +
// summary on the left, the build-log toggle and Re-run melt buttons on the right,
// and the filtered case tree / live log behind the collapse toggle.
function TestRunnerCard({ projectId, agentId, runner, filter, search, groupResult, useScope, onRefresh, onOpenInRepo }: {
  projectId: string
  agentId: string
  runner: TestRunResult
  filter: TestFilter
  search: string
  groupResult: boolean
  useScope: boolean
  onRefresh: () => void
  onOpenInRepo?: OpenInRepo
}) {
  const cases = useMemo(() => runner.cases ?? [], [runner.cases])
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
        {runner.status}
      </span>
      <Summary runner={runner} />
    </>
  )

  const actions = (
    <>
      {/* Show/hide the build log. Available whenever there's a log to show - even
          on failure, so an auto-opened build-failure log can be hidden again. Only
          suppressed while running, where it streams live and there's nothing to
          toggle. Tinted blue while open. */}
      {hasLog && !running && (
        <button
          onClick={toggleBuildLog}
          title={buildLogOpen ? 'Hide build log' : 'Show build log'}
          aria-label={buildLogOpen ? 'Hide build log' : 'Show build log'}
          className={`h-7 px-2 inline-flex items-center justify-center rounded-md transition-colors cursor-pointer ${
            buildLogOpen ? 'text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300' : MELT_BTN
          }`}
        >
          <ScrollText className="w-3.5 h-3.5" />
        </button>
      )}
      {/* Re-run this runner: busts the cached verdict and runs it again. Styled
          like the artifact regenerate button (single - tests are single-sided, so
          there's no before/after side to re-run separately). */}
      <button
        onClick={onRefresh}
        disabled={running}
        title="Re-run this test runner"
        aria-label="Re-run this test runner"
        className={`h-7 px-2 inline-flex items-center justify-center rounded-md disabled:opacity-50 ${MELT_BTN}`}
      >
        {/* Spins while the run is in flight (a fresh re-run flips the card to
            running immediately via the optimistic update). */}
        <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />
      </button>
    </>
  )

  return (
    <CollapsibleCard
      sticky
      icon={<FlaskConical className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400 shrink-0" />}
      name={runner.name}
      status={status}
      actions={actions}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((c) => !c)}
    >
      {/* Running: a thin progress bar above the live log tail - determinate
          (completed cases over the declared total) when the run streams a
          denominator, an indeterminate sliding barber pole otherwise. */}
      {running && (
        <div className="mt-1 h-1 rounded bg-gray-100 dark:bg-gray-800 overflow-hidden">
          {liveDenominator(runner) > 0 ? (
            <div
              className="h-full bg-blue-500 transition-[width] duration-300"
              style={{ width: `${Math.min(100, (completedCases(runner) / liveDenominator(runner)) * 100)}%` }}
            />
          ) : (
            <div className="h-full w-full bg-blue-500 animate-barber-pole" />
          )}
        </div>
      )}

      {/* Build log (xterm) - live `log` while running, the persisted `log_url`
          once settled (red border on failure, green on a clean finish). */}
      {logVisible && <TestLog runner={runner} failed={failed} />}

      {/* Errored with no log to show: surface the captured error text. */}
      {errored && runner.error && !hasLog ? (
        <div className="my-2 px-3 py-2 rounded-md bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 font-mono text-xs text-yellow-700 dark:text-yellow-400 whitespace-pre-wrap break-words">
          {runner.error}
        </div>
      ) : null}

      {/* The filtered case tree - or its per-status sections when "Group by
          result" is on. Both take every case (badges tally everything) plus
          the filter-surviving subset actually rendered as rows. Full-bleed
          (-mx-3 cancels the card body inset). */}
      {visible.length > 0 && (
        <div className="-mx-3 mt-1 flex flex-col border-t border-gray-100 dark:border-gray-800">
          {groupResult
            ? <ResultSections cases={cases} visible={visible} useScope={useScope} onOpenInRepo={onOpenInRepo} />
            : <CaseTree cases={cases} visible={visible} useScope={useScope} onOpenInRepo={onOpenInRepo} collapsed={treeCollapsed} onToggle={onToggleNode} />}
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
// first level is the result. Failing/warning sections open by default;
// skipped/passing start collapsed (folded away rather than filtered out).
const RESULT_SECTIONS: { status: TestCaseStatus; label: string; defaultOpen: boolean }[] = [
  { status: TestCaseStatus.TestCaseFailed, label: 'failing', defaultOpen: true },
  { status: TestCaseStatus.TestCaseWarning, label: 'warnings', defaultOpen: true },
  { status: TestCaseStatus.TestCaseSkipped, label: 'skipped', defaultOpen: false },
  { status: TestCaseStatus.TestCasePassed, label: 'passing', defaultOpen: false },
]

function ResultSections({ cases, visible, useScope, onOpenInRepo }: { cases: TestCase[]; visible: TestCase[]; useScope: boolean; onOpenInRepo?: OpenInRepo }) {
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({})
  return (
    <>
      {RESULT_SECTIONS.map(({ status, label, defaultOpen }) => {
        const all = cases.filter((c) => c.status === status)
        const vis = visible.filter((c) => c.status === status)
        if (vis.length === 0) return null
        const open = openOverride[status] ?? defaultOpen
        const icon = status === 'failed' ? <X className="w-3.5 h-3.5 text-red-600 dark:text-red-400 shrink-0" strokeWidth={3} />
          : status === 'warning' ? <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
            : status === 'skipped' ? <SkipForward className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 shrink-0" />
              : <Check className="w-3.5 h-3.5 text-green-600 shrink-0" strokeWidth={3} />
        return (
          <div key={status}>
            <button
              onClick={() => setOpenOverride((o) => ({ ...o, [status]: !open }))}
              className="flex w-full items-center gap-1.5 py-1 pl-2 pr-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer min-w-0"
            >
              {/* One chevron, rotated 90° when open, so the twist animates. */}
              <ChevronRight className={`w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
              {icon}
              <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate min-w-0">{label}</span>
              {/* Badge counts the status's FULL tally, like every tree node. */}
              <NodeBadges counts={{ [status]: all.length }} />
            </button>
            {/* Hard open/close - the section snaps between shown and hidden (no
                grid-row slide) to match the cards' instant expand. */}
            <div className={`grid ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
              <div className="overflow-hidden min-h-0">
                <CaseTree cases={all} visible={vis} useScope={useScope} depth={1} rootConnect onOpenInRepo={onOpenInRepo} />
              </div>
            </div>
          </div>
        )
      })}
    </>
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
  return (
    <span className="flex items-center gap-2 text-sm font-medium shrink-0">
      <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
        <Check className="w-3.5 h-3.5" strokeWidth={3} />
        <span>
          {runner.passed ?? 0}
          {denom > 0 ? (
            // A "~" marks an estimated denominator carried over from a prior run
            // (the runner declared no ::hydra:test:total::).
            <span
              className="text-gray-400 dark:text-gray-500"
              title={runner.total_estimated ? 'Estimated total from a previous run - this run declared no test total' : undefined}
            >
              /{runner.total_estimated ? '~' : ''}{denom}
            </span>
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
          <AlertTriangle className="w-3 h-3" />
          {runner.warnings}
        </span>
      ) : null}
      {(runner.skipped ?? 0) > 0 ? (
        <span className="inline-flex items-center gap-1 text-gray-500">
          <SkipForward className="w-3 h-3" />
          {runner.skipped}
        </span>
      ) : null}
      {runner.duration_ms != null && runner.duration_ms > 0 ? (
        <span className="font-mono text-xs text-gray-400">· {(runner.duration_ms / 1000).toFixed(1)}s</span>
      ) : null}
      {runner.format ? <span className="font-mono text-xs text-gray-400">· {runner.format}</span> : null}
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
    <div className="pt-1.5 pb-1">
      <LogView log={log} emptyText={emptyText} failed={failed} succeeded={!running && !failed} />
    </div>
  )
}
