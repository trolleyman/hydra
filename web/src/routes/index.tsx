import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '../stores/apiClient'
import { useProjectStore } from '../stores/projectStore'
import type { AgentResponse, SpawnAgentRequest } from '../api'
import { AgentTerminal } from '../components/AgentTerminal'
import { DiffViewer } from '../DiffViewer'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function normalizeContainerState(status: string): string {
  const s = status.toLowerCase()
  if (s === 'running' || s.startsWith('up')) return 'running'
  if (s === 'exited' || s.startsWith('exited')) return 'exited'
  if (s === 'created') return 'created'
  return s
}

function statusDotClass(status: string): string {
  switch (normalizeContainerState(status)) {
    case 'running': return 'bg-green-500'
    case 'exited': return 'bg-red-400'
    case 'created': return 'bg-blue-400'
    default: return 'bg-gray-300 dark:bg-gray-600'
  }
}

function formatStartedAgo(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt * 1000) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  if (hours < 48) return 'yesterday'
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function agentTypeColor(agentType: string): string {
  return agentType === 'claude'
    ? 'text-purple-600 dark:text-purple-400'
    : agentType === 'gemini'
    ? 'text-teal-600 dark:text-teal-400'
    : 'text-gray-500 dark:text-gray-400'
}

function agentStatusBadge(status: string | undefined): { label: string; className: string } {
  switch (status) {
    case 'pending':   return { label: 'pending',   className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' }
    case 'building':  return { label: 'building',  className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' }
    case 'deploying': return { label: 'deploying', className: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' }
    case 'running':   return { label: 'running',   className: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' }
    case 'starting':  return { label: 'starting',  className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' }
    case 'waiting':   return { label: 'waiting',   className: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' }
    case 'ended':     return { label: 'ended',     className: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400' }
    case 'exited':    return { label: 'exited',    className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' }
    default:          return { label: status ?? '', className: 'bg-gray-50 text-gray-400 dark:bg-gray-800 dark:text-gray-500' }
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
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors cursor-pointer ${
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
        {agent.agent_status && (
          <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${agentStatusBadge(agent.agent_status.status).className}`}>
            {agentStatusBadge(agent.agent_status.status).label}
          </span>
        )}
      </div>
    </button>
  )
}


function AgentDetail({
  agent,
  projectId,
  onKilled,
}: {
  agent: AgentResponse
  projectId: string | null
  onKilled: (id: string) => void
}) {
  const [killing, setKilling] = useState(false)
  const [merging, setMerging] = useState(false)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (agent.created_at == null) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [agent.created_at])

  const agentTypeClass =
    agent.agent_type === 'claude'
      ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
      : agent.agent_type === 'gemini'
      ? 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300'
      : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'

  async function handleKill() {
    if (!window.confirm(`Are you sure you want to kill agent "${agent.id}"?\n\nThis will permanently stop the container, remove the git worktree, and delete the branch.`)) {
      return
    }
    setKilling(true)
    try {
      await api.default.killAgent(agent.id, projectId ?? undefined)
      onKilled(agent.id)
    } catch (err) {
      alert(`Failed to kill agent: ${err}`)
    } finally {
      setKilling(false)
    }
  }

  async function handleMerge() {
    if (!window.confirm(`Are you sure you want to merge agent "${agent.id}"?\n\nThis will merge the agent's branch into the base branch, then stop the container and clean up.`)) {
      return
    }
    setMerging(true)
    try {
      await api.default.mergeAgent(agent.id, projectId ?? undefined)
      onKilled(agent.id)
    } catch (err) {
      alert(`Failed to merge agent: ${err}`)
    } finally {
      setMerging(false)
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-5xl">
        {/* Header */}
        <div className="mb-6">
          {/* Title row */}
          <div className="flex items-center gap-2 mb-2">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{agent.id}</h1>
            <button
              onClick={handleMerge}
              disabled={merging || killing}
              className="ml-2 w-6 h-6 flex items-center justify-center rounded-md border border-green-200 text-green-600 hover:bg-green-50 dark:border-green-900/30 dark:text-green-400 dark:hover:bg-green-900/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              title="Merge agent"
            >
              {merging ? (
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v10m0 0l3-3m-3 3L5 14m11-7a4 4 0 010 8h-3" />
                </svg>
              )}
            </button>
            <button
              onClick={handleKill}
              disabled={killing || merging}
              className="w-6 h-6 flex items-center justify-center rounded-md border border-red-200 text-red-500 hover:bg-red-50 dark:border-red-900/30 dark:text-red-400 dark:hover:bg-red-900/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              title="Kill agent"
            >
              {killing ? (
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              )}
            </button>
          </div>
          {/* Labels row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${agentTypeClass}`}>
              {agent.agent_type || 'unknown'}
            </span>
            {agent.agent_status && (() => {
              const badge = agentStatusBadge(agent.agent_status.status)
              return (
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${badge.className}`}
                  title={`Since ${agent.agent_status.timestamp}`}
                >
                  {badge.label}
                </span>
              )
            })()}
            {agent.container_id && (
              <span
                className="text-xs px-2 py-0.5 rounded-full font-medium font-mono bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300 cursor-default"
                title={agent.container_id}
              >
                {agent.container_id.slice(0, 12)}
              </span>
            )}
            {agent.created_at != null && (
              <span
                className="text-xs px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400 cursor-default"
                title={`Started at ${new Date(agent.created_at * 1000).toUTCString()}`}
              >
                {formatStartedAgo(agent.created_at)}
              </span>
            )}
          </div>
        </div>

        {/* Prompt */}
        {agent.prompt && (
          <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1 uppercase tracking-wide font-medium">Prompt</p>
            <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{agent.prompt}</p>
          </div>
        )}

        {/* Terminal */}
        <AgentTerminal
          agentId={agent.id}
          projectId={projectId}
          containerStatus={agent.container_status}
        />

        {/* PTY placeholder */}
        <div className="bg-gray-900 dark:bg-gray-950 rounded-lg border border-gray-700 dark:border-gray-600 p-4 min-h-48 flex items-center justify-center mb-4">
          <p className="text-gray-500 text-sm font-mono">
            Terminal (PTY) — coming soon
          </p>
        </div>

        {/* Diff viewer */}
        <DiffViewer agent={agent} projectId={projectId} />
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
            className="mt-2 text-xs text-blue-500 hover:text-blue-700 transition-colors cursor-pointer"
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

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)

function slugify(text: string, maxLength = 40, allowTrailingHyphen = false): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, maxLength)

  return allowTrailingHyphen ? slug : slug.replace(/-$/, '')
}

function generateId(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 8).join(' ')
  return slugify(words)
}

function SpawnForm({
  projectId,
  onSpawned,
  compact = false,
}: {
  projectId: string | null
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
  }

  function handleIdChange(value: string) {
    setAgentId(slugify(value, 40, true))
    setIdManuallyEdited(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!prompt.trim() || loading) return
    setLoading(true)
    setError(null)
    try {
      const finalId = idManuallyEdited ? slugify(agentId) : ''
      const req: SpawnAgentRequest = {
        prompt: prompt.trim(),
        agent_type: agentType,
        id: finalId || generateId(prompt.trim()),
      }
      const agent = await api.default.spawnAgent(req, projectId ?? undefined)
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

  const derivedIdPlaceholder = generateId(prompt) || 'auto-generated…'
  const submitHint = isMac ? '⌘↵ to spawn' : 'Ctrl+Enter to spawn'

  if (compact) {
    return (
      <form onSubmit={handleSubmit} className="px-3 py-3 border-b border-gray-100 dark:border-gray-700">
        <div className="relative rounded-xl p-[1.5px] bg-gray-200 dark:bg-gray-600 focus-within:bg-gradient-to-br focus-within:from-blue-500 focus-within:via-indigo-500 focus-within:to-purple-600 transition-colors duration-200 focus-within:shadow-md focus-within:shadow-blue-500/20">
          <div className="rounded-[10px] bg-white dark:bg-gray-800 overflow-hidden">
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => handlePromptChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe a task…"
              rows={2}
              disabled={loading}
              className="w-full px-3 pt-2.5 pb-1 text-xs text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 bg-transparent resize-y focus:outline-none leading-relaxed disabled:opacity-50 min-h-[48px]"
            />
            <div className="flex items-center justify-between px-2 pb-2 gap-2">
              <div className="flex items-center gap-1 min-w-0 flex-1">
                {(['claude', 'gemini'] as AgentTypeOption[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setAgentType(t)}
                    className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium transition-colors shrink-0 cursor-pointer ${
                      agentType === t
                        ? t === 'claude'
                          ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'
                          : 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300'
                        : 'text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300'
                    }`}
                  >
                    {t}
                  </button>
                ))}
                <input
                  type="text"
                  value={idManuallyEdited ? agentId : ''}
                  onChange={(e) => handleIdChange(e.target.value)}
                  placeholder={derivedIdPlaceholder}
                  className="min-w-0 flex-1 text-[10px] text-gray-500 dark:text-gray-400 bg-transparent font-mono focus:outline-none placeholder-gray-300 dark:placeholder-gray-600 truncate ml-1"
                />
              </div>
              <button
                type="submit"
                disabled={!prompt.trim() || loading}
                className="relative overflow-hidden text-[10px] font-semibold px-2.5 py-1 rounded-lg text-white bg-gradient-to-r from-blue-600 to-purple-600 animate-gradient shadow-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-opacity hover:opacity-90 shrink-0"
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
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Describe what you need — an AI agent will get it done.</p>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Gradient border card */}
          <div className="relative rounded-2xl p-[1.5px] bg-gradient-to-br from-blue-500 via-indigo-500 to-purple-600 animate-gradient shadow-2xl shadow-blue-500/20">
            <div className="rounded-[14px] bg-white dark:bg-gray-800">
              {/* Prompt textarea */}
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => handlePromptChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="e.g. Add a dark mode toggle to the settings page…"
                rows={6}
                disabled={loading}
                className="w-full px-4 pt-4 pb-2 text-sm text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 bg-transparent resize-y focus:outline-none leading-relaxed disabled:opacity-50 min-h-[120px]"
              />

              {/* Footer bar */}
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 dark:border-gray-700 gap-4">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {/* Agent type pills */}
                  <div className="flex gap-1.5 shrink-0">
                    {(['claude', 'gemini'] as AgentTypeOption[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setAgentType(t)}
                        className={`text-xs px-3 py-1 rounded-full font-medium transition-all cursor-pointer ${
                          agentType === t
                            ? t === 'claude'
                              ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 shadow-sm'
                              : 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300 shadow-sm'
                            : 'text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  {/* Divider */}
                  <span className="text-gray-200 dark:text-gray-600 text-sm shrink-0">|</span>
                  {/* ID field */}
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">id:</span>
                    <input
                      type="text"
                      value={idManuallyEdited ? agentId : ''}
                      onChange={(e) => handleIdChange(e.target.value)}
                      placeholder={derivedIdPlaceholder}
                      className="flex-1 min-w-0 text-xs text-gray-600 dark:text-gray-300 font-mono bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md px-2 py-0.5 focus:outline-none focus:border-blue-300 dark:focus:border-blue-500 focus:bg-white dark:focus:bg-gray-600 transition-colors placeholder-gray-300 dark:placeholder-gray-500"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-gray-400 dark:text-gray-500">{submitHint}</span>
                  <button
                    type="submit"
                    disabled={!prompt.trim() || loading}
                    className="relative overflow-hidden flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 animate-gradient shadow-md shadow-blue-500/30 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-all hover:shadow-lg hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98]"
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
            <div className="mt-3 px-4 py-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl">
              <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}
        </form>
      </div>
    </div>
  )
}

// ── Home page ─────────────────────────────────────────────────────────────────

const SIDEBAR_MIN = 160
const SIDEBAR_MAX = 600
const SIDEBAR_DEFAULT = 224 // w-56

function HomePage() {
  const { selectedProjectId } = useProjectStore()
  const [agents, setAgents] = useState<AgentResponse[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showSpawn, setShowSpawn] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('hydra-sidebar-width')
      if (saved) return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, parseInt(saved, 10)))
    } catch { /* ignore */ }
    return SIDEBAR_DEFAULT
  })
  const sidebarWidthRef = useRef(sidebarWidth)

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidthRef.current

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    function onMove(ev: MouseEvent) {
      const newWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + ev.clientX - startX))
      sidebarWidthRef.current = newWidth
      setSidebarWidth(newWidth)
    }
    function onUp() {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try { localStorage.setItem('hydra-sidebar-width', String(sidebarWidthRef.current)) } catch { /* ignore */ }
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // Reset agent selection when project changes.
  useEffect(() => {
    setAgents([])
    setSelectedId(null)
    setLoading(true)
    setError(null)
  }, [selectedProjectId])

  useEffect(() => {
    let cancelled = false

    async function fetchAgents() {
      try {
        const result = await api.default.listAgents(selectedProjectId ?? undefined)
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
  }, [selectedProjectId])

  function handleSpawned(agent: AgentResponse) {
    setAgents((prev) => {
      const exists = prev.some((a) => a.id === agent.id)
      return exists ? prev : [...prev, agent]
    })
    setSelectedId(agent.id)
    setShowSpawn(false)
  }

  function handleKilled(id: string) {
    setAgents((prev) => prev.filter((a) => a.id !== id))
    if (selectedId === id) {
      setSelectedId(null)
    }
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
    return <SpawnForm projectId={selectedProjectId} onSpawned={handleSpawned} />
  }

  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Sidebar */}
      <aside
        style={{ width: sidebarWidth }}
        className="relative bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col shrink-0"
      >
        {/* Spawn form (compact) */}
        <SpawnForm compact projectId={selectedProjectId} onSpawned={handleSpawned} />

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

        {/* Resize handle — wider hit target, thin visual indicator */}
        <div
          onMouseDown={handleSidebarResizeStart}
          className="absolute right-0 top-0 bottom-0 w-3 -mr-1 cursor-col-resize z-10 group flex items-stretch justify-center"
        >
          <div className="w-px group-hover:bg-blue-400/60 group-active:bg-blue-500 transition-colors" />
        </div>
      </aside>

      {/* Main content */}
      {showSpawn ? (
        <SpawnForm projectId={selectedProjectId} onSpawned={handleSpawned} />
      ) : selectedAgent ? (
        <AgentDetail agent={selectedAgent} projectId={selectedProjectId} onKilled={handleKilled} />
      ) : (
        <EmptyDetail onSpawn={() => setShowSpawn(true)} />
      )}
    </div>
  )
}
