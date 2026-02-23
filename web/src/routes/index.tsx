import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api } from '../stores/apiClient'
import type { AgentResponse } from '../api'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'running': return 'bg-green-100 text-green-700'
    case 'exited': return 'bg-red-100 text-red-700'
    case 'created': return 'bg-blue-100 text-blue-700'
    default: return 'bg-gray-100 text-gray-500'
  }
}

function statusDotClass(status: string): string {
  switch (status) {
    case 'running': return 'bg-green-500'
    case 'exited': return 'bg-red-400'
    case 'created': return 'bg-blue-400'
    default: return 'bg-gray-300'
  }
}

function agentTypeColor(agentType: string): string {
  return agentType === 'claude'
    ? 'text-purple-600'
    : agentType === 'gemini'
    ? 'text-teal-600'
    : 'text-gray-500'
}

function AgentSidebarItem({
  agent,
  selected,
  onClick,
}: {
  agent: AgentResponse
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
        selected
          ? 'bg-blue-50 border border-blue-200'
          : 'hover:bg-gray-100 border border-transparent'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${statusDotClass(agent.container_status)}`}
        />
        <span className="font-medium text-sm text-gray-900 truncate">{agent.id}</span>
      </div>
      <div className={`text-xs mt-0.5 ml-4 ${agentTypeColor(agent.agent_type)}`}>
        {agent.agent_type || 'unknown'}
      </div>
    </button>
  )
}

function InfoRow({ label, value, mono = false }: { label: string; value: string | boolean; mono?: boolean }) {
  const display = typeof value === 'boolean' ? (value ? 'yes' : 'no') : value
  return (
    <div className="flex gap-3 py-2 border-b border-gray-100 last:border-0">
      <span className="text-xs text-gray-400 w-32 shrink-0 pt-0.5">{label}</span>
      <span className={`text-sm text-gray-800 break-all ${mono ? 'font-mono text-xs' : ''}`}>
        {display || <span className="text-gray-300 italic text-xs">—</span>}
      </span>
    </div>
  )
}

function AgentDetail({ agent }: { agent: AgentResponse }) {
  const agentTypeClass =
    agent.agent_type === 'claude'
      ? 'bg-purple-100 text-purple-800'
      : agent.agent_type === 'gemini'
      ? 'bg-teal-100 text-teal-800'
      : 'bg-gray-100 text-gray-600'

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <h1 className="text-2xl font-bold text-gray-900">{agent.id}</h1>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${agentTypeClass}`}>
            {agent.agent_type || 'unknown'}
          </span>
          {agent.container_status && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadgeClass(agent.container_status)}`}>
              {agent.container_status}
            </span>
          )}
        </div>

        {/* Prompt */}
        {agent.prompt && (
          <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <p className="text-xs text-gray-400 mb-1 uppercase tracking-wide font-medium">Prompt</p>
            <p className="text-sm text-gray-800 whitespace-pre-wrap">{agent.prompt}</p>
          </div>
        )}

        {/* Info */}
        <div className="bg-white rounded-lg border border-gray-200 mb-6">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700">Details</h2>
          </div>
          <div className="px-4">
            <InfoRow label="Branch" value={agent.branch_name} mono />
            <InfoRow label="Base branch" value={agent.base_branch} mono />
            <InfoRow label="Worktree" value={agent.worktree_path} mono />
            <InfoRow label="Project path" value={agent.project_path} mono />
            <InfoRow label="Container ID" value={agent.container_id ? agent.container_id.slice(0, 12) : ''} mono />
            <InfoRow label="Has branch" value={agent.has_branch} />
            <InfoRow label="Has worktree" value={agent.has_worktree} />
          </div>
        </div>

        {/* PTY placeholder */}
        <div className="bg-gray-900 rounded-lg border border-gray-700 p-4 min-h-48 flex items-center justify-center">
          <p className="text-gray-500 text-sm font-mono">
            Terminal (PTY) — coming soon
          </p>
        </div>
      </div>
    </div>
  )
}

function EmptyDetail() {
  return (
    <div className="flex-1 flex items-center justify-center text-gray-400">
      <p className="text-sm">Select an agent to view details</p>
    </div>
  )
}

function NoAgents() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center text-gray-500">
        <p className="text-lg font-medium">No agents running</p>
        <p className="text-sm mt-1">Spawn an agent to get started</p>
      </div>
    </div>
  )
}

function HomePage() {
  const [agents, setAgents] = useState<AgentResponse[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function fetchAgents() {
      try {
        const result = await api.default.listAgents()
        if (cancelled) return
        setAgents(result)
        setError(null)
        // Auto-select first agent if nothing selected
        setSelectedId((prev) => {
          if (prev != null && result.some((a) => a.id === prev)) return prev
          return result.length > 0 ? result[0].id : null
        })
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchAgents()
    const interval = setInterval(fetchAgents, 5_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        Loading agents...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-red-600">
          <p className="font-medium">Failed to load agents</p>
          <p className="text-sm mt-1 text-gray-500">{error}</p>
        </div>
      </div>
    )
  }

  if (agents.length === 0) {
    return <NoAgents />
  }

  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col shrink-0">
        <div className="px-3 py-3 border-b border-gray-100">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Agents
          </span>
          <span className="ml-2 text-xs text-gray-400">({agents.length})</span>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {agents.map((agent) => (
            <AgentSidebarItem
              key={agent.id}
              agent={agent}
              selected={agent.id === selectedId}
              onClick={() => setSelectedId(agent.id)}
            />
          ))}
        </div>
      </aside>

      {/* Main content */}
      {selectedAgent ? <AgentDetail agent={selectedAgent} /> : <EmptyDetail />}
    </div>
  )
}
