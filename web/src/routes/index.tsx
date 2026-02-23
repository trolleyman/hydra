import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { api } from '../stores/apiClient'
import type { AgentResponse, SpawnAgentRequest } from '../api'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'running': return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    case 'exited': return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
    case 'created': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
    default: return 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
  }
}

function statusDotClass(status: string): string {
  switch (status) {
    case 'running': return 'bg-green-500'
    case 'exited': return 'bg-red-400'
    case 'created': return 'bg-blue-400'
    default: return 'bg-gray-300 dark:bg-gray-600'
  }
}

function agentTypeColor(agentType: string): string {
  return agentType === 'claude'
    ? 'text-purple-600 dark:text-purple-400'
    : agentType === 'gemini'
    ? 'text-teal-600 dark:text-teal-400'
    : 'text-gray-500 dark:text-gray-400'
}

function claudeStatusBadge(status: string | undefined): { label: string; className: string } {
  switch (status) {
    case 'starting': return { label: 'starting', className: 'bg-blue-100 text-blue-700' }
    case 'waiting':  return { label: 'waiting',  className: 'bg-yellow-100 text-yellow-700' }
    case 'ended':    return { label: 'ended',    className: 'bg-gray-100 text-gray-500' }
    default:         return { label: status ?? '', className: 'bg-gray-50 text-gray-400' }
  }
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
          ? 'bg-blue-50 border border-blue-200 dark:bg-blue-900/30 dark:border-blue-800'
          : 'hover:bg-gray-100 dark:hover:bg-gray-700 border border-transparent'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${statusDotClass(agent.container_status)}`}
        />
        <span className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">{agent.id}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-0.5 ml-4">
        <span className={`text-xs ${agentTypeColor(agent.agent_type)}`}>
          {agent.agent_type || 'unknown'}
        </span>
        {agent.claude_status && (
          <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${claudeStatusBadge(agent.claude_status.status).className}`}>
            {claudeStatusBadge(agent.claude_status.status).label}
          </span>
        )}
      </div>
    </button>
  )
}

function InfoRow({ label, value, mono = false }: { label: string; value: string | boolean; mono?: boolean }) {
  const display = typeof value === 'boolean' ? (value ? 'yes' : 'no') : value
  return (
    <div className="flex gap-3 py-2 border-b border-gray-100 dark:border-gray-700 last:border-0">
      <span className="text-xs text-gray-400 dark:text-gray-500 w-32 shrink-0 pt-0.5">{label}</span>
      <span className={`text-sm text-gray-800 dark:text-gray-200 break-all ${mono ? 'font-mono text-xs' : ''}`}>
        {display || <span className="text-gray-300 dark:text-gray-600 italic text-xs">—</span>}
      </span>
    </div>
  )
}

function AgentDetail({ agent }: { agent: AgentResponse }) {
  const agentTypeClass =
    agent.agent_type === 'claude'
      ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
      : agent.agent_type === 'gemini'
      ? 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300'
      : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6 flex-wrap">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{agent.id}</h1>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${agentTypeClass}`}>
            {agent.agent_type || 'unknown'}
          </span>
          {agent.container_status && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadgeClass(agent.container_status)}`}>
              {agent.container_status}
            </span>
          )}
          {agent.claude_status && (() => {
            const badge = claudeStatusBadge(agent.claude_status.status)
            return (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.className}`}>
                claude: {badge.label}
              </span>
            )
          })()}
        </div>

        {/* Prompt */}
        {agent.prompt && (
          <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1 uppercase tracking-wide font-medium">Prompt</p>
            <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{agent.prompt}</p>
          </div>
        )}

        {/* Info */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Details</h2>
          </div>
          <div className="px-4">
            <InfoRow label="Branch" value={agent.branch_name} mono />
            <InfoRow label="Base branch" value={agent.base_branch} mono />
            <InfoRow label="Worktree" value={agent.worktree_path} mono />
            <InfoRow label="Project path" value={agent.project_path} mono />
            <InfoRow label="Container ID" value={agent.container_id ? agent.container_id.slice(0, 12) : ''} mono />
            <InfoRow label="Has branch" value={agent.has_branch} />
            <InfoRow label="Has worktree" value={agent.has_worktree} />
            {agent.claude_status && (
              <>
                <InfoRow label="Claude status" value={agent.claude_status.status} />
                <InfoRow label="Status since" value={agent.claude_status.timestamp} mono />
                {agent.claude_status.last_message && (
                  <InfoRow label="Last message" value={agent.claude_status.last_message} />
                )}
              </>
            )}
          </div>
        </div>

        {/* PTY placeholder */}
        <div className="bg-gray-900 dark:bg-gray-950 rounded-lg border border-gray-700 dark:border-gray-600 p-4 min-h-48 flex items-center justify-center">
          <p className="text-gray-500 text-sm font-mono">
            Terminal (PTY) — coming soon
          </p>
        </div>
      </div>
    </div>
  )
}

