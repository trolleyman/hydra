import { useCallback, useEffect, useRef } from 'react'

// Coalesces a burst of streamed log lines into ONE state update per ~frame.
// A noisy test/artifact runner can emit hundreds of `log` WS frames in a single
// tick; applying each with its own setState copies the whole (growing) log
// array per line - O(n^2) in the line count, a real jank spike during a run.
// Instead we queue lines keyed by target (runner name, or script+side) and flush
// them together, so K lines that arrive in one window cost a single array copy.
//
// applyBatch receives the queued lines grouped by key and does the (single)
// merge into React state. flushNow() applies any queued lines synchronously -
// callers invoke it right before a message that REPLACES the list (snapshot /
// full runner update / reset) so queued lines land in order and are never
// misapplied to, or lost against, the replacement.
export function useLogCoalescer<L>(applyBatch: (batches: Map<string, L[]>) => void) {
  const pending = useRef<Map<string, L[]>>(new Map())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Keep the latest applyBatch without resubscribing timers on every render.
  // The flush only reads it from a timer/effect (never during render), so an
  // effect-time write is timely.
  const applyRef = useRef(applyBatch)
  useEffect(() => { applyRef.current = applyBatch })

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (pending.current.size === 0) return
    const batch = pending.current
    pending.current = new Map()
    applyRef.current(batch)
  }, [])

  const enqueue = useCallback((key: string, line: L) => {
    const arr = pending.current.get(key)
    if (arr) arr.push(line)
    else pending.current.set(key, [line])
    if (timer.current === null) {
      // A short timer (not requestAnimationFrame, which pauses in a hidden tab
      // and would let the queue grow unbounded) batches the current burst.
      timer.current = setTimeout(flush, 32)
    }
  }, [flush])

  // Flush anything still queued when the panel unmounts.
  useEffect(() => () => { flush() }, [flush])

  return { enqueue, flushNow: flush }
}
