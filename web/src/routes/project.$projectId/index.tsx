import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useAgentStore } from '../../stores/agentStore'
import { SpawnForm } from '../../components/SpawnForm'
import type { AgentResponse } from '../../api'

export const Route = createFileRoute('/project/$projectId/')({
  component: ProjectHomePage,
})

function ProjectHomePage() {
  const { projectId } = useParams({ from: '/project/$projectId/' })
  const { addAgent } = useAgentStore()
  const navigate = useNavigate()

  function handleSpawned(agent: AgentResponse) {
    addAgent(agent)
    navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId, agentId: agent.id } })
  }

  return <SpawnForm projectId={projectId} onSpawned={handleSpawned} />
}
