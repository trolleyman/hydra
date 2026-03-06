import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useAgentStore } from '../../stores/agentStore'
import { SpawnForm } from '../../components/SpawnForm'
import type { AgentResponse } from '../../api'

export const Route = createFileRoute('/_agents/')({
  component: HomePage,
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

function HomePage() {
  const { selectedProjectId } = useProjectStore()
  const { agents, addAgent } = useAgentStore()
  const [showSpawn, setShowSpawn] = useState(false)
  const navigate = useNavigate()

  const filteredAgents = agents.filter((a) => !a.ephemeral)

  function handleSpawned(agent: AgentResponse) {
    addAgent(agent)
    navigate({ to: '/agent/$agentId', params: { agentId: agent.id } })
  }

  if (filteredAgents.length === 0 || showSpawn) {
    return <SpawnForm projectId={selectedProjectId} onSpawned={handleSpawned} />
  }

  return <EmptyDetail onSpawn={() => setShowSpawn(true)} />
}
