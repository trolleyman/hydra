import type { AgentResponse } from '../api'
import { renderMarkdown } from '../lib/markdown'
import { AgentTypeIcon, AGENT_ACCENT, type AgentTypeIconName } from './AgentTypeIcon'
import { Badge, type Tone, TONE_DOT, TONE_BADGE } from './Badge'

// Single source of truth for agent status colors + labels. Every status maps to
// a `badge` tone (used by agentStatusBadge) and an optional `dot` tone (used by
// agentDotClass). The dot tone is only set where the live dot wants its own
// emphasis — needs_input reads a stronger red as a dot than its badge — and is
// left off for states that only appear as a badge (deploying/ended/exited),
// whose dot falls back to the raw session status. `killing`/`stopped` have no
// badge of their own, so they reuse the dim `faint` fill (matching the previous
// default-case behavior) while keeping their distinct dot color.
const AGENT_STATUS: Record<string, { label: string; badge: Tone; dot?: Tone }> = {
  pending: { label: 'pending', badge: 'neutral', dot: 'neutral' },
  building: { label: 'building', badge: 'blue', dot: 'blue' },
  deploying: { label: 'deploying', badge: 'indigo' },
  running: { label: 'running', badge: 'green', dot: 'green' },
  starting: { label: 'starting', badge: 'blue', dot: 'blue' },
  needs_input: { label: 'needs_input', badge: 'red', dot: 'red' },
  waiting: { label: 'waiting', badge: 'yellow', dot: 'yellow' },
  finished: { label: 'finished', badge: 'violet', dot: 'violet' },
  merging: { label: 'merging', badge: 'green', dot: 'green' },
  ended: { label: 'ended', badge: 'muted' },
  exited: { label: 'exited', badge: 'red' },
  killing: { label: 'killing', badge: 'faint', dot: 'redSoft' },
  stopped: { label: 'stopped', badge: 'faint', dot: 'neutral' },
}

// Raw session (PTY) status → dot tone, used as the fallback for statuses that
// have no agent-status dot of their own.
const SESSION_DOT: Record<string, Tone> = {
  running: 'green',
  exited: 'redSoft',
}

// statusDotClass picks a dot colour from the raw sandbox session status
// (running|exited|stopped|pending|starting|building). Used only as the fallback
// in agentDotClass when no richer agent_status has been reported yet.
export function statusDotClass(status: string): string {
  return TONE_DOT[SESSION_DOT[status] ?? 'neutral']
}

// agentDotClass picks the sidebar status dot color. It mirrors the status badge
// (agentStatusBadge) so the dot and badge never disagree — e.g. a waiting agent
// reads yellow at a distance, not green just because its session is still alive.
// Falls back to the raw session status when no agent status has been reported.
export function agentDotClass(agent: AgentResponse): string {
  const entry = agent.agent_status?.status ? AGENT_STATUS[agent.agent_status.status] : undefined
  if (entry?.dot) return TONE_DOT[entry.dot]
  return statusDotClass(agent.session_status)
}

// agentDotAnimate returns the pulse-animation class for the status dot while the
// agent is actively "whirring" — spinning up (starting/building/pending) or doing
// work (running/merging/killing) — so the dot gently breathes to signal it's live.
// Returns '' for settled states (waiting, needs_input, finished, stopped) so they
// stay calm/static.
export function agentDotAnimate(agent: AgentResponse): string {
  switch (agent.agent_status?.status) {
    case 'running':
    case 'merging':
    case 'starting':
    case 'building':
    case 'pending':
    case 'killing':
      return 'animate-status-pulse'
  }
  // No agent status yet — fall back to the raw session state so a live session
  // still pulses while it reports in.
  return normalizeContainerState(agent.session_status) === 'running' ? 'animate-status-pulse' : ''
}

export function formatStartedAgo(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt * 1000) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  if (hours < 48) return 'yesterday'
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function agentTypeColor(agentType: string): string {
  // Brand accent matched to each agent's canonical logo colour (see AGENT_ACCENT).
  return agentType in AGENT_ACCENT
    ? AGENT_ACCENT[agentType as AgentTypeIconName]
    : 'text-gray-500 dark:text-gray-400'
}

