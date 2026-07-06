import { formatStartedAgo } from '../lib/agentDisplay'
import { useNowTick } from '../lib/useNowTick'

// Self-ticking "created 3m ago" label. Owns its own subscription to the shared
// clock (see useNowTick), so it re-renders in isolation each second while the
// surrounding component (agent header, agent-list row) stays put. Renders bare
// text so callers keep their own wrapping <span> (className/title).
export function RelativeTime({ createdAt }: { createdAt: number }) {
  useNowTick()
  return <>{formatStartedAgo(createdAt)}</>
}

// Self-ticking "up 2 hours" uptime label. spawnedAt is a client epoch (ms);
// format turns an elapsed-ms into the display string.
export function Uptime({ spawnedAt, format }: { spawnedAt: number; format: (ms: number) => string }) {
  const now = useNowTick()
  return <>{format(now - spawnedAt)}</>
}
