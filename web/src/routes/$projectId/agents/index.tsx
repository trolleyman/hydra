import { useState, useEffect } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Sidebar } from '../../../components/Sidebar'
import { AgentCard } from '../../../components/AgentCard'
import { PromptTextBox } from '../../../components/PromptTextBox'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { useAgentStore } from '../../../stores/agentStore'
import { useProjectStore } from '../../../stores/projectStore'
import type { CreateAgentRequest } from '../../../api'

export const Route = createFileRoute('/$projectId/agents/')({
  component: AgentsListPage,
})

function AgentsListPage() {
  const { projectId } = Route.useParams()
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const { setLastProjectId } = useProjectStore()
  const { agents, fetchAgents, createAgent, deleteAgent, mergeAgent } = useAgentStore()

  const projectAgents = agents[projectId] ?? []

  useEffect(() => {
    setLastProjectId(projectId)
    fetchAgents(projectId)

    const interval = setInterval(() => {
      const running = (agents[projectId] ?? []).some(
        (a) => a.status === 'running' || a.status === 'starting' || a.status === 'committing',
      )
      if (running) fetchAgents(projectId)
    }, 5000)
    return () => clearInterval(interval)
  }, [projectId])

  const handleCreateAgent = async (req: CreateAgentRequest) => {
    await createAgent(projectId, req)
  }

  const handleDelete = async () => {
    if (!deleteId) return
    await deleteAgent(projectId, deleteId)
    setDeleteId(null)
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <Sidebar projectId={projectId} agents={projectAgents} />
      <main className="flex-1 overflow-y-auto p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Agents</h1>
        <PromptTextBox className="mb-6" onSubmit={handleCreateAgent} />

        {projectAgents.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p className="text-lg mb-2">No agents yet</p>
            <p className="text-sm">Create an agent to start coding with AI.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {projectAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onDelete={(id) => setDeleteId(id)}
                onMerge={(id) => mergeAgent(projectId, id)}
              />
            ))}
          </div>
        )}
      </main>

      <ConfirmDialog
        open={!!deleteId}
        title="Delete Agent"
        message="This will stop the agent and discard all its changes. This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  )
}
