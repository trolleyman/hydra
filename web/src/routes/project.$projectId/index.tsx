import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { useAgentStore } from '../../stores/agentStore'
import { SpawnForm } from '../../components/SpawnForm'
import type { AgentResponse } from '../../api'

export const Route = createFileRoute('/project/$projectId/')({
  component: ProjectHomePage,
})

function EmptyDetail({ onSpawn }: { onSpawn?: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center text-gray-400">
      <div className="text-center">
        <p className="text-sm">Select an agent to view details</p>
        {onSpawn && (
          <button
            onClick={onSpawn}
            className="mt-2 text-xs text-blue-500 hover:text-blue-700 transition-colors cursor-pointer"
          >
            or spawn a new one
          </button>
        )}
      </div>
    </div>
  )
}

function ProjectHomePage() {
  const { projectId } = useParams({ from: '/project/$projectId/' })
  const { agents, addAgent } = useAgentStore()
  const [showSpawn, setShowSpawn] = useState(false)
  const navigate = useNavigate()

  const filteredAgents = agents.filter((a) => !a.ephemeral)

  function handleSpawned(agent: AgentResponse) {
    addAgent(agent)
    navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId, agentId: agent.id } })
  }

  if (filteredAgents.length === 0 || showSpawn) {
    return <SpawnForm projectId={projectId} onSpawned={handleSpawned} />
  }

  return <EmptyDetail onSpawn={() => setShowSpawn(true)} />
}
