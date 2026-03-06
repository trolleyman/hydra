import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useProjectStore } from '../../stores/projectStore'
import { useAgentStore } from '../../stores/agentStore'
import { AgentDetail } from '../../components/AgentDetail'
import type { AgentResponse } from '../../api'

export const Route = createFileRoute('/_agents/agent/$agentId')({
  component: AgentPage,
})

function AgentPage() {
  const { selectedProjectId } = useProjectStore()
  const { agents, removeAgent, updateAgent, setAgents } = useAgentStore()
  const navigate = useNavigate()
  const { agentId } = useParams({ from: '/_agents/agent/$agentId' })

  const agent = agents.find((a) => a.id === agentId)

  function handleKilled(id: string) {
    removeAgent(id)
    navigate({ to: '/' })
  }

  function handleRestarted(newAgent: AgentResponse) {
    updateAgent(newAgent)
    navigate({ to: '/agent/$agentId', params: { agentId: newAgent.id } })
  }

  async function handleRefresh() {
    try {
      const result = await api.default.listAgents(selectedProjectId ?? undefined)
      setAgents(result)
    } catch (e) {
      console.error('Failed to refresh agents:', e)
    }
  }

  if (!agent) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        <div className="text-center">
          <p className="text-sm">Agent not found</p>
          <button
            onClick={() => navigate({ to: '/' })}
            className="mt-2 text-xs text-blue-500 hover:text-blue-700 transition-colors cursor-pointer"
          >
            Go back to home
          </button>
        </div>
      </div>
    )
  }

  return (
    <AgentDetail
      agent={agent}
      projectId={selectedProjectId}
      onKilled={handleKilled}
      onRestarted={handleRestarted}
      onRefresh={handleRefresh}
    />
  )
}
