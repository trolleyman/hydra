// getWsUrl builds the terminal/chat WebSocket URL for an agent (or one of its
// bash-shell tabs, or its review slot). Lives in lib (not AgentTerminal.tsx, its
// main consumer) so the chat pane can share it without the component file
// exporting a non-component (which breaks react-refresh).
import { loadLastGeometry } from './terminalGeometry'

export interface WsTarget {
  /** A bash shell tab rather than the agent itself. */
  shell?: boolean
  /** Shell tabs only: false opts into an unsandboxed host shell. */
  sandboxed?: boolean
  /** Shell tabs only: per-tab id, so each tab is its own process and a refresh reattaches. */
  shellId?: string
  /**
   * The head's review slot - a separate agent in its own checkout, always chat
   * framing (docs/review-agent.md). Mutually exclusive with `shell`; the backend
   * ignores it when both are set.
   */
  review?: boolean
}

export function getWsUrl(agentId: string, projectId: string | null, target: WsTarget = {}): string {
  const { shell, sandboxed, shellId, review } = target
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const params = new URLSearchParams()
  if (shell) {
    params.set('shell', 'true')
    // Default is sandboxed; only signal when the user opted into a host shell.
    if (sandboxed === false) params.set('sandboxed', 'false')
    // Per-tab id: each shell tab is its own process; a refresh reuses the same id.
    if (shellId) params.set('shell_id', shellId)
  } else if (review) {
    params.set('review', 'true')
  }
  // Seed the initial PTY size from the last known geometry (see above).
  const geom = loadLastGeometry()
  if (geom) {
    params.set('cols', String(geom.cols))
    params.set('rows', String(geom.rows))
  }
  const qs = params.toString() ? `?${params.toString()}` : ''
  const pid = projectId ? encodeURIComponent(projectId) : '_'
  return `${protocol}//${host}/ws/projects/${pid}/agents/${encodeURIComponent(agentId)}/terminal${qs}`
}
