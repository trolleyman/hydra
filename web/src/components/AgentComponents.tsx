import type { AgentResponse } from '../api'

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
    case 'merging':   return { label: 'merging',   className: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' }
    case 'ended':     return { label: 'ended',     className: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' }
    case 'exited':    return { label: 'exited',    className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' }
    default:          return { label: status ?? '', className: 'bg-gray-50 text-gray-400 dark:bg-gray-800 dark:text-gray-500' }
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
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors cursor-pointer ${
        selected
          ? 'bg-blue-50 border border-blue-200 dark:bg-blue-900/30 dark:border-blue-800'
          : 'hover:bg-gray-100 dark:hover:bg-gray-700 border border-transparent'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${statusDotClass(agent.container_status)}`}
        />
        <span className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">{agent.id}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-0.5 ml-4">
        <span className={`text-xs ${agentTypeColor(agent.agent_type)}`}>
          {agent.agent_type || 'unknown'}
        </span>
        {agent.agent_status && (
          <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${agentStatusBadge(agent.agent_status.status).className}`}>
            {agentStatusBadge(agent.agent_status.status).label}
          </span>
        )}
      </div>
    </button>
  )
}
