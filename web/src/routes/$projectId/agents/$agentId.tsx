import { useState, useEffect } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { Sidebar } from '../../../components/Sidebar'
import { AgentStatusBadge } from '../../../components/AgentStatusBadge'
import { LogViewer } from '../../../components/LogViewer'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { useAgentStore } from '../../../stores/agentStore'
import { useProjectStore } from '../../../stores/projectStore'
import { api } from '../../../stores/apiClient'
import { Agent } from '../../../api'

export const Route = createFileRoute('/$projectId/agents/$agentId')({
  component: AgentDetailPage,
})

function AgentDetailPage() {
  const { projectId, agentId } = Route.useParams()
  const [agent, setAgent] = useState<Agent | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()
  const { setLastProjectId } = useProjectStore()
  const { agents, deleteAgent, mergeAgent, updateAgent } = useAgentStore()

  const projectAgents = agents[projectId] ?? []

  useEffect(() => {
    setLastProjectId(projectId)
    // Load agent
    const existing = projectAgents.find((a) => a.id === agentId)
    if (existing) setAgent(existing)

    const load = () =>
      api.default.getAgent(projectId, agentId).then((a) => {
        setAgent(a)
        updateAgent(a)
      }).catch(console.error)

    load()
    const interval = setInterval(load, 5000)
    return () => clearInterval(interval)
  }, [projectId, agentId])

  const handleDelete = async () => {
    try {
      await deleteAgent(projectId, agentId)
      router.navigate({ to: '/$projectId/agents', params: { projectId } })
    } catch (e: unknown) {
      setError(String(e))
    }
  }

  const handleMerge = async () => {
    try {
      const updated = await mergeAgent(projectId, agentId)
      setAgent(updated)
      setMergeOpen(false)
    } catch (e: unknown) {
      setError(String(e))
    }
  }

  if (!agent) {
    return (
      <div className="flex flex-1 items-center justify-center text-gray-400">
        Loading…
      </div>
    )
  }

  const canMerge = agent.status === Agent.status.DONE
  const canDelete = agent.status !== Agent.status.DELETED

  return (
    <div className="flex flex-1 overflow-hidden">
      <Sidebar projectId={projectId} agents={projectAgents} />
      <main className="flex-1 overflow-y-auto p-6">
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-2xl font-bold text-gray-900">{agent.name}</h1>
              <AgentStatusBadge status={agent.status} />
            </div>
            <p className="text-sm font-mono text-gray-500">{agent.branch}</p>
          </div>
          <div className="flex items-center gap-2">
            {canMerge && (
              <button
                onClick={() => setMergeOpen(true)}
                className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700"
              >
                Merge
              </button>
            )}
            {canDelete && (
              <button
                onClick={() => setDeleteOpen(true)}
                className="px-4 py-2 rounded-lg border border-red-300 text-red-600 text-sm font-medium hover:bg-red-50"
              >
                Delete
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 text-red-700 text-sm">
            {error}
          </div>
        )}

        {/* Prompt */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Prompt</h2>
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{agent.prompt}</p>
        </div>

        {/* Metadata */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          {[
            { label: 'AI Provider', value: agent.aiProvider },
            { label: 'Branch', value: agent.branch },
            { label: 'Created', value: new Date(agent.createdAt).toLocaleString() },
            { label: 'Updated', value: new Date(agent.updatedAt).toLocaleString() },
            ...(agent.finishedAt
              ? [{ label: 'Finished', value: new Date(agent.finishedAt).toLocaleString() }]
              : []),
            ...(agent.sandboxId
              ? [{ label: 'Sandbox ID', value: agent.sandboxId }]
              : []),
          ].map(({ label, value }) => (
            <div key={label} className="bg-white rounded-lg border border-gray-200 p-3">
              <p className="text-xs text-gray-500 mb-0.5">{label}</p>
              <p className="text-sm font-mono text-gray-900 truncate">{value}</p>
            </div>
          ))}
        </div>

        {/* Log output */}
        <div>
          <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Output</h2>
          <LogViewer agent={agent} />
        </div>
      </main>

      <ConfirmDialog
        open={deleteOpen}
        title="Delete Agent"
        message="This will stop the agent and discard all its changes. This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleteOpen(false)}
      />

      <ConfirmDialog
        open={mergeOpen}
        title="Merge Agent"
        message={`Merge branch "${agent.branch}" into the project's default branch?`}
        confirmLabel="Merge"
        onConfirm={handleMerge}
        onCancel={() => setMergeOpen(false)}
      />
    </div>
  )
}
