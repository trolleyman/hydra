import { useNowTick } from '../lib/useNowTick'

// formatElapsed renders a running duration compactly: "12s", or "1m 05s" once it
// passes a minute.
function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

// ElapsedTime shows how long an in-flight run (an artifact generation, a test
// runner) has been going, ticking once a second off the shared clock - so a
// panel full of them re-renders only the labels, and a hidden tab stops ticking.
// startedAt is a Unix time in seconds (from the backend, so it survives
// reloads/reconnects). Renders bare text so callers keep their own wrapping span.
export function ElapsedTime({ startedAt }: { startedAt: number }) {
  const now = useNowTick()
  return <>{formatElapsed(Math.max(0, Math.floor(now / 1000 - startedAt)))}</>
}
