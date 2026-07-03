// Fallback poll interval used as a safety net behind the events WebSocket: pushes
// drive refetches immediately, but a slow periodic poll still recovers if the
// socket is briefly down or an event is missed. Much lighter than the old 5-10s.
export const EVENT_FALLBACK_MS = 30_000

// startVisibilityPolling is setInterval(fn, intervalMs) that only fires while the
// tab is visible (document.hidden === false).
//
// We gate on visibility, NOT focus: a tab the user is watching side-by-side with
// another focused window should keep updating live. Only genuinely backgrounded
// tabs (hidden behind another tab, or minimised) suspend their timers - those are
// the ones that needlessly hammer the daemon. (This is deliberately weaker than
// usePageActive, which also requires OS focus.)
//
// fn runs once immediately if currently visible. While hidden the timer is fully
// suspended (no calls fire). On becoming visible again fn runs once right away and
// the interval resumes, so a returning user sees fresh data without waiting a full
// period. Returns a stop() that clears the timer and detaches the listener - call
// it from the effect cleanup.
export function startVisibilityPolling(fn: () => void, intervalMs: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null

  const start = () => {
    if (timer != null) return
    fn()
    timer = setInterval(fn, intervalMs)
  }
  const stop = () => {
    if (timer != null) {
      clearInterval(timer)
      timer = null
    }
  }
  const onVisibility = () => {
    if (document.hidden) stop()
    else start()
  }

  if (!document.hidden) start()
  document.addEventListener('visibilitychange', onVisibility)

  return () => {
    stop()
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