// Brand-matched pill (icon + label badge). Hues track each agent's canonical logo
// colour like AGENT_ACCENT does; Copilot and OpenAI/Codex are monochrome brands, so
// they use neutral tints. Single source of truth shared by the detail header pills.
export function agentTypePill(agentType: string): string {
  switch (agentType) {
    case 'claude':
      return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300'
    case 'gemini':
      return 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300'
    case 'copilot':
      return 'bg-slate-100 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200'
    case 'codex':
      return 'bg-zinc-100 text-zinc-700 dark:bg-zinc-700/50 dark:text-zinc-200'
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
  }
}

export function agentStatusBadge(status: string | undefined): { label: string; className: string } {
  const entry = status ? AGENT_STATUS[status] : undefined
  if (entry) return { label: entry.label, className: TONE_BADGE[entry.badge] }
  return { label: status ?? '', className: TONE_BADGE.faint }
}

// Playful placeholders shown while an agent is running but hasn't reported a
// concrete activity yet (e.g. just after starting, or between tool calls). One
// is picked per agent and stays stable so it doesn't flicker between renders.
const RUNNING_PLACEHOLDERS = [
  'Cogitating', 'Thinking', 'Cooking', 'Tinkering', 'Noodling',
  'Pondering', 'Conjuring', 'Brewing', 'Scheming', 'Percolating',
]

// stableIndex hashes a string to a stable index in [0, n), so a given agent
// keeps the same placeholder instead of changing on every poll/render.
function stableIndex(s: string, n: number): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % n
}

// agentStatusDetail returns the richer progress line to show under an active
// agent: its live activity while running, otherwise its most recent message
// (e.g. the question it's waiting on, or its closing summary). When neither is
// reported it falls back to a short status-based placeholder so the line is
// never blank while the agent is doing something. Not used for archived agents.
export function agentStatusDetail(agent: AgentResponse): string {
  const status = agent.agent_status
  if (!status) return ''
  // Show the live activity placeholder immediately while the agent is spinning
  // up (pending/starting) as well as once it's running — so the line is
  // populated the moment the agent is created rather than blank until it
  // reports its first action.
  if (status.status === 'running' || status.status === 'starting' || status.status === 'pending') {
    return status.activity || `${RUNNING_PLACEHOLDERS[stableIndex(agent.id, RUNNING_PLACEHOLDERS.length)]}…`
  }
  // The most recent message is shown as-is, except when it reads as a *suggested
  // next message* — something you could send straight back to the agent (e.g.
  // "run it", "spin up the app so I can see it") — in which case it's marked with
  // a `❯ ` caret. That decision is made server-side (last_message_is_suggested_next_message):
  // a longer / multi-sentence message is a closing summary, and a question the
  // agent is asking the user isn't a suggestion either, so both stay plain.
  if (status.last_message) {
    return status.last_message_is_suggested_next_message
      ? `❯ ${status.last_message}`
      : status.last_message
  }
  // No message yet — keep the line meaningful for the active states.
  switch (status.status) {
    case 'building':    return 'Building…'
    case 'needs_input': return 'Waiting for your answer…'
    case 'waiting':     return 'Waiting…'
    case 'merging':     return 'Merging…'
    default:            return ''
  }
}

// archivedEndStateBadge renders the gray "killed"/"merged" chip for an archived
// (finished) agent, shown in place of the live status badge.
export function archivedEndStateBadge(endState: string | null | undefined): { label: string; className: string } {
  const label = endState === 'merged' ? 'merged' : endState === 'killed' ? 'killed' : 'archived'
  return { label, className: TONE_BADGE.muted }
}

