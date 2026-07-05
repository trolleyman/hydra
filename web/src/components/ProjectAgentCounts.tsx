import type { ProjectInfo } from '../api'

// The per-status chips shown in a project's agent tally. Each is a colored dot +
// count. The dot colors mirror the agent status dots in agentDisplay.ts
// (needs_input=red, running=green, waiting=yellow, finished=violet) so a
// project's tally reads the same at a glance as its agents do in the sidebar.
// Ordered by urgency: an agent blocked on you first, then live work, then idle.
const STATUS_CHIPS = [
  { key: 'needs_input_count', dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400', label: 'need your input' },
  { key: 'running_count', dot: 'bg-green-500', text: 'text-green-600 dark:text-green-400', label: 'running' },
  { key: 'waiting_count', dot: 'bg-yellow-400', text: 'text-yellow-700 dark:text-yellow-500', label: 'waiting' },
  { key: 'finished_count', dot: 'bg-violet-500', text: 'text-violet-600 dark:text-violet-400', label: 'finished' },
] as const

// ProjectAgentCounts renders a project's agent tally: a colored dot+number per
// non-zero status (needs_input / running / waiting / finished). A leading sky dot
// marks unread changes (agents you haven't opened since they last updated) - the
// same "updates waiting" signal that used to be the row's lone dot, kept as its
// own marker because "unread" is orthogonal to status (a finished agent can still
// be unreviewed). Renders nothing when the project has no per-status chips to show
// and nothing unread.
export function ProjectAgentCounts({ project, className = '' }: { project: ProjectInfo; className?: string }) {
  const total = project.agent_count ?? 0
  const unread = project.unread_count ?? 0
  const chips = STATUS_CHIPS
    .map((c) => ({ ...c, n: project[c.key] ?? 0 }))
    .filter((c) => c.n > 0)

  if (chips.length === 0 && unread <= 0) return null

  // A spoken summary for screen readers (the visual dots/numbers are aria-hidden).
  const parts: string[] = []
  if (total > 0) parts.push(`${total} agent${total === 1 ? '' : 's'}`)
  if (chips.length) parts.push(chips.map((c) => `${c.n} ${c.label}`).join(', '))
  if (unread > 0) parts.push(`${unread} unread`)
  const summary = parts.join(' - ') || 'no active agents'

  return (
    <div className={`flex items-center gap-1.5 ${className}`} aria-label={summary} title={summary}>
      {unread > 0 && <span className="w-2 h-2 rounded-full bg-sky-500 shrink-0" aria-hidden />}
      {chips.map((c) => (
        <span key={c.key} className="inline-flex items-center gap-1 tabular-nums" aria-hidden>
          <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
          <span className={`text-xs font-medium ${c.text}`}>{c.n}</span>
        </span>
      ))}
    </div>
  )
}
