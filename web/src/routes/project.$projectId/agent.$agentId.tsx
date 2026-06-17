import { useRef, useEffect } from 'react'
import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { LoaderCircle } from 'lucide-react'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { api } from '../../stores/apiClient'
import { AgentDetail } from '../../components/AgentDetail'
import { NotFound } from '../../components/NotFound'
import type { AgentResponse } from '../../api'

export const Route = createFileRoute('/project/$projectId/agent/$agentId')({
  component: AgentPage,
})

function AgentPage() {
  const { projectId, agentId } = useParams({ from: '/project/$projectId/agent/$agentId' })
  const { agents, loading, removeAgent, updateAgent, setAgents } = useAgentStore()
  const projects = useProjectStore((s) => s.projects)
  const navigate = useNavigate()

  const isMounted = useRef(true)
  const agentIdRef = useRef(agentId)

  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  useEffect(() => {
    agentIdRef.current = agentId
  }, [agentId])

  const agent = agents.find((a) => a.id === agentId)

  function handleKilled(id: string) {
    removeAgent(id)
    if (isMounted.current && id === agentIdRef.current) {
      navigate({ to: '/project/$projectId', params: { projectId } })
    }
  }

  function handleRestarted(newAgent: AgentResponse) {
    updateAgent(newAgent)
    if (isMounted.current && newAgent.id === agentIdRef.current) {
      navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId, agentId: newAgent.id } })
    }
  }

  async function handleRefresh() {
    try {
      const result = await api.default.listAgents(projectId)
      setAgents(result)
    } catch (e) {
      console.error('Failed to refresh agents:', e)
    }
  }

  if (!agent) {
    // The agent store holds a single global list scoped to the *selected*
    // project, refreshed by a poll in __root.tsx. On a cold load/hard refresh it
    // starts empty, and on a project switch it briefly still holds the previous
    // project's agents until the poll re-fetches this one. Only declare the
    // agent genuinely missing once THIS project's agents have loaded — same gate
    // as the remembered-agent redirect in __root.tsx — otherwise we'd flash
    // "Agent Not Found" on every refresh/switch while the fetch is in flight.
    const project = projects.find((p) => p.id === projectId)
    const agentsLoaded =
      project != null && !loading && agents.every((a) => a.project_path === project.path)
    if (!agentsLoaded) {
      return (
        <div className="flex-1 flex items-center justify-center p-6 bg-gray-50 dark:bg-gray-900">
          <LoaderCircle className="w-6 h-6 text-blue-500 animate-spin" />
        </div>
      )
    }
    return (
      <NotFound
        title="Agent Not Found"
        message={`We couldn't find an agent with ID "${agentId}". It may have been killed or expired.`}
        errorCode="AGENT_404"
      />
    )
  }

  return (
    <AgentDetail
      agent={agent}
      projectId={projectId}
      onKilled={handleKilled}
      onRestarted={handleRestarted}
      onRefresh={handleRefresh}
    />
  )
}
