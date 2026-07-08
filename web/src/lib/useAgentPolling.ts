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
    {
      intervalMs: EVENT_FALLBACK_MS,
      initial: [],
      // Nobody reads `loading` here and the data lives in the store - skip the
      // loading-state churn so a background refetch doesn't re-render RootLayout.
      trackLoading: false,
      // Tag each list with its project so the store can spot a background merge
      // (an armed agent vanishing on a same-project refresh) without mistaking a
      // project switch for one.
      onData: (agents) => setAgents(agents, currentProjectId),
    },
  )

  // Clear agents when project deselected (useServerData resets only its own local
  // copy; the live list lives in the store, so it's cleared here).
  useEffect(() => {
    if (!currentProjectId) setAgents([], null)
  }, [currentProjectId, setAgents])

  return { refetchAgents }
}
