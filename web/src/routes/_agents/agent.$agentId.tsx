import { useRef, useEffect } from 'react'
import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { useProjectStore } from '../../stores/projectStore'
import { useAgentStore } from '../../stores/agentStore'
import { api } from '../../stores/apiClient'
import { AgentDetail } from '../../components/AgentDetail'
import { NotFound } from '../../components/NotFound'
import type { AgentResponse } from '../../api'

export const Route = createFileRoute('/_agents/agent/$agentId')({
  component: AgentPage,
})

function AgentPage() {
  const { selectedProjectId } = useProjectStore()
  const { agents, removeAgent, updateAgent, setAgents } = useAgentStore()
  const navigate = useNavigate()
  const { agentId } = useParams({ from: '/_agents/agent/$agentId' })

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
      navigate({ to: '/' })
    }
  }

  function handleRestarted(newAgent: AgentResponse) {
    updateAgent(newAgent)
    if (isMounted.current && newAgent.id === agentIdRef.current) {
      navigate({ to: '/agent/$agentId', params: { agentId: newAgent.id } })
    }
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
      projectId={selectedProjectId}
      onKilled={handleKilled}
      onRestarted={handleRestarted}
      onRefresh={handleRefresh}
    />
  )
}
