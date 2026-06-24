import type { AgentResponse } from '../api'
import { renderMarkdown } from '../lib/markdown'

export function normalizeContainerState(status: string): string {
  const s = status.toLowerCase()
  if (s === 'running' || s.startsWith('up')) return 'running'
  if (s === 'exited' || s.startsWith('exited')) return 'exited'
  if (s === 'created') return 'created'
  return s
}

export function statusDotClass(status: string): string {
  switch (normalizeContainerState(status)) {
    case 'running': return 'bg-green-500'
    case 'exited': return 'bg-red-400'
    case 'created': return 'bg-blue-400'
    default: return 'bg-gray-300 dark:bg-gray-600'
  }
}

// agentDotClass picks the sidebar status dot color. It mirrors the status badge
// (agentStatusBadge) so the dot and badge never disagree — e.g. a waiting agent
// reads yellow at a distance, not green just because its session is still alive.
// Falls back to the raw session status when no agent status has been reported.
export function agentDotClass(agent: AgentResponse): string {
  switch (agent.agent_status?.status) {
    case 'running':
    case 'merging':  return 'bg-green-500'
    case 'waiting':  return 'bg-yellow-400'
    case 'finished': return 'bg-violet-500'
    case 'starting':
    case 'building': return 'bg-blue-400'
    case 'killing':  return 'bg-red-400'
    case 'pending':
    case 'stopped':  return 'bg-gray-300 dark:bg-gray-600'
  }
  return statusDotClass(agent.session_status)
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
  return agentType === 'claude'
    ? 'text-purple-600 dark:text-purple-400'
    : agentType === 'gemini'
    ? 'text-teal-600 dark:text-teal-400'
    : agentType === 'copilot'
    ? 'text-blue-600 dark:text-blue-400'
    : agentType === 'codex'
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-gray-500 dark:text-gray-400'
}

export function agentStatusBadge(status: string | undefined): { label: string; className: string } {
  switch (status) {
    case 'pending':   return { label: 'pending',   className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' }
    case 'building':  return { label: 'building',  className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' }
    case 'deploying': return { label: 'deploying', className: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' }
    case 'running':   return { label: 'running',   className: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' }
    case 'starting':  return { label: 'starting',  className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' }
    case 'waiting':   return { label: 'waiting',   className: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' }
    case 'finished':  return { label: 'finished',  className: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400' }
    case 'merging':   return { label: 'merging',   className: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' }
    case 'ended':     return { label: 'ended',     className: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' }
    case 'exited':    return { label: 'exited',    className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' }
    default:          return { label: status ?? '', className: 'bg-gray-50 text-gray-400 dark:bg-gray-800 dark:text-gray-500' }
  }
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
  if (status.last_message) return status.last_message
  // No message yet — keep the line meaningful for the active states.
  switch (status.status) {
    case 'building': return 'Building…'
    case 'waiting':  return 'Waiting…'
    case 'merging':  return 'Merging…'
    default:         return ''
  }
}

// archivedEndStateBadge renders the gray "killed"/"merged" chip for an archived
// (finished) agent, shown in place of the live status badge.
export function archivedEndStateBadge(endState: string | null | undefined): { label: string; className: string } {
  switch (endState) {
    case 'merged': return { label: 'merged', className: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' }
    case 'killed': return { label: 'killed', className: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' }
    default:       return { label: 'archived', className: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' }
  }
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
          className={`w-2 h-2 rounded-full shrink-0 ${archived ? 'bg-gray-300 dark:bg-gray-600' : agentDotClass(agent)}`}
        />
        <span className={`font-medium text-sm truncate ${archived ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}>{agent.title || agent.id}</span>
        {agent.has_unread_changes && !archived && (
          // Unread-changes marker, pinned to the right of the title line so it
          // never overlaps the type/status/created-time row below. Set when the
          // agent goes running→waiting/finished, cleared when it's opened.
          <span
            aria-label="unread changes"
            className="ml-auto shrink-0 w-2.5 h-2.5 rounded-full bg-sky-400 ring-2 ring-sky-400/25"
          />
        )}
      </div>
      <div className="flex items-center gap-1.5 mt-0.5 ml-4">
        <span className={`text-xs ${agentTypeColor(agent.agent_type)}`}>
          {agent.agent_type || 'unknown'}
        </span>
        {archived ? (
          <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${archivedEndStateBadge(agent.end_state).className}`}>
            {archivedEndStateBadge(agent.end_state).label}
          </span>
        ) : agent.agent_status && (
          <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${agentStatusBadge(agent.agent_status.status).className}`}>
            {agentStatusBadge(agent.agent_status.status).label}
          </span>
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
        // `leading-4` pins the line box to the same 1rem as the min-height so a
        // monospace `code` chip (shell-command activity) doesn't size the line
        // box from its taller font metrics and nudge the row up vs. plain status.
        <div className="mt-0.5 ml-4 min-h-[1rem] leading-4 text-[11px] text-gray-400 dark:text-gray-500 truncate">
          {renderMarkdown(agentStatusDetail(agent), { dollarCommand: true })}
        </div>
      )}
    </button>
  )
}
