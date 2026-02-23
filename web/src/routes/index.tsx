import { createFileRoute } from '@tanstack/react-router'
import { api } from '../stores/apiClient'
import type { AgentResponse } from '../api'

export const Route = createFileRoute('/')({
  loader: () => api.default.listAgents(),
  pendingComponent: () => (
    <div className="flex-1 flex items-center justify-center text-gray-400">
      Loading agents...
    </div>
  ),
  errorComponent: ({ error }) => (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center text-red-600">
        <p className="font-medium">Failed to load agents</p>
        <p className="text-sm mt-1 text-gray-500">{String(error)}</p>
      </div>
    </div>
  ),
  component: HomePage,
})

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'running': return 'bg-green-100 text-green-800'
    case 'exited': return 'bg-red-100 text-red-800'
    case 'created': return 'bg-blue-100 text-blue-800'
    default: return 'bg-gray-100 text-gray-600'
  }
}

function AgentCard({ agent }: { agent: AgentResponse }) {
  const agentTypeClass =
    agent.agent_type === 'claude'
      ? 'bg-purple-100 text-purple-800'
      : 'bg-teal-100 text-teal-800'

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-semibold text-gray-900 truncate">{agent.id}</h2>
        <div className="flex gap-1.5 shrink-0">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${agentTypeClass}`}>
            {agent.agent_type || 'unknown'}
          </span>
          {agent.container_status && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadgeClass(agent.container_status)}`}>
              {agent.container_status}
            </span>
          )}
        </div>
      </div>

      <div className="text-xs text-gray-500 space-y-1">
        {agent.branch_name && (
          <div className="flex gap-1">
            <span className="text-gray-400 shrink-0">branch</span>
            <span className="font-mono text-gray-600 truncate">{agent.branch_name}</span>
          </div>
        )}
        {agent.base_branch && (
          <div className="flex gap-1">
            <span className="text-gray-400 shrink-0">base</span>
            <span className="font-mono text-gray-600 truncate">{agent.base_branch}</span>
          </div>
        )}
      </div>

      {agent.prompt && (
        <p className="text-sm text-gray-700 border-t border-gray-100 pt-2 line-clamp-3">
          {agent.prompt}
        </p>
      )}
    </div>
  )
}

function HomePage() {
  const agents = Route.useLoaderData()

  if (agents.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-gray-500">
          <p className="text-lg font-medium">No agents running</p>
          <p className="text-sm mt-1">Spawn an agent to get started</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 p-6 overflow-auto">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-xl font-semibold text-gray-900 mb-4">
          Agents <span className="text-gray-400 font-normal text-base">({agents.length})</span>
        </h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      </div>
    </div>
  )
}
