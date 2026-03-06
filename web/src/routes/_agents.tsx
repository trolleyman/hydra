import { createFileRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '../stores/apiClient'
import type { AgentResponse } from '../api'
import { useProjectStore } from '../stores/projectStore'
import { useAgentStore } from '../stores/agentStore'
import { SpawnForm } from '../components/SpawnForm'
import { AgentSidebarItem } from '../components/AgentComponents'

export const Route = createFileRoute('/_agents')({
  component: AgentsLayout,
})

const SIDEBAR_MIN = 160
const SIDEBAR_MAX = 600
const SIDEBAR_DEFAULT = 224 // w-56

function AgentsLayout() {
  const { selectedProjectId } = useProjectStore()
  const { agents, setAgents, setLoading, setError, loading, error, addAgent } = useAgentStore()
  const navigate = useNavigate()
  const params = useParams({ strict: false }) as { agentId?: string }
  const selectedId = params.agentId

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
    setLoading(true)
    setError(null)
  }, [selectedProjectId, setAgents, setLoading, setError])

  useEffect(() => {
    let cancelled = false

    async function fetchAgents() {
      try {
        const result = await api.default.listAgents(selectedProjectId ?? undefined)
        if (cancelled) return
        setAgents(result)
        
        // If we are at root and there are agents, we could auto-select the first one.
        // But the requirement is "/ be no agent selected".
        // So we don't auto-navigate here.
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
  }, [selectedProjectId, setAgents, setError, setLoading])

  function handleSpawned(agent: AgentResponse) {
    addAgent(agent)
    navigate({ to: '/agent/$agentId', params: { agentId: agent.id } })
  }

  if (loading && agents.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500">
        Loading agents...
      </div>
    )
  }

  if (error && agents.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-red-600 dark:text-red-400">
          <p className="font-medium">Failed to load agents</p>
          <p className="text-sm mt-1 text-gray-500 dark:text-gray-400">{error}</p>
        </div>
      </div>
    )
  }

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
              onClick={() => { navigate({ to: '/agent/$agentId', params: { agentId: agent.id } }) }}
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
      <Outlet />
    </div>
  )
}
