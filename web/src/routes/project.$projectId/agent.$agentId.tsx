import { useRef, useEffect, useState } from 'react'
import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { LoaderCircle } from 'lucide-react'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { api } from '../../stores/apiClient'
import { AgentDetail } from '../../components/AgentDetail'
import { saveProjectView } from '../../lib/projectView'

export const Route = createFileRoute('/project/$projectId/agent/$agentId')({
  component: AgentPage,
})

function AgentPage() {
  const { projectId, agentId } = useParams({ from: '/project/$projectId/agent/$agentId' })
  const { agents, loading, removeAgent, setAgents } = useAgentStore()
  const archived = useAgentStore((s) => s.archived)
  const upsertArchived = useAgentStore((s) => s.upsertArchived)
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

  // Live agents come from the polled list; archived (killed/merged) agents from
  // the lazily-loaded history list. On a cold load / hard refresh to an archived
  // agent's URL, neither is populated, so we fall back to a one-shot getAgent
  // (which returns archived records too) before declaring the agent missing.
  const agent = agents.find((a) => a.id === agentId) ?? archived.find((a) => a.id === agentId)

  const project = projects.find((p) => p.id === projectId)
  const agentsLoaded =
    project != null && !loading && agents.every((a) => a.project_path === project.path)

  const [archivedFetch, setArchivedFetch] = useState<'idle' | 'loading' | 'missing'>('idle')
  useEffect(() => { setArchivedFetch('idle') }, [agentId])
  useEffect(() => {
    if (agent || !agentsLoaded || archivedFetch !== 'idle') return
    let cancelled = false
    setArchivedFetch('loading')
    api.default.getAgent(projectId, agentId)
      .then((a) => {
        if (cancelled) return
        if (a.archived) { upsertArchived(a); setArchivedFetch('idle') }
        else setArchivedFetch('missing')
      })
      .catch(() => { if (!cancelled) setArchivedFetch('missing') })
    return () => { cancelled = true }
  }, [agent, agentsLoaded, archivedFetch, projectId, agentId, upsertArchived])

  // Once a live + archived + one-shot getAgent lookup have all settled and the
  // agent is genuinely gone (hard-deleted / aborted spawn / pruned — a
  // killed/merged head would resolve as archived), redirect off the dead URL and
  // reset the project's remembered view so a reload / project-switch doesn't land
  // back on it. This is the sole owner of dead-agent correction (see __root).
  useEffect(() => {
    if (agent || !agentsLoaded || archivedFetch !== 'missing') return
    if (!isMounted.current || agentId !== agentIdRef.current) return
    saveProjectView(projectId, { kind: 'project' })
    navigate({ to: '/project/$projectId', params: { projectId } })
  }, [agent, agentsLoaded, archivedFetch, projectId, agentId, navigate])

  function handleKilled(id: string) {
    removeAgent(id)
    if (isMounted.current && id === agentIdRef.current) {
      navigate({ to: '/project/$projectId', params: { projectId } })
    }
  }

  // Deselect the current agent without removing it (e.g. "Mark as unread"), so it
  // stays in the sidebar with its unread dot lit.
  function handleUnselect() {
    if (isMounted.current) {
      navigate({ to: '/project/$projectId', params: { projectId } })
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
    // project's agents until the poll re-fetches this one. Keep showing the
    // spinner until THIS project's agents have loaded and the archived fallback
    // fetch has settled — otherwise we'd flash a redirect on every refresh/switch
    // while the fetch is in flight. Once it settles as 'missing' the redirect
    // effect above fires; we keep the spinner up for the brief moment until it
    // takes effect rather than flashing an "Agent Not Found" page.
    return (
      <div className="flex-1 flex items-center justify-center p-6 bg-gray-50 dark:bg-gray-900">
        <LoaderCircle className="w-6 h-6 text-blue-500 animate-spin" />
      </div>
    )
  }

  return (
    // Key by project+agent so switching agents remounts the whole detail subtree
    // (AgentDetail, its terminal, diff viewer) with fresh state, rather than
    // reusing one instance and hand-resetting the bits that would otherwise bleed
    // across agents (rename draft, terminal height/tabs, collapsed diff files, …).
    // Agent IDs are globally unique so the key is collision-safe; the
    // `${projectId}-${agentId}` shape matches the storage.ts key builders.
    <AgentDetail
      key={`${projectId}-${agentId}`}
      agent={agent}
      projectId={projectId}
      onKilled={handleKilled}
      onUnselect={handleUnselect}
      onRefresh={handleRefresh}
    />
  )
}
