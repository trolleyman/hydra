import { useState, useEffect } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Sidebar } from '../../components/Sidebar'
import { CreateAgentDialog } from '../../components/CreateAgentDialog'
import { AgentCard } from '../../components/AgentCard'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useProjectStore } from '../../stores/projectStore'
import { useAgentStore } from '../../stores/agentStore'
import { api } from '../../stores/apiClient'
import type { Project } from '../../api'
import type { CreateAgentRequest } from '../../api'

export const Route = createFileRoute('/$projectId/')({
  component: ProjectOverviewPage,
})

function ProjectOverviewPage() {
  const { projectId } = Route.useParams()
  const [project, setProject] = useState<Project | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const { setLastProjectId } = useProjectStore()
  const { agents, fetchAgents, createAgent, deleteAgent, mergeAgent } = useAgentStore()

  const projectAgents = agents[projectId] ?? []

  useEffect(() => {
    setLastProjectId(projectId)
    api.default.getProject(projectId).then(setProject).catch(console.error)
    fetchAgents(projectId)

    // Poll while any agent is running
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

  const runningCount = projectAgents.filter(
    (a) => a.status === 'running' || a.status === 'starting',
  ).length
  const doneCount = projectAgents.filter((a) => a.status === 'done').length

  return (
    <div className="flex flex-1 overflow-hidden">
      <Sidebar projectId={projectId} agents={projectAgents} />
      <main className="flex-1 overflow-y-auto p-6">
        {project && (
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900">{project.name}</h1>
            <p className="text-sm text-gray-500 font-mono mt-0.5">{project.path}</p>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          {[
            { label: 'Total Agents', value: projectAgents.length },
            { label: 'Running', value: runningCount },
            { label: 'Done', value: doneCount },
          ].map(({ label, value }) => (
            <div key={label} className="bg-white rounded-lg border border-gray-200 p-4">
              <p className="text-sm text-gray-500">{label}</p>
              <p className="text-2xl font-bold text-gray-900">{value}</p>
            </div>
          ))}
        </div>

        {/* New agent prompt */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
          <p className="text-sm font-medium text-gray-700 mb-3">Start a new agent</p>
          <button
            onClick={() => setCreateOpen(true)}
            className="w-full text-left px-4 py-3 rounded-md border border-dashed border-gray-300 text-gray-400 hover:border-blue-400 hover:text-blue-500 transition-colors text-sm"
          >
            Describe what you want the agent to do…
          </button>
        </div>

        {/* Recent agents */}
        {projectAgents.length > 0 && (
          <div>
            <h2 className="text-sm font-medium text-gray-700 mb-3">Recent Agents</h2>
            <div className="space-y-2">
              {projectAgents.slice(0, 5).map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  onDelete={(id) => setDeleteId(id)}
                  onMerge={(id) => mergeAgent(projectId, id)}
                />
              ))}
            </div>
          </div>
        )}
      </main>

      <CreateAgentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreateAgent}
      />

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
