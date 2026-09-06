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

// ProjectAttentionDot is the notification dot rendered over the bottom-right of
// a project's icon: red when an agent there is blocked on your input,
// blue when there are unread changes (agents you haven't opened since they last
// updated) - the same red-over-blue escalation as the dot on the top-bar folder
// button. It lives apart from ProjectAgentCounts because it sits on the icon,
// not with the tally chips. Renders nothing when there's nothing to flag.
export function ProjectAttentionDot({
  project,
  className = '',
}: {
  project: ProjectInfo
  className?: string
}) {
  const unread = project.unread_count ?? 0
  const needsInput = project.needs_input_count ?? 0
  if (needsInput <= 0 && unread <= 0) return null
  const label = needsInput > 0
    ? `${needsInput} agent${needsInput === 1 ? ' needs' : 's need'} your input`
    : `${unread} unread update${unread === 1 ? '' : 's'}`
  const color = needsInput > 0 ? 'bg-red-500' : 'bg-sky-500'
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${color} ${className}`}
      aria-label={label}
      title={label}
    />
  )
}

// ProjectAgentCounts renders a project's agent tally: a colored dot+number per
// non-zero status (needs_input / running / waiting / finished). Renders nothing
// when the project has no per-status chips to show. The unread/needs-input
// notification dot is NOT part of the tally - it overlays the project icon via
// ProjectAttentionDot above.
//
// `onAccent` styles the chips for a solid accent background (the Ctrl+` project
// switcher's highlighted row is `bg-blue-500 text-white`): the status dots stay
// their signal colors - they read fine on blue - but the numbers go white so
// they don't sit at low contrast the way `text-green-600` etc. would.
export function ProjectAgentCounts({
  project,
  className = '',
  onAccent = false,
}: {
  project: ProjectInfo
  className?: string
  onAccent?: boolean
}) {
  const total = project.agent_count ?? 0
  const chips = STATUS_CHIPS
    .map((c) => ({ ...c, n: project[c.key] ?? 0 }))
    .filter((c) => c.n > 0)

  if (chips.length === 0) return null

  // A spoken summary for screen readers (the visual dots/numbers are aria-hidden).
  const parts: string[] = []
  if (total > 0) parts.push(`${total} agent${total === 1 ? '' : 's'}`)
  parts.push(chips.map((c) => `${c.n} ${c.label}`).join(', '))
  const summary = parts.join(' - ')

  return (
    <div className={`flex items-center gap-1.5 ${className}`} aria-label={summary} title={summary}>
      {chips.map((c) => (
        <span key={c.key} className="inline-flex items-center gap-1 tabular-nums" aria-hidden>
          <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
          <span className={`text-xs font-medium ${onAccent ? 'text-white' : c.text}`}>{c.n}</span>
        </span>
      ))}
    </div>
  )
}
