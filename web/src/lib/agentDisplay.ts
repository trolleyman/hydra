import type { AgentResponse } from '../api'
import type { Tone } from '../components/Badge'
import { TONE_DOT, TONE_BADGE } from '../components/badgeTones'
import { AGENT_ACCENT } from './agentTypeMeta'
import type { AgentTypeIconName } from '../components/AgentTypeIcon'

// Single source of truth for agent status colors + labels. Every status maps to
// a `badge` tone (used by agentStatusBadge) and an optional `dot` tone (used by
// agentDotClass). The dot tone is only set where the live dot wants its own
// emphasis - needs_input reads a stronger red as a dot than its badge - and is
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
  // A turn that failed mid-response (Claude "API Error: ... response above may be
  // incomplete."). Like needs_input it wants your eyes now, so it reads red.
  errored: { label: 'errored', badge: 'red', dot: 'red' },
  waiting: { label: 'waiting', badge: 'yellow', dot: 'yellow' },
  finished: { label: 'finished', badge: 'violet', dot: 'violet' },
  merging: { label: 'merging', badge: 'green', dot: 'green' },
  // Not a live agent status - the end-state pill on the "merged into <base>"
  // toasts. Green (success), unlike the sidebar's muted archived chip
  // (archivedEndStateBadge), which deliberately stays quiet.
  merged: { label: 'merged', badge: 'green' },
  // Not live statuses either - the pills on the restart / kill action toasts.
  restarting: { label: 'restarting', badge: 'blue' },
  killed: { label: 'killed', badge: 'red' },
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
// (agentStatusBadge) so the dot and badge never disagree - e.g. a waiting agent
// reads yellow at a distance, not green just because its session is still alive.
// Falls back to the raw session status when no agent status has been reported.
export function agentDotClass(agent: AgentResponse): string {
  const entry = agent.agent_status?.status ? AGENT_STATUS[agent.agent_status.status] : undefined
  if (entry?.dot) return TONE_DOT[entry.dot]
  return statusDotClass(agent.session_status)
}

// agentDotAnimate returns the pulse-animation class for the status dot while the
// agent is actively "whirring" - spinning up (starting/building/pending) or doing
// work (running/merging/killing) - so the dot gently breathes to signal it's live.
// Returns '' for settled states (waiting, needs_input, finished, stopped) so they
// stay calm/static.
export function agentDotAnimate(agent: AgentResponse): string {
  const status = agent.agent_status?.status
  switch (status) {
    case 'running':
    case 'merging':
    case 'starting':
    case 'building':
    case 'pending':
    case 'killing':
      return 'animate-status-pulse'
  }
  // A settled agent status (finished/waiting/needs_input/stopped/...) stays
  // calm even while its PTY session lingers alive - only fall back to the raw
  // session state when no agent status has been reported yet, so a freshly
  // spawned live session still pulses while it reports in.
  if (status) return ''
  return agent.session_status === 'running' ? 'animate-status-pulse' : ''
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

// Human-facing name for an agent type, used in prose (e.g. "Stops the running
// Claude process..."). Falls back to the raw type for anything unmapped.
export function agentTypeLabel(agentType: string): string {
  switch (agentType) {
    case 'claude':
      return 'Claude'
    case 'gemini':
      return 'Gemini'
    case 'copilot':
      return 'Copilot'
    case 'codex':
      return 'Codex'
    case 'bash':
      return 'shell'
    default:
      return agentType || 'agent'
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
  // up (pending/starting) as well as once it's running - so the line is
  // populated the moment the agent is created rather than blank until it
  // reports its first action.
  if (status.status === 'running' || status.status === 'starting' || status.status === 'pending') {
    return status.activity || `${RUNNING_PLACEHOLDERS[stableIndex(agent.id, RUNNING_PLACEHOLDERS.length)]}...`
  }
  // The most recent message is shown as-is, except when it reads as a *suggested
  // next message* - something you could send straight back to the agent (e.g.
  // "run it", "spin up the app so I can see it") - in which case it's marked with
  // a `❯ ` caret. That decision is made server-side (last_message_is_suggested_next_message):
  // a longer / multi-sentence message is a closing summary, and a question the
  // agent is asking the user isn't a suggestion either, so both stay plain.
  if (status.last_message) {
    return status.last_message_is_suggested_next_message
      ? `❯ ${status.last_message}`
      : status.last_message
  }
  // No message yet - keep the line meaningful for the active states.
  switch (status.status) {
    case 'building':    return 'Building...'
    case 'needs_input': return 'Waiting for your answer...'
    case 'waiting':     return 'Waiting...'
    case 'merging':     return 'Merging...'
    case 'errored':     return 'API error - the reply may be incomplete.'
    default:            return ''
  }
}

// archivedEndStateBadge renders the gray "killed"/"merged" chip for an archived
// (finished) agent, shown in place of the live status badge.
export function archivedEndStateBadge(endState: string | null | undefined): { label: string; className: string } {
  const label = endState === 'merged' ? 'merged' : endState === 'killed' ? 'killed' : 'archived'
  return { label, className: TONE_BADGE.muted }
}
