import { Check, X, AlertTriangle, Clock, SkipForward } from 'lucide-react'
import { Badge } from './Badge'
import { verdictTone } from './badgeTones'
import type { TestSummary } from '../api/models/TestSummary'
import type { TestStatus } from '../api/models/TestStatus'

function VerdictIcon({ status, className = 'w-3 h-3 shrink-0' }: { status: TestStatus; className?: string }) {
  switch (status) {
    case 'passing':
      return <Check className={className} strokeWidth={3} />
    case 'failing':
      return <X className={className} strokeWidth={3} />
    case 'running':
      // A CSS border-spinner (not a lucide icon) so the perpetually-running
      // sidebar chip in --simulation doesn't trip screenshot waits that detect an
      // in-progress upload via a document-wide lucide-loader-circle check; also
      // matches the design mockup's spinner.
      return <span className={`${className} inline-block rounded-full border-2 border-current border-t-transparent animate-spin`} />
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

// WarningCount renders the amber warning marker that rides on a passing chip after
// a divider, before the skipped count (✓ 142 │ ⚠ 4 │ ▸| 3). Amber — a warning DOES
// warrant caution (unlike skipped) — but it stays an inline segment so the chip as
// a whole remains green: warnings are informational and never fail the verdict.
function WarningCount({ n }: { n: number }) {
  if (n <= 0) return null
  return (
    <span className="inline-flex items-center gap-0.5 pl-1 ml-0.5 border-l border-current/30 text-amber-600 dark:text-amber-400">
      <AlertTriangle className="w-2.5 h-2.5" />
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
      return 'stale'
    default:
      return ''
  }
}

// liveCaseCount is how many per-case results an in-flight run has reported so
// far. Non-zero only for streamed (type=stdout) runs, whose summary carries the
// ticking tallies — a junit run reports nothing until it settles.
function liveCaseCount(t: TestSummary): number {
  return (t.passed ?? 0) + (t.failed ?? 0) + (t.warnings ?? 0) + (t.skipped ?? 0)
}

// LiveCounts renders the ticking per-status segments of an in-flight streamed
// run (✓121 ✗2 ⚠4): green passed always, red failed / amber warnings only when
// non-zero. The long form appends the gray skipped count and the N/total
// progress; the short sidebar form keeps just the colored tallies (the full
// detail stays in the chip title).
function LiveCounts({ t, long }: { t: TestSummary; long: boolean }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap">
      <span className="inline-flex items-center gap-0.5 text-green-700 dark:text-green-400">
        <Check className="w-2.5 h-2.5" strokeWidth={3} />
        {t.passed ?? 0}
      </span>
      {(t.failed ?? 0) > 0 ? (
        <span className="inline-flex items-center gap-0.5 pl-1 ml-0.5 border-l border-current/30 text-red-600 dark:text-red-400">
          <X className="w-2.5 h-2.5" strokeWidth={3} />
          {t.failed}
        </span>
      ) : null}
      <WarningCount n={t.warnings ?? 0} />
      {long ? <SkippedCount n={t.skipped ?? 0} /> : null}
      {long && t.progress ? (
        <span className="pl-1 ml-0.5 border-l border-current/30 text-gray-500 dark:text-gray-400">{t.progress}</span>
      ) : null}
    </span>
  )
}

// TestVerdictChip is the compact per-head verdict chip shown in the sidebar row
// and the agent header. Renders nothing for status "none" (no tests / never run).
//
// Two forms (per user): the SHORT form (variant "xs", sidebar) shows just the
// passed count (✓ 661) — no warnings, no skipped, to stay tight next to the date.
// The LONG form (variant "sm", agent header) adds the amber warning count and the
// gray skipped count after it (✓ 661 │ ⚠ 4 │ ▸| 3).
export function TestVerdictChip({ tests, variant = 'xs' }: { tests?: TestSummary | null; variant?: 'xs' | 'sm' }) {
  if (!tests || tests.status === 'none') return null
  const tone = verdictTone(tests.status)
  const stale = tests.status === 'stale'
  const long = variant === 'sm'
  const settledPass = tests.status === 'passing' || tests.status === 'stale'
  const showSkips = long && settledPass
  const showWarnings = long && settledPass
  return (
    <Badge
      tone={tone}
      variant={variant}
      icon={<VerdictIcon status={tests.status} className="w-3 h-3 shrink-0" />}
      title={verdictTitle(tests)}
      // min-w-0 lets the chip shrink within a tight sidebar row so its text can
      // ellipsize instead of overrunning the date / the sidebar edge.
      containerClassName="min-w-0"
      className={stale ? 'min-w-0 text-gray-500 dark:text-gray-400 border border-dashed border-gray-400 dark:border-gray-600' : undefined}
    >
      {/* whitespace-nowrap so a label like "2 failed" never breaks onto two lines
          inside the chip when the sidebar row is tight — the chip wraps as a whole.
          The running label is an arbitrary agent-supplied progress string (e.g.
          "JUNIT report written to /home/…"), so cap + truncate it with an ellipsis
          — otherwise the chip grows unbounded and clips over the date and the whole
          sidebar. min-w-0 (here + on the Badge container) lets it shrink below its
          content so the date stays visible even on a narrow sidebar; max-w caps it
          on a wide one. The full text stays available via the chip's `title`.
          xs (sidebar) gets a tighter cap than sm (agent header, which has room). */}
      <span className="inline-flex items-center min-w-0 whitespace-nowrap">
        {tests.status === 'running' && liveCaseCount(tests) > 0 ? (
          // A streamed run ticking: live ✓/✗/⚠ tallies instead of the bare
          // progress string (which reads as the denominator in the long form).
          <LiveCounts t={tests} long={long} />
        ) : (
          <span className={`truncate min-w-0 ${variant === 'sm' ? 'max-w-[16rem]' : 'max-w-[7rem]'}`}>{verdictLabel(tests)}</span>
        )}
        {showWarnings ? <WarningCount n={tests.warnings ?? 0} /> : null}
        {showSkips ? <SkippedCount n={tests.skipped ?? 0} /> : null}
      </span>
    </Badge>
  )
}

function verdictTitle(t: TestSummary): string {
  switch (t.status) {
    case 'passing':
      return `Tests passing — ${t.passed ?? 0} passed${t.warnings ? `, ${t.warnings} warnings` : ''}${t.skipped ? `, ${t.skipped} skipped` : ''}`
    case 'failing':
      return `Tests failing — ${t.failed ?? 0} failed (merge is soft-gated)`
    case 'running':
      return `Tests running${t.progress ? ` — ${t.progress}` : ''}${liveCaseCount(t) > 0 ? ` (${t.passed ?? 0} passed${t.failed ? `, ${t.failed} failed` : ''}${t.warnings ? `, ${t.warnings} warnings` : ''}${t.skipped ? `, ${t.skipped} skipped` : ''})` : ''}`
    case 'errored':
      return "Tests couldn't run — no verdict (retry, or force-merge)"
    case 'stale':
      return 'Test verdict is stale — it predates the latest commit; re-run'
    default:
      return ''
  }
}
