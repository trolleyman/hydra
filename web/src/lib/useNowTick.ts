import { useEffect, useState } from 'react'

// A single shared 1-second clock for every relative-time label in the app
// ("3m ago", "up 2 hours", ...). ONE module-level interval fans out to all
// subscribers, and each subscriber re-renders only ITSELF each tick - so a
// label deep in the sidebar or an agent header updates without re-rendering its
// parent tree. This replaces the old pattern of a parent owning a
// setInterval+setTick, which re-rendered the whole subtree (agent list, diff
// viewer, ...) every second and amplified every other bit of render cost.
//
// The interval only runs while at least one label is mounted AND the tab is
// visible; a hidden tab stops ticking (a background tab has no one watching the
// label) and a single catch-up tick fires the moment it becomes visible again.

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function tick(): void {
  for (const l of listeners) l()
}

function ensureRunning(): void {
  if (timer !== null || listeners.size === 0) return
  if (typeof document !== 'undefined' && document.hidden) return
  timer = setInterval(tick, 1000)
}

function stop(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stop()
    } else {
      // Catch up immediately on return, then resume ticking.
      tick()
      ensureRunning()
    }
  })
}

// Subscribe to the shared clock. Returns the current wall-clock time (ms), which
// advances each second - held in state (seeded lazily) so callers render a
// consistent `now` and update on tick without their parent re-rendering. Pass
// active=false to opt out of the subscription (the returned time then stays at
// mount) - used by callers that only sometimes host a live label.
export function useNowTick(active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const listener = () => setNow(Date.now())
    // Resync on mount in case time passed between the initial render and here.
    listener()
    listeners.add(listener)
    ensureRunning()
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) stop()
    }
  }, [active])
  return now
}