export function AgentSidebarItem({
  agent,
  selected,
  onClick,
}: {
  agent: AgentResponse
  selected: boolean
  onClick: () => void
}) {
  const archived = agent.archived ?? false
  return (
    <button
      onClick={onClick}
      className={`relative w-full text-left px-3 py-2.5 rounded-lg transition-colors cursor-pointer ${
        selected
          ? 'bg-blue-50 border border-blue-200 dark:bg-blue-900/30 dark:border-blue-800'
          : archived
            // Archived rows brighten their text on hover (opacity) rather than
            // taking a full-width background highlight like live rows do.
            ? 'opacity-60 hover:opacity-100 border border-transparent'
            : 'hover:bg-gray-100 dark:hover:bg-gray-700 border border-transparent'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${archived ? 'bg-gray-300 dark:bg-gray-600' : `${agentDotClass(agent)} ${agentDotAnimate(agent)}`}`}
        />
        <span className={`font-medium text-sm truncate ${archived ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}>{agent.title || agent.id}</span>
        {!archived && agent.agent_status?.status === 'needs_input' ? (
          // Needs-input marker: a red sibling of the blue unread dot, pinned to
          // the right of the title line. Driven by the live status rather than
          // the unread flag, so it stays lit while the agent is blocked on you
          // and clears on its own once you answer (not on open). Takes priority
          // over the blue dot since "needs you now" is the stronger signal.
          <span
            aria-label="needs your input"
            className="ml-auto shrink-0 w-2.5 h-2.5 rounded-full bg-red-500 ring-2 ring-red-500/25"
          />
        ) : agent.has_unread_changes && !archived ? (
          // Unread-changes marker, pinned to the right of the title line so it
          // never overlaps the type/status/created-time row below. Set when the
          // agent goes running→waiting/finished, cleared when it's opened.
          <span
            aria-label="unread changes"
            className="ml-auto shrink-0 w-2.5 h-2.5 rounded-full bg-sky-400 ring-2 ring-sky-400/25"
          />
        ) : null}
      </div>
      <div className="flex items-center gap-1.5 mt-0.5 ml-4">
        <span className={`flex items-center gap-1 text-xs ${agentTypeColor(agent.agent_type)}`}>
          <AgentTypeIcon name={agent.agent_type as AgentTypeIconName} className="w-3 h-3 shrink-0" />
          {agent.agent_type || 'unknown'}
        </span>
        {archived ? (
          <Badge variant="xs" className={archivedEndStateBadge(agent.end_state).className}>
            {archivedEndStateBadge(agent.end_state).label}
          </Badge>
        ) : agent.agent_status && (
          <Badge variant="xs" className={agentStatusBadge(agent.agent_status.status).className}>
            {agentStatusBadge(agent.agent_status.status).label}
          </Badge>
        )}
        {agent.created_at ? (
          // Non-intrusive relative timestamp (when the agent was created), pushed
          // to the right edge of the badge row. Hover shows the absolute time.
          <span
            className="ml-auto shrink-0 text-[10px] text-gray-300 dark:text-gray-600 tabular-nums"
            title={`created ${new Date(agent.created_at * 1000).toLocaleString()}`}
          >
            {formatStartedAgo(agent.created_at)}
          </span>
        ) : null}
      </div>
      {!archived && agent.agent_status && (
        // Reserve a fixed-height line for the live activity / last message so the
        // row keeps a constant height as the text appears, disappears, or changes
        // between status transitions — otherwise the whole sidebar jumps around.
        //
        // The height MUST NOT be driven by the rendered content's line box: an
        // inline monospace `code` chip (shell-command activity) and plain
        // proportional status text are baseline-aligned but have different font
        // metrics, so even at an identical `line-height` their inline boxes
        // distribute that height differently around the baseline and the line
        // box's union can exceed it — making a code line taller than a plain one.
        // Pinning line-height (the previous fix) wasn't enough for that reason.
        // Instead lock a fixed `h-4` and center the content (`flex items-center`),
        // clipping any overflow, so the row is exactly 1rem tall whichever font
        // the activity uses. The inner span carries `truncate` (+ `min-w-0` so it
        // can shrink inside the flex row) for the horizontal ellipsis.
        <div className="mt-0.5 ml-4 h-4 flex items-center overflow-hidden text-[11px] text-gray-400 dark:text-gray-500">
          <span className="min-w-0 truncate">
            {renderMarkdown(agentStatusDetail(agent), { dollarCommand: true, singleLine: true })}
          </span>
        </div>
      )}
    </button>
  )
}
