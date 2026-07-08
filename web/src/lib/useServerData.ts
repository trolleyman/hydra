import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { startVisibilityPolling } from './visibilityPolling'
import { reuseIfEqual } from './deepEqual'

// useServerData collapses the fetch + visibility-poll + refetch-handle idiom that
// was copy-pasted across ~7 call sites (PLAN #57). Each of those owned, by hand:
//   - a `useState` for the data,
//   - a `let cancelled` flag threaded through an async fetch + try/catch swallow,
//   - a `refetchRef.current = ...` handle so a WebSocket event could trigger a
//     fetch without restarting the effect (and a noop reset on cleanup/disable),
//   - a `startVisibilityPolling(fn, ...)` fallback poll + its cleanup.
//
// The hook owns all of that. It deliberately does NOT open the events WebSocket
// itself: the daemon serves one socket per project and several of these hooks
// share a project, so each opening its own would multiply sockets. Instead the
// hook returns a STABLE `refetch` handle (identity never changes across key
// changes) that the call site wires straight into its existing single
// `useEventStream(projectId, ...)` - replacing the `refetchRef` ceremony without
// the socket fan-out.
//
// `key` doubles as the enable switch: a null key means "no source" - data resets
// to `initial`, no fetch/poll runs, and `refetch` is a noop. The effect re-runs
// (initial fetch + fresh poll) whenever `key` or any `deps` entry changes. Data is
// reset to `initial` when the *key* changes (a different resource - so the old
// one's data can't flash under the new one), but NOT when only a `deps` entry
// changes (same resource, just revalidating - clearing there would flicker the UI).

export interface UseServerDataOptions<T> {
  // Visibility-gated background poll interval in ms. Omit or 0 to disable polling
  // (one fetch per key/deps change only - for event-driven or one-shot loads).
  intervalMs?: number
  // Value held before the first successful fetch and whenever the source is
  // disabled (key === null). Defaults to null.
  initial?: T
  // Extra reactive inputs: changing any of these resets + refetches, exactly like
  // a key change. Use for secondary triggers (a status timestamp, a refresh nonce).
  deps?: readonly unknown[]
  // Side-effect run with each successful result, e.g. writing the data into a
  // zustand store or deriving extra state. Skipped if the fetch was cancelled.
  onData?: (data: T) => void
  // When a fetch throws, reset data back to `initial` instead of keeping the last
  // good value. Matches the sites that blank their state on error (e.g. push
  // status); the default is to swallow and keep what's shown.
  resetOnError?: boolean
  // Skip the `loading` state entirely (it stays false). The loading flag toggles
  // true->false around EVERY fetch - including the event-driven background
  // refetches - which re-renders the owning component twice per fetch. Callers
  // that never read `loading` (the store-feeding hooks living in RootLayout)
  // pass false so a background refresh can be a zero-render no-op.
  trackLoading?: boolean
}

export interface ServerData<T, A> {
  data: T
  setData: Dispatch<SetStateAction<T>>
  // Triggers a fresh fetch against the current key. Stable identity - safe to
  // wire straight into an event handler. Noops while the source is disabled.
  // An optional arg is forwarded to the fetcher (e.g. a force-refresh flag).
  refetch: (arg?: A) => void
  // True while a fetch is in flight. Drives e.g. a refresh button's disabled state.
  loading: boolean
}

export function useServerData<T = unknown, A = void>(
  key: string | null,
  fetcher: (key: string, arg?: A) => Promise<T>,
  options: UseServerDataOptions<T> = {},
): ServerData<T, A> {
  const { intervalMs = 0, deps = [], resetOnError = false, trackLoading = true } = options
  const initial = (options.initial ?? null) as T

  const [data, setData] = useState<T>(initial)
  const [loading, setLoading] = useState(false)

  // Latest closures via refs so the effect (re-run only on key/deps) always calls
  // the freshest fetcher/onData without listing them as effect deps.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const onDataRef = useRef(options.onData)
  onDataRef.current = options.onData
  const initialRef = useRef(initial)
  initialRef.current = initial

  // refetch routes through this ref, so its own identity stays stable even as the
  // live fetch fn is swapped out on each key change (or cleared on disable).
  const runRef = useRef<(arg?: A) => void>(() => {})
  const refetch = useCallback((arg?: A) => runRef.current(arg), [])

  // The key the current data belongs to, so we can clear stale data when the key
  // changes (a different resource) without clearing on a mere `deps` revalidation
  // (same key) - the latter would flicker a status-keyed list on every status bump.
  const dataKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (key === null) {
      if (dataKeyRef.current !== null) setData(initialRef.current)
      dataKeyRef.current = null
      runRef.current = () => {}
      return
    }
    // Switched resources - drop the previous key's data so it can't flash under
    // the new one before its fetch resolves.
    if (dataKeyRef.current !== key) {
      setData(initialRef.current)
      dataKeyRef.current = key
    }

    let cancelled = false
    const run = async (arg?: A) => {
      if (trackLoading) setLoading(true)
      try {
        const result = await fetcherRef.current(key, arg)
        if (cancelled) return
        // Keep the previous data object when the fetch returned structurally
        // identical content, so a no-op background refresh doesn't re-render
        // the owner (React bails out on a same-reference state update).
        setData((prev) => reuseIfEqual(prev, result))
        onDataRef.current?.(result)
      } catch {
        if (!cancelled && resetOnError) setData(initialRef.current)
      } finally {
        if (!cancelled && trackLoading) setLoading(false)
      }
    }

    runRef.current = (arg) => void run(arg)
    const stop =
      intervalMs > 0
        ? startVisibilityPolling(() => void run(), intervalMs)
        : (void run(), () => {})

    return () => {
      cancelled = true
      runRef.current = () => {}
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, intervalMs, resetOnError, trackLoading, ...deps])

  return { data, setData, refetch, loading }
}
