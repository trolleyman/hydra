import { TriangleAlert } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { api } from '../stores/apiClient'
import { useServerData } from '../lib/useServerData'
import { useEventStream } from '../lib/useEventStream'
import { EVENT_FALLBACK_MS } from '../lib/visibilityPolling'

// ── Service Health Warning ─────────────────────────────────────────────────────
// Polls the selected project's service status and shows a warning icon (next to
// the project name) when any supervised service has failed. Tooltip lists them.

export function ServiceHealthWarning({ projectId }: { projectId: string | null }) {
  const { data: failed, refetch } = useServerData<string[]>(
    projectId,
    async (id) => {
      const resp = await api.default.getServices(id)
      return resp.services.filter((s) => s.state === 'failed').map((s) => s.name)
    },
    { intervalMs: EVENT_FALLBACK_MS, initial: [] },
  )

  // Refresh the failed-service indicator the instant a service's state changes.
  useEventStream(projectId, { onServicesChanged: refetch })

  if (failed.length === 0) return null
  return (
    // shrink-0 rides the Tooltip wrapper: it is the flex child of the project
    // name row now, so the icon still can't be squeezed away.
    <Tooltip
      className="shrink-0"
      content={`Service${failed.length > 1 ? 's' : ''} failed: ${failed.join(', ')}. Open Settings to restart.`}
    >
      <span className="inline-flex" aria-label="service failure">
        <TriangleAlert className="w-3.5 h-3.5 text-amber-500" />
      </span>
    </Tooltip>
  )
}
