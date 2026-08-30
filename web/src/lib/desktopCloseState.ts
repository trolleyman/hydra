import type { AgentResponse, ProjectInfo } from '../api'
import { AgentStatus } from '../api'

// A live sandbox process can sit idle after a turn finishes. Native close
// guards care about work that would be interrupted, not whether that reusable
// process still exists.
export function agentHasActiveTurn(agent: AgentResponse | undefined): boolean {
  const status = agent?.agent_status?.status
  if (status) return status === AgentStatus.RUNNING || status === AgentStatus.STARTING
  return agent?.session_status === 'running'
}

// Project tallies are computed from agent_status by the backend, so finished
// heads whose reusable session is still alive are excluded. Keep the selected
// head as a floor while project-list refreshes catch up with a new turn.
export function desktopRunningAgentCount(projects: ProjectInfo[], selectedActive: boolean): number {
  const total = projects.reduce((count, project) => count + (project.running_count ?? 0), 0)
  return selectedActive ? Math.max(1, total) : total
}
