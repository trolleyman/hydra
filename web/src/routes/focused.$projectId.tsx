import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useCallback } from 'react'
import type { AgentResponse } from '../api'
import { SpawnForm } from '../components/SpawnForm'
import { useAgentStore } from '../stores/agentStore'

export const Route = createFileRoute('/focused/$projectId')({
  component: FocusedDraftPage,
})

function FocusedDraftPage() {
  const { projectId } = useParams({ from: '/focused/$projectId' })
  const addAgent = useAgentStore((state) => state.addAgent)
  const navigate = useNavigate()

  const handleSpawned = useCallback((agent: AgentResponse) => {
    addAgent(agent)
    navigate({
      to: '/project/$projectId/agent/$agentId',
      params: { projectId, agentId: agent.id },
    })
  }, [addAgent, navigate, projectId])

  return (
    <main className="h-full w-full overflow-auto bg-gray-50 dark:bg-gray-900">
      <SpawnForm projectId={projectId} onSpawned={handleSpawned} focusedOnly />
    </main>
  )
}
