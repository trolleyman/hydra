import { useRef, useEffect, useState, useCallback } from 'react'
import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { LoaderCircle } from 'lucide-react'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { api } from '../../stores/apiClient'
import { AgentDetail } from '../../components/AgentDetail'
import { resetProjectView } from '../../lib/projectView'

export const Route = createFileRoute('/project/$projectId/agent/$agentId')({
  component: AgentPage,
})

function AgentPage() {
  const { projectId, agentId } = useParams({ from: '/project/$projectId/agent/$agentId' })
  // Per-field selectors (not a whole-store subscription): the store refreshes
  // near-constantly while an agent works, and a whole-store subscribe would
  // re-render this page - and the whole AgentDetail subtree - on every one.
  const agents = useAgentStore((s) => s.agents)
  const loading = useAgentStore((s) => s.loading)
  const removeAgent = useAgentStore((s) => s.removeAgent)
  const setAgents = useAgentStore((s) => s.setAgents)
  const archived = useAgentStore((s) => s.archived)
  const upsertArchived = useAgentStore((s) => s.upsertArchived)
  const projects = useProjectStore((s) => s.projects)
  const navigate = useNavigate()

  const isMounted = useRef(true)
  const agentIdRef = useRef(agentId)
  // Whether this agent was last seen live AND armed for auto-merge. Used to spot a
  // background merge completing: an armed agent we were watching that then drops
  // out of the live list was merged by the daemon, so we redirect straight to the
  // project view rather than briefly resolving it as an archived record (which
  // leaves the user on a loading spinner mid-fetch). Reset when the agent changes.
  const wasLiveArmedRef = useRef(false)

  useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
    }
  }, [])

  useEffect(() => {
    agentIdRef.current = agentId
    wasLiveArmedRef.current = false
  }, [agentId])

  // Live agents come from the polled list; archived (killed/merged) agents from
  // the lazily-loaded history list. On a cold load / hard refresh to an archived
  // agent's URL, neither is populated, so we fall back to a one-shot getAgent
  // (which returns archived records too) before declaring the agent missing.
  const liveAgent = agents.find((a) => a.id === agentId)
  const agent = liveAgent ?? archived.find((a) => a.id === agentId)

  const project = projects.find((p) => p.id === projectId)
  const agentsLoaded =
    project != null && !loading && agents.every((a) => a.project_path === project.path)

  // Track whether the live agent is armed for auto-merge so a later disappearance
  // can be recognised as a background merge (see the redirect effect below).
  useEffect(() => {
    if (liveAgent) wasLiveArmedRef.current = !!liveAgent.merge_when_green
  }, [liveAgent])

  // When an agent we were watching live was armed for auto-merge and has since
  // left the live list (same-project refresh), the daemon merged it in the
  // background. Redirect to the project view to deselect it, rather than letting
  // the archived-fetch path below leave the user staring at a loading spinner.
  // notifyBackgroundMerges (agentStore) shows the "merged" toast on the same poll.
  useEffect(() => {
    if (liveAgent || !agentsLoaded || !wasLiveArmedRef.current) return
    if (!isMounted.current || agentId !== agentIdRef.current) return
    resetProjectView(projectId)
    navigate({ to: '/project/$projectId', params: { projectId } })
  }, [liveAgent, agentsLoaded, projectId, agentId, navigate])

  const [archivedFetch, setArchivedFetch] = useState<'idle' | 'loading' | 'missing'>('idle')
  // Drive the one-shot archived lookup during render (idle→loading), not in the
  // effect: reset to idle when the viewed agent changes, then kick to loading once
  // the live list is loaded and the agent still isn't present. The effect below
  // only performs the async fetch. Both transitions are guarded so they settle
  // (a resolved archived agent makes `agent` truthy; a miss lands on 'missing').
  const [fetchedAgentId, setFetchedAgentId] = useState(agentId)
  if (fetchedAgentId !== agentId) { setFetchedAgentId(agentId); setArchivedFetch('idle') }
  else if (!agent && agentsLoaded && archivedFetch === 'idle') setArchivedFetch('loading')
  useEffect(() => {
    if (archivedFetch !== 'loading') return
    let cancelled = false
    api.default.getAgent(projectId, agentId)
      .then((a) => {
        if (cancelled) return
        if (a.archived) { upsertArchived(a); setArchivedFetch('idle') }
        else setArchivedFetch('missing')
      })
      .catch(() => { if (!cancelled) setArchivedFetch('missing') })
    return () => { cancelled = true }
  }, [archivedFetch, projectId, agentId, upsertArchived])

  // Once a live + archived + one-shot getAgent lookup have all settled and the
  // agent is genuinely gone (hard-deleted / aborted spawn / pruned - a
  // killed/merged head would resolve as archived), redirect off the dead URL and
  // reset the project's remembered view so a reload / project-switch doesn't land
  // back on it. This is the sole owner of dead-agent correction (see __root).
  useEffect(() => {
    if (agent || !agentsLoaded || archivedFetch !== 'missing') return
    if (!isMounted.current || agentId !== agentIdRef.current) return
    resetProjectView(projectId)
    navigate({ to: '/project/$projectId', params: { projectId } })
  }, [agent, agentsLoaded, archivedFetch, projectId, agentId, navigate])

  // Stable handlers: AgentDetail re-renders on every live tick of its agent, so
  // the callbacks it forwards to memo()'d children (e.g. AgentTerminal's
  // onRefresh) must keep their identity across those renders.
  const handleKilled = useCallback((id: string) => {
    removeAgent(id)
    if (isMounted.current && id === agentIdRef.current) {
      navigate({ to: '/project/$projectId', params: { projectId } })
    }
  }, [removeAgent, navigate, projectId])

  // Deselect the current agent without removing it (e.g. "Mark as unread"), so it
  // stays in the sidebar with its unread dot lit.
  const handleUnselect = useCallback(() => {
    if (isMounted.current) {
      navigate({ to: '/project/$projectId', params: { projectId } })
    }
  }, [navigate, projectId])

  const handleRefresh = useCallback(async () => {
    try {
      const result = await api.default.listAgents(projectId)
      setAgents(result)
    } catch (e) {
      console.error('Failed to refresh agents:', e)
    }
  }, [projectId, setAgents])

  if (!agent) {
    // The agent store holds a single global list scoped to the *selected*
    // project, refreshed by a poll in __root.tsx. On a cold load/hard refresh it
    // starts empty, and on a project switch it briefly still holds the previous
    // project's agents until the poll re-fetches this one. Keep showing the
    // spinner until THIS project's agents have loaded and the archived fallback
    // fetch has settled - otherwise we'd flash a redirect on every refresh/switch
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
    // across agents (rename draft, terminal height/tabs, collapsed diff files, ...).
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
