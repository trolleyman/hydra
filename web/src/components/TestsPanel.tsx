import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, X, AlertTriangle, LoaderCircle, RotateCcw, ChevronRight, ChevronDown, SkipForward, FlaskConical } from 'lucide-react'
import { api } from '../stores/apiClient'
import type { TestRunResult } from '../api/models/TestRunResult'
import type { TestCase } from '../api/models/TestCase'
import { verdictTone } from './TestVerdict'
import { TONE_BADGE } from './Badge'

// TestsPanel renders the head's test-runner verdicts (PLAN #68): single-sided
// (no before/after columns), failing cases first, with a live log tail while a
// run is in flight. Polls while any runner is still running.
export function TestsPanel({ projectId, agentId }: { projectId: string; agentId: string }) {
  const [runners, setRunners] = useState<TestRunResult[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(
    async (refresh?: string) => {
      try {
        const resp = await api.default.getAgentTests(projectId, agentId, undefined, undefined, refresh)
        setRunners(resp.runners)
      } catch {
        // leave previous state; a transient error shouldn't blank the panel
      } finally {
        setLoading(false)
        setRefreshing(null)
      }
    },
    [projectId, agentId],
  )

  useEffect(() => {
    void load()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [load])

  // Poll while any runner is still running, so the live log + counts advance.
  useEffect(() => {
    const anyRunning = runners.some((r) => r.status === 'running')
    if (!anyRunning) return
    timer.current = setTimeout(() => void load(), 1500)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [runners, load])

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-gray-500">
        <LoaderCircle className="w-4 h-4 animate-spin" /> Loading tests…
      </div>
    )
  }
  if (runners.length === 0) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-gray-500">
        <FlaskConical className="w-4 h-4" /> No test runners configured. Add a <code className="font-mono text-xs">[[tests]]</code> entry in <code className="font-mono text-xs">.hydra/config.toml</code>.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-2">
      {runners.map((r) => (
        <RunnerCard
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
  )
}

function StatusIcon({ status }: { status: TestRunResult['status'] }) {
  switch (status) {
    case 'passing':
      return <Check className="w-4 h-4" strokeWidth={3} />
    case 'failing':
      return <X className="w-4 h-4" strokeWidth={3} />
    case 'running':
      return <LoaderCircle className="w-4 h-4 animate-spin" />
    default:
      return <AlertTriangle className="w-4 h-4" />
  }
}

function RunnerCard({ runner, onRefresh, refreshing }: { runner: TestRunResult; onRefresh: () => void; refreshing: boolean }) {
  const cases = runner.cases ?? []
  const failing = cases.filter((c) => c.status === 'failed')
  const passing = cases.filter((c) => c.status === 'passed')
  const skipped = cases.filter((c) => c.status === 'skipped')
  const [showPassing, setShowPassing] = useState(false)
  const tone = verdictTone(runner.status)

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/40">
        <FlaskConical className="w-4 h-4 text-gray-400" />
        <span className="font-medium text-sm">{runner.name}</span>
        <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${TONE_BADGE[tone]}`}>
          <StatusIcon status={runner.status} />
          {runner.status}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <Summary runner={runner} />
          <button
            onClick={onRefresh}
            disabled={refreshing || runner.status === 'running'}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
            title="Re-run this test runner"
          >
            <RotateCcw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} /> Re-run
          </button>
        </div>
      </div>

      {/* Running: live log tail + progress */}
      {runner.status === 'running' ? <RunningBody runner={runner} /> : null}

      {/* Errored */}
      {runner.status === 'errored' && runner.error ? (
        <div className="px-4 py-3 text-xs font-mono text-yellow-700 dark:text-yellow-400 whitespace-pre-wrap">{runner.error}</div>
      ) : null}

      {/* Failing cases first */}
      {failing.length > 0 ? (
        <div className="flex flex-col">
          {failing.map((c, i) => (
            <FailingCase key={i} c={c} />
          ))}
        </div>
      ) : null}

      {/* Collapsed passing / skipped rows */}
      {passing.length > 0 ? (
        <button
          onClick={() => setShowPassing((s) => !s)}
          className="flex items-center gap-2 px-4 py-2 text-sm border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40 text-left"
        >
          {showPassing ? <ChevronDown className="w-3 h-3 text-gray-400" /> : <ChevronRight className="w-3 h-3 text-gray-400" />}
          <Check className="w-3.5 h-3.5 text-green-600" strokeWidth={3} />
          <span className="font-medium">{passing.length} passing</span>
        </button>
      ) : null}
      {showPassing ? (
        <div className="flex flex-col bg-gray-50/50 dark:bg-gray-800/20">
          {passing.map((c, i) => (
            <div key={i} className="flex items-center gap-2 px-8 py-1 text-xs font-mono text-gray-600 dark:text-gray-400">
              <Check className="w-3 h-3 text-green-600" strokeWidth={3} /> {c.name}
            </div>
          ))}
        </div>
      ) : null}
      {skipped.length > 0 ? (
        <div className="flex items-center gap-2 px-4 py-2 text-sm border-t border-gray-100 dark:border-gray-800 text-gray-500">
          <SkipForward className="w-3.5 h-3.5" />
          <span className="font-medium">{skipped.length} skipped</span>
        </div>
      ) : null}
    </div>
  )
}

function Summary({ runner }: { runner: TestRunResult }) {
  return (
    <span className="flex items-center gap-2 text-sm font-medium">
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
    <div className="flex flex-col gap-1.5 px-4 py-2.5 border-t border-gray-100 dark:border-gray-800 bg-red-50/40 dark:bg-red-900/10">
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

function RunningBody({ runner }: { runner: TestRunResult }) {
  const log = runner.log ?? []
  return (
    <div className="flex flex-col">
      <div className="h-1 bg-gray-100 dark:bg-gray-800 overflow-hidden">
        <div className="h-full bg-blue-500 animate-pulse w-1/2" />
      </div>
      <div className="px-4 py-3 font-mono text-[11px] leading-relaxed max-h-48 overflow-auto bg-gray-900 text-gray-200">
        {log.length === 0 ? <div className="text-gray-500">starting…</div> : null}
        {log.map((l, i) => (
          <div key={i} className={l.stream === 'stderr' ? 'text-red-400' : 'text-gray-200'}>
            {l.text}
          </div>
        ))}
      </div>
    </div>
  )
}
