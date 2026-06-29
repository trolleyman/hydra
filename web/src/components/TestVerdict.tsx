import { Check, X, AlertTriangle, Clock, LoaderCircle, SkipForward } from 'lucide-react'
import { Badge, type Tone } from './Badge'
import type { TestSummary } from '../api/models/TestSummary'
import type { TestStatus } from '../api/models/TestStatus'

// Verdict → tone, the single source of truth for the test-gate chip colors
// (PLAN #68, design 2026-06-29). passing=green, failing=red, running=blue,
// errored=YELLOW (a "couldn't run / we don't know" caution, with a warning
// triangle — distinct from a red failure), stale=gray (dashed). Skipped is NEVER
// its own verdict and renders GRAY inline (amber would imply a warning a skipped
// test doesn't warrant — per user).
export function verdictTone(status: TestStatus): Tone {
  switch (status) {
    case 'passing':
      return 'green'
    case 'failing':
      return 'red'
    case 'running':
      return 'blue'
    case 'errored':
      return 'yellow'
    default:
      return 'neutral' // stale / none
  }
}

function VerdictIcon({ status, className = 'w-3 h-3' }: { status: TestStatus; className?: string }) {
  switch (status) {
    case 'passing':
      return <Check className={className} strokeWidth={3} />
    case 'failing':
      return <X className={className} strokeWidth={3} />
    case 'running':
      return <LoaderCircle className={`${className} animate-spin`} />
    case 'errored':
      return <AlertTriangle className={className} />
    case 'stale':
      return <Clock className={className} />
    default:
      return null
  }
}

// SkippedCount renders the gray skip-forward marker that rides on a passing chip
// after a divider (✓ 142 │ ▸| 3). Gray, never amber, never the ⊘ "no-entry" glyph.
function SkippedCount({ n }: { n: number }) {
  if (n <= 0) return null
  return (
    <span className="inline-flex items-center gap-0.5 pl-1 ml-0.5 border-l border-current/30 text-gray-500 dark:text-gray-400">
      <SkipForward className="w-2.5 h-2.5" />
      {n}
    </span>
  )
}

// verdictLabel is the chip's text for each state.
function verdictLabel(t: TestSummary): string {
  switch (t.status) {
    case 'passing':
      return `${t.passed ?? 0}`
    case 'failing':
      return `${t.failed ?? 0} failed`
    case 'running':
      return t.progress ? t.progress : 'running'
    case 'errored':
      return "couldn't run"
    case 'stale':
      return `${t.passed ?? 0} · stale`
    default:
      return ''
  }
}

// TestVerdictChip is the compact per-head verdict chip shown in the sidebar row
// and the agent header. Renders nothing for status "none" (no tests / never run).
export function TestVerdictChip({ tests, variant = 'xs' }: { tests?: TestSummary | null; variant?: 'xs' | 'sm' }) {
  if (!tests || tests.status === 'none') return null
  const tone = verdictTone(tests.status)
  const stale = tests.status === 'stale'
  const showSkips = tests.status === 'passing' || tests.status === 'stale'
  return (
    <Badge
      tone={tone}
      variant={variant}
      icon={<VerdictIcon status={tests.status} className="w-3 h-3" />}
      title={verdictTitle(tests)}
      className={stale ? 'inline-flex items-center gap-1 text-gray-500 dark:text-gray-400 border border-dashed border-gray-400 dark:border-gray-600 rounded px-1 py-0.5' : undefined}
    >
      <span className="inline-flex items-center">
        {verdictLabel(tests)}
        {showSkips ? <SkippedCount n={tests.skipped ?? 0} /> : null}
      </span>
    </Badge>
  )
}

function verdictTitle(t: TestSummary): string {
  switch (t.status) {
    case 'passing':
      return `Tests passing — ${t.passed ?? 0} passed${t.skipped ? `, ${t.skipped} skipped` : ''}`
    case 'failing':
      return `Tests failing — ${t.failed ?? 0} failed (merge is soft-gated)`
    case 'running':
      return `Tests running${t.progress ? ` — ${t.progress}` : ''}`
    case 'errored':
      return "Tests couldn't run — no verdict (retry, or force-merge)"
    case 'stale':
      return 'Test verdict is stale — it predates the latest commit; re-run'
    default:
      return ''
  }
}
