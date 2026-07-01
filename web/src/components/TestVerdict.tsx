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
        <span className={`truncate min-w-0 ${variant === 'sm' ? 'max-w-[16rem]' : 'max-w-[7rem]'}`}>{verdictLabel(tests)}</span>
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
