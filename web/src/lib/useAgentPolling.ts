import { useEffect } from 'react'
import { api } from '../stores/apiClient'
import { useAgentStore } from '../stores/agentStore'
import { useServerData } from './useServerData'
import { EVENT_FALLBACK_MS } from './visibilityPolling'
import type { AgentResponse } from '../api'

// Agent list for the selected project: refreshed by the events stream, with a
// slow visibility-gated poll as a fallback. The data lands in the agent store
// (onData) rather than local state; the returned `refetch` is wired into the
// caller's single events stream so a push triggers a fetch without restarting
// the hook.
export function useAgentPolling(currentProjectId: string | null): { refetchAgents: () => void } {
  const setAgents = useAgentStore((s) => s.setAgents)

  const { refetch: refetchAgents } = useServerData<AgentResponse[]>(
    currentProjectId,
    (id) => api.default.listAgents(id),
    { intervalMs: EVENT_FALLBACK_MS, initial: [], onData: setAgents },
  )

  // Clear agents when project deselected (useServerData resets only its own local
  // copy; the live list lives in the store, so it's cleared here).
  useEffect(() => {
    if (!currentProjectId) setAgents([])
  }, [currentProjectId, setAgents])

  return { refetchAgents }
}
