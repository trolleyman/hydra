import { createContext, useContext, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ArtifactLogLine } from '../api'

// ── Live-log store ────────────────────────────────────────────────────────────
// A chatty artifact generation emits many `log` frames a second. Keeping those
// lines in the panel's `sets` state re-rendered the WHOLE artifacts panel (filter
// bar, every card, tooltips) on each frame. Instead they live in this tiny
// per-panel ref store, keyed by `${setName}\0${side}`, and only the subscribed
// LogView re-renders when its side grows. Semantics mirror the old sets[].left_log
// exactly - a snapshot/set REPLACES a side's lines (authoritative buffer), a log
// frame APPENDS - so the displayed log is identical, just no longer coupled to the
// panel's render. Lives in its own module so ArtifactLogView stays a
// components-only file (react-refresh).
const EMPTY_LOG: ArtifactLogLine[] = []

export interface LiveLogStore {
  get: (key: string) => ArtifactLogLine[]
  subscribe: (key: string, cb: () => void) => () => void
  set: (key: string, lines: ArtifactLogLine[]) => void
  append: (key: string, lines: ArtifactLogLine[]) => void
}

export function useLiveLogStore(): LiveLogStore {
  const data = useRef(new Map<string, ArtifactLogLine[]>())
  const subs = useRef(new Map<string, Set<() => void>>())
  return useMemo<LiveLogStore>(() => {
    const notify = (key: string) => subs.current.get(key)?.forEach((cb) => cb())
    return {
      get: (key) => data.current.get(key) ?? EMPTY_LOG,
      subscribe: (key, cb) => {
        let s = subs.current.get(key)
        if (!s) { s = new Set(); subs.current.set(key, s) }
        s.add(cb)
        return () => { s.delete(cb) }
      },
      set: (key, lines) => { data.current.set(key, lines); notify(key) },
      append: (key, lines) => {
        if (lines.length === 0) return
        data.current.set(key, (data.current.get(key) ?? EMPTY_LOG).concat(lines))
        notify(key)
      },
    }
  }, [])
}

const LiveLogContext = createContext<LiveLogStore | null>(null)
export const LiveLogProvider = LiveLogContext.Provider

// Subscribe to one side's live log. Re-renders only THIS caller when its side
// grows, leaving the rest of the panel untouched.
export function useLiveLogLines(key: string): ArtifactLogLine[] {
  const store = useContext(LiveLogContext)
  return useSyncExternalStore(
    (cb) => (store ? store.subscribe(key, cb) : () => {}),
    () => (store ? store.get(key) : EMPTY_LOG),
  )
}
