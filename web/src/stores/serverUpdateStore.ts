import { create } from 'zustand'
import { closeWebSocket } from '../lib/ws'
import { ServerUpdatePhase, type ServerUpdateFrame } from '../api'

// The frames and phases come from api/openapi.yaml, generated for both the
// daemon and here, so a phase the server reaches and one this store labels
// cannot drift. ServerUpdateFrame is a discriminated union: narrowing on `kind`
// narrows to the field that kind carries.
export type UpdatePhase = ServerUpdatePhase

// How the run ended, once it has. 'restarting' is the *expected* end of a
// successful update: the server re-execs, so the socket dies mid-stream and no
// "done" frame ever arrives. Treating that as an error is the single easiest
// mistake to make here, so it gets its own outcome.
export type UpdateOutcome = null | 'restarting' | 'failed' | 'done'

// How many log lines to keep. A full `mage build` is a few hundred; the panel
// shows the tail and this bounds what a long-lived tab accumulates.
const MAX_LINES = 500

export const PHASE_LABEL: Record<UpdatePhase, string> = {
  building: 'Building',
  verifying: 'Verifying the new binary',
  swapping: 'Installing',
  restarting: 'Restarting',
}

interface ServerUpdateState {
  running: boolean
  phase: UpdatePhase | null
  lines: string[]
  error: string | null
  outcome: UpdateOutcome
  // Whether this run is a plain restart rather than a rebuild, so the panel can
  // say so instead of showing an empty build log.
  restartOnly: boolean

  begin: (opts: { restartOnly: boolean }) => void
  apply: (ev: ServerUpdateFrame) => void
  socketClosed: () => void
  reset: () => void
}

export const useServerUpdateStore = create<ServerUpdateState>((set, get) => ({
  running: false,
  phase: null,
  lines: [],
  error: null,
  outcome: null,
  restartOnly: false,

  begin: ({ restartOnly }) =>
    set({ running: true, phase: null, lines: [], error: null, outcome: null, restartOnly }),

  apply: (ev) => {
    if (ev.kind === 'phase') {
      set({ phase: ev.phase })
      return
    }
    if (ev.kind === 'log') {
      const lines = [...get().lines, ev.line]
      set({ lines: lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines })
      return
    }
    if (ev.kind === 'done') {
      set({
        running: false,
        error: ev.error ?? null,
        outcome: ev.error ? 'failed' : 'done',
      })
    }
  },

  // The socket dropped without a terminal frame. If we had got as far as
  // "restarting" that is exactly what success looks like; anything earlier means
  // we genuinely lost the server mid-build.
  socketClosed: () => {
    const { running, phase } = get()
    if (!running) return
    if (phase === ServerUpdatePhase.ServerUpdatePhaseRestarting || phase === ServerUpdatePhase.ServerUpdatePhaseSwapping) {
      set({ running: false, outcome: 'restarting' })
    } else {
      set({
        running: false,
        outcome: 'failed',
        error: 'Lost the connection to the server before the build finished.',
      })
    }
  },

  reset: () =>
    set({ running: false, phase: null, lines: [], error: null, outcome: null }),
}))

// connectUpdateStream subscribes to the server's update log and feeds the store.
// Returns a close function. The socket ending is meaningful (see socketClosed),
// so the caller does not need to distinguish a clean close from a drop.
export function connectUpdateStream(): () => void {
  let closedByUs = false
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws/server/update`)

  ws.onmessage = (e) => {
    try {
      useServerUpdateStore.getState().apply(JSON.parse(e.data as string) as ServerUpdateFrame)
    } catch {
      // A frame we can't parse is not worth tearing the stream down for.
    }
  }
  ws.onclose = () => {
    if (!closedByUs) useServerUpdateStore.getState().socketClosed()
  }
  ws.onerror = () => {
    // onclose always follows, which is where the outcome is decided.
  }

  return () => {
    closedByUs = true
    closeWebSocket(ws)
  }
}