function EmptyDetail({ onSpawn }: { onSpawn?: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center text-gray-400">
      <div className="text-center">
        <p className="text-sm">Select an agent to view details</p>
        {onSpawn && (
          <button
            onClick={onSpawn}
            className="mt-2 text-xs text-blue-500 hover:text-blue-700 transition-colors"
          >
            or spawn a new one
          </button>
        )}
      </div>
    </div>
  )
}

// ── Spawn Form ────────────────────────────────────────────────────────────────

type AgentTypeOption = 'claude' | 'gemini'

function slugify(text: string, maxLength = 40): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, maxLength)
    .replace(/-$/, '')
}

function generateId(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 8).join(' ')
  return slugify(words)
}

function SpawnForm({
  onSpawned,
  compact = false,
}: {
  onSpawned?: (agent: AgentResponse) => void
  compact?: boolean
}) {
  const [prompt, setPrompt] = useState('')
  const [agentId, setAgentId] = useState('')
  const [idManuallyEdited, setIdManuallyEdited] = useState(false)
  const [agentType, setAgentType] = useState<AgentTypeOption>('claude')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!compact) textareaRef.current?.focus()
  }, [compact])

  function handlePromptChange(value: string) {
    setPrompt(value)
    if (!idManuallyEdited) {
      setAgentId(generateId(value))
    }
  }

  function handleIdChange(value: string) {
    setAgentId(slugify(value, 40))
    setIdManuallyEdited(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!prompt.trim() || loading) return
    setLoading(true)
    setError(null)
    try {
      const req: SpawnAgentRequest = {
        prompt: prompt.trim(),
        agent_type: agentType,
        id: agentId || generateId(prompt.trim()),
      }
      const agent = await api.default.spawnAgent(req)
      setPrompt('')
      setAgentId('')
      setIdManuallyEdited(false)
      onSpawned?.(agent)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit(e as unknown as React.FormEvent)
    }
  }

  if (compact) {
    return (
      <form onSubmit={handleSubmit} className="px-3 py-3 border-b border-gray-100">
        <div className="relative rounded-xl p-[1.5px] bg-gradient-to-br from-blue-500 via-indigo-500 to-purple-600 animate-gradient shadow-lg shadow-blue-500/20">
          <div className="rounded-[10px] bg-white overflow-hidden">
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => handlePromptChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe a task…"
              rows={2}
              disabled={loading}
              className="w-full px-3 pt-2.5 pb-1 text-xs text-gray-800 placeholder-gray-400 bg-transparent resize-none focus:outline-none leading-relaxed disabled:opacity-50"
            />
            <div className="flex items-center justify-between px-2 pb-2 gap-2">
              <div className="flex items-center gap-1 min-w-0 flex-1">
                {(['claude', 'gemini'] as AgentTypeOption[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setAgentType(t)}
                    className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium transition-colors shrink-0 ${
                      agentType === t
                        ? t === 'claude'
                          ? 'bg-purple-100 text-purple-700'
                          : 'bg-teal-100 text-teal-700'
                        : 'text-gray-400 hover:text-gray-600'
                    }`}
                  >
                    {t}
                  </button>
                ))}
                <input
                  type="text"
                  value={agentId}
                  onChange={(e) => handleIdChange(e.target.value)}
                  placeholder="id…"
                  className="min-w-0 flex-1 text-[10px] text-gray-500 bg-transparent font-mono focus:outline-none placeholder-gray-300 truncate ml-1"
                />
              </div>
              <button
                type="submit"
                disabled={!prompt.trim() || loading}
                className="relative overflow-hidden text-[10px] font-semibold px-2.5 py-1 rounded-lg text-white bg-gradient-to-r from-blue-600 to-purple-600 animate-gradient shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-opacity hover:opacity-90 shrink-0"
              >
                {loading ? '…' : 'Spawn'}
              </button>
            </div>
          </div>
        </div>
        {error && (
          <p className="mt-1.5 text-[10px] text-red-500 leading-snug">{error}</p>
        )}
      </form>
    )
  }

  // Full-page (empty state) variant
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-4xl">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg shadow-blue-500/30 mb-4">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 bg-clip-text text-transparent animate-gradient">
            Spawn an Agent
          </h2>
          <p className="text-sm text-gray-500 mt-1">Describe what you need — an AI agent will get it done.</p>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Gradient border card */}
          <div className="relative rounded-2xl p-[1.5px] bg-gradient-to-br from-blue-500 via-indigo-500 to-purple-600 animate-gradient shadow-2xl shadow-blue-500/20">
            <div className="rounded-[14px] bg-white">
              {/* Prompt textarea */}
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => handlePromptChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="e.g. Add a dark mode toggle to the settings page…"
                rows={6}
                disabled={loading}
                className="w-full px-4 pt-4 pb-2 text-sm text-gray-800 placeholder-gray-400 bg-transparent resize-y focus:outline-none leading-relaxed disabled:opacity-50 min-h-[120px]"
              />

              {/* Footer bar */}
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 gap-4">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {/* Agent type pills */}
                  <div className="flex gap-1.5 shrink-0">
                    {(['claude', 'gemini'] as AgentTypeOption[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setAgentType(t)}
                        className={`text-xs px-3 py-1 rounded-full font-medium transition-all ${
                          agentType === t
                            ? t === 'claude'
                              ? 'bg-purple-100 text-purple-700 shadow-sm'
                              : 'bg-teal-100 text-teal-700 shadow-sm'
                            : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  {/* Divider */}
                  <span className="text-gray-200 text-sm shrink-0">|</span>
                  {/* ID field */}
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className="text-xs text-gray-400 shrink-0">id:</span>
                    <input
                      type="text"
                      value={agentId}
                      onChange={(e) => handleIdChange(e.target.value)}
                      placeholder="auto-generated…"
                      className="flex-1 min-w-0 text-xs text-gray-600 font-mono bg-gray-50 border border-gray-200 rounded-md px-2 py-0.5 focus:outline-none focus:border-blue-300 focus:bg-white transition-colors placeholder-gray-300"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-gray-400">⌘↵ to spawn</span>
                  <button
                    type="submit"
                    disabled={!prompt.trim() || loading}
                    className="relative overflow-hidden flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 animate-gradient shadow-md shadow-blue-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all hover:shadow-lg hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98]"
                  >
                    {loading ? (
                      <>
                        <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                        Spawning…
                      </>
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                        Spawn Agent
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {error && (
            <div className="mt-3 px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl">
              <p className="text-xs text-red-600">{error}</p>
            </div>
          )}
        </form>
      </div>
    </div>
  )
}

// ── Home page ─────────────────────────────────────────────────────────────────

function HomePage() {
  const [agents, setAgents] = useState<AgentResponse[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showSpawn, setShowSpawn] = useState(false)

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

  function handleSpawned(agent: AgentResponse) {
    setAgents((prev) => {
      const exists = prev.some((a) => a.id === agent.id)
      return exists ? prev : [...prev, agent]
    })
    setSelectedId(agent.id)
    setShowSpawn(false)
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
        Loading agents...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-red-600 dark:text-red-400">
          <p className="font-medium">Failed to load agents</p>
          <p className="text-sm mt-1 text-gray-500 dark:text-gray-400">{error}</p>
        </div>
      </div>
    )
  }

  if (agents.length === 0 && !showSpawn) {
    return <SpawnForm onSpawned={handleSpawned} />
  }

  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col shrink-0">
        {/* Spawn form (compact) */}
        <SpawnForm compact onSpawned={handleSpawned} />

        <div className="px-3 py-3 border-b border-gray-100 dark:border-gray-700">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Agents
          </span>
          <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">({agents.length})</span>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {agents.map((agent) => (
            <AgentSidebarItem
              key={agent.id}
              agent={agent}
              selected={agent.id === selectedId}
              onClick={() => { setShowSpawn(false); setSelectedId(agent.id) }}
            />
          ))}
        </div>
      </aside>

      {/* Main content */}
      {showSpawn ? (
        <SpawnForm onSpawned={handleSpawned} />
      ) : selectedAgent ? (
        <AgentDetail agent={selectedAgent} />
      ) : (
        <EmptyDetail onSpawn={() => setShowSpawn(true)} />
      )}
    </div>
  )
}
