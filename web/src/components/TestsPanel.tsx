import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, X, AlertTriangle, LoaderCircle, RefreshCw, ScrollText, ChevronRight, ChevronDown, SkipForward, FlaskConical } from 'lucide-react'
import { api } from '../stores/apiClient'
import type { TestRunResult } from '../api/models/TestRunResult'
import type { TestCase } from '../api/models/TestCase'
import type { ArtifactLogLine } from '../api'
import { verdictTone } from './TestVerdict'
import { TONE_BADGE } from './Badge'
import { CollapsibleCard, MELT_BTN } from './CollapsibleCard'
import { LogView } from './ArtifactLogView'
import { InfoTooltip } from './InfoTooltip'

// TestsPanel renders the head's test-runner verdicts (PLAN #68), styled to match
// the artifacts panel: a "Tests (i)" header over one collapsible card per
// [[tests]] runner. Single-sided — there is no before/after comparison; it reports
// the verdict for whatever the diff viewer has selected as the "after" side (a
// commit, or the uncommitted working tree), defaulting to the branch tip. Polls
// while any runner is still running so the live log + counts advance.
export function TestsPanel({ projectId, agentId, headRef, includeUncommitted, refreshKey }: {
  projectId: string
  agentId: string
  // The "after" commit/ref to test, mirrored from the diff viewer's right-hand
  // selector. Undefined → the agent's branch tip. includeUncommitted tests the
  // working tree instead of a commit.
  headRef?: string
  includeUncommitted?: boolean
  // Bumped by the diff viewer's refresh control to force a fresh fetch.
  refreshKey?: number
}) {
  const [runners, setRunners] = useState<TestRunResult[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(
    async (refresh?: string) => {
      try {
        const resp = await api.default.getAgentTests(projectId, agentId, headRef, includeUncommitted, refresh)
        setRunners(resp.runners)
      } catch {
        // leave previous state; a transient error shouldn't blank the panel
      } finally {
        setLoading(false)
        setRefreshing(null)
      }
    },
    [projectId, agentId, headRef, includeUncommitted],
  )

  // Fetch on mount and whenever the selected ref / refresh trigger changes.
  useEffect(() => {
    void load()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [load, refreshKey])

  // Poll while any runner is still running, so the live log + counts advance.
  useEffect(() => {
    const anyRunning = runners.some((r) => r.status === 'running')
    if (!anyRunning) return
    timer.current = setTimeout(() => void load(), 1500)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [runners, load])

  // Nothing configured (or not loaded yet) → render nothing, like the artifacts
  // panel, so the diff viewer doesn't reserve empty space for an absent feature.
  if (loading || runners.length === 0) return null

  const runningCount = runners.filter((r) => r.status === 'running').length

  return (
    <div className="mb-4">
      {/* Reserve the row height so the header doesn't jump when the running
          progress chip appears/disappears. */}
      <div className="flex flex-wrap items-center gap-2 mb-2 min-h-[1.625rem]">
        <FlaskConical className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
        <h3 className="text-xs font-semibold tracking-wide text-gray-500 dark:text-gray-400">Tests</h3>
        {runningCount > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] font-normal text-gray-400 dark:text-gray-500">
            <LoaderCircle className="w-3 h-3 animate-spin" />
            Running {runners.length - runningCount}/{runners.length}
          </span>
        )}
        <InfoTooltip title="Tests" width={520}>
          <p>Per-runner pass/fail verdicts for the selected commit — the diff viewer's <strong>after</strong> side (a commit, or your uncommitted working tree), defaulting to the branch tip. Single-sided: there's no before/after comparison.</p>
          <p>Each runner is a project-defined <code className="text-blue-300">[[tests]]</code> command in <code className="text-blue-300">.hydra/config.toml</code>. Hydra runs it against the ref, parses the report it writes to <code className="text-blue-300">$HYDRA_TEST_OUTPUT</code> (JUnit XML or Hydra-JSON; otherwise a plain pass/fail from the exit code), and caches the verdict per commit. The verdict <strong>soft-gates the merge button</strong> — a failing run needs a force-merge.</p>
          <p>Expand a card for the failing cases (assertion messages first), the passing / skipped roll-ups, and the <strong>build log</strong> (the scroll icon) — the runner's stdout/stderr, streamed live while it runs. The refresh icon re-runs that runner, discarding the cached verdict.</p>
        </InfoTooltip>
      </div>
      <div className="flex flex-col gap-2">
        {runners.map((r) => (
          <TestRunnerCard
            key={r.name}
            runner={r}
            refreshing={refreshing === r.name}
            onRefresh={() => {
              setRefreshing(r.name)
              void load(r.name)
            }}
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
// and the failing-first case list / live log behind the collapse toggle.
function TestRunnerCard({ runner, onRefresh, refreshing }: { runner: TestRunResult; onRefresh: () => void; refreshing: boolean }) {
  const cases = runner.cases ?? []
  const failing = cases.filter((c) => c.status === 'failed')
  const passing = cases.filter((c) => c.status === 'passed')
  const skipped = cases.filter((c) => c.status === 'skipped')
  const running = runner.status === 'running'
  const errored = runner.status === 'errored'
  // A failing or errored runner reads as a failure: its log gets a red border and
  // auto-opens (the error detail), mirroring a failed artifact card.
  const failed = runner.status === 'failing' || errored
  const tone = verdictTone(runner.status)

  // Default collapsed (per design choice): every card opens via its chevron.
  const [collapsed, setCollapsed] = useState(true)
  const [showPassing, setShowPassing] = useState(false)
  // A log exists while running (live `log`) or once settled (`log_url`). It's
  // force-shown while running (the tail is the surface) and on failure (the error
  // detail); otherwise it's behind the header toggle.
  const hasLog = running || !!runner.log_url
  const [buildLogOpen, setBuildLogOpen] = useState(false)
  // Only show the log when there's actually one to show: live while running,
  // force-shown on failure (the error surface), else behind the toggle. A failing
  // runner that captured no log (e.g. a JUnit report with no stdout) shows its
  // cases instead of an empty "No output" terminal.
  const logVisible = hasLog && (buildLogOpen || running || failed)
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
      {/* Show/hide the build log. Suppressed while running / failed, where it's
          force-shown (nothing to toggle). Tinted blue while open. */}
      {hasLog && !running && !failed && (
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
          like the artifact regenerate button (single — tests are single-sided, so
          there's no before/after side to re-run separately). */}
      <button
        onClick={onRefresh}
        disabled={refreshing || running}
        title="Re-run this test runner"
        aria-label="Re-run this test runner"
        className={`h-7 px-2 inline-flex items-center justify-center rounded-md disabled:opacity-50 ${MELT_BTN}`}
      >
        <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
      </button>
    </>
  )

  return (
    <CollapsibleCard
      icon={<FlaskConical className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400 shrink-0" />}
      name={runner.name}
      status={status}
      actions={actions}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((c) => !c)}
    >
      {/* Running: a thin progress bar above the live log tail. */}
      {running && (
        <div className="mt-1 h-1 rounded bg-gray-100 dark:bg-gray-800 overflow-hidden">
          <div className="h-full bg-blue-500 animate-pulse w-1/2" />
        </div>
      )}

      {/* Build log (xterm) — live `log` while running, the persisted `log_url`
          once settled (red border on failure, green on a clean finish). */}
      {logVisible && <TestLog runner={runner} failed={failed} />}

      {/* Errored with no log to show: surface the captured error text. */}
      {errored && runner.error && !hasLog ? (
        <div className="my-2 px-3 py-2 rounded-md bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 font-mono text-xs text-yellow-700 dark:text-yellow-400 whitespace-pre-wrap break-words">
          {runner.error}
        </div>
      ) : null}

      {/* Failing cases first (assertion messages inline). Full-bleed rows (-mx-3
          cancels the card body inset) so they read like the existing impl. */}
      {failing.length > 0 && (
        <div className="-mx-3 mt-1 flex flex-col border-t border-gray-100 dark:border-gray-800">
          {failing.map((c, i) => (
            <FailingCase key={i} c={c} />
          ))}
        </div>
      )}

      {/* Collapsed passing roll-up. */}
      {passing.length > 0 && (
        <div className="-mx-3">
          <button
            onClick={() => setShowPassing((s) => !s)}
            className="flex w-full items-center gap-2 px-4 py-2 text-sm border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40 text-left"
          >
            {showPassing ? <ChevronDown className="w-3 h-3 text-gray-400" /> : <ChevronRight className="w-3 h-3 text-gray-400" />}
            <Check className="w-3.5 h-3.5 text-green-600" strokeWidth={3} />
            <span className="font-medium">{passing.length} passing</span>
          </button>
          {showPassing && (
            <div className="flex flex-col bg-gray-50/50 dark:bg-gray-800/20">
              {passing.map((c, i) => (
                <div key={i} className="flex items-center gap-2 px-8 py-1 text-xs font-mono text-gray-600 dark:text-gray-400">
                  <Check className="w-3 h-3 text-green-600" strokeWidth={3} /> {c.name}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Skipped roll-up. */}
      {skipped.length > 0 && (
        <div className="-mx-3 flex items-center gap-2 px-4 py-2 text-sm border-t border-gray-100 dark:border-gray-800 text-gray-500">
          <SkipForward className="w-3.5 h-3.5" />
          <span className="font-medium">{skipped.length} skipped</span>
        </div>
      )}
    </CollapsibleCard>
  )
}

function Summary({ runner }: { runner: TestRunResult }) {
  return (
    <span className="flex items-center gap-2 text-sm font-medium shrink-0">
      <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
        <Check className="w-3.5 h-3.5" strokeWidth={3} />
        {runner.passed ?? 0}
      </span>
      {(runner.failed ?? 0) > 0 ? (
        <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
          <X className="w-3 h-3" strokeWidth={3} />
          {runner.failed}
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

function FailingCase({ c }: { c: TestCase }) {
  return (
    <div className="flex flex-col gap-1.5 px-4 py-2.5 border-t border-gray-100 dark:border-gray-800 bg-red-50/40 dark:bg-red-900/10 first:border-t-0">
      <div className="flex items-center gap-2">
        <X className="w-3.5 h-3.5 text-red-600 dark:text-red-400 shrink-0" strokeWidth={3} />
        <span className="font-mono text-xs font-medium">{c.name}</span>
        {c.duration_ms != null ? <span className="ml-auto font-mono text-[10px] text-gray-400">{c.duration_ms}ms</span> : null}
      </div>
      {c.message ? (
        <pre className="ml-5 text-[11px] font-mono whitespace-pre-wrap text-red-700 dark:text-red-300 bg-red-100/50 dark:bg-red-900/20 border border-red-200/60 dark:border-red-900/40 rounded px-2.5 py-1.5">
          {c.message}
        </pre>
      ) : null}
    </div>
  )
}

// TestLog renders the runner's build log through the shared xterm LogView: the
// live `log` lines while running, the persisted `log_url` once settled (fetched
// lazily). A failed runner gets a red border, a clean finish a green one.
function TestLog({ runner, failed }: { runner: TestRunResult; failed: boolean }) {
  const running = runner.status === 'running'
  const url = runner.log_url
  const [fetched, setFetched] = useState<ArtifactLogLine[] | null>(null)

  useEffect(() => {
    if (running || !url) {
      setFetched(null)
      return
    }
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
  const emptyText = running ? 'starting…' : url ? 'Loading…' : 'No output'
  return (
    <div className="pt-1.5 pb-1">
      <LogView log={log} emptyText={emptyText} failed={failed} succeeded={!running && !failed} />
    </div>
  )
}
