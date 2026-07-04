import { useEffect, useRef } from 'react'
import type { TestSummary } from '../api/models/TestSummary'
import { closeWebSocket } from './ws'

export interface EventStreamHandlers {
  onAgentsChanged?: () => void
  onProjectsChanged?: () => void
  onServicesChanged?: () => void
  onPushStatusChanged?: () => void
  // agent_tests_changed carries a payload (unlike the refetch nudges above):
  // one head's live test summary ticked mid-run - patch it in place.
  onAgentTestsChanged?: (agentId: string, tests: TestSummary) => void
}

// useEventStream subscribes to the daemon's per-project events WebSocket and
// invokes the matching handler whenever the server signals a change, so the UI
// refetches on demand instead of polling on a timer (PLAN #50). The server sends
// an initial "refetch everything" burst on connect, so the handlers also fire once
// on every (re)connect - giving a returning/reconnecting client fresh data.
//
// - Reconnects with capped exponential backoff if the socket drops.
// - Stays connected while the tab is hidden, UNLIKE the visibility-gated fallback
//   polls. The socket is push-based - it sits idle and only delivers a frame when
//   something actually changes - so holding it open costs ~nothing and does NOT
//   hammer the daemon the way a background poll would. Keeping it open is what
//   lets a backgrounded tab still learn about unread changes and light the unread
//   dot in its title (the whole point of that indicator is to alert you while the
//   tab is NOT in front). On becoming visible we force an immediate reconnect if
//   the socket dropped while hidden, so a returning user never waits on backoff.
// - Handlers are read through a ref, so passing fresh closures each render does
//   NOT reconnect; only a projectId change restarts the stream.
export function useEventStream(projectId: string | null, handlers: EventStreamHandlers): void {
  const handlersRef = useRef(handlers)
  // Refresh the handler mirror after commit; dispatch reads it only from async
  // socket callbacks, so it's always current by the time a frame arrives.
  useEffect(() => { handlersRef.current = handlers })

  useEffect(() => {
    if (!projectId) return

    let ws: WebSocket | null = null
    let backoff = 1000
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let stopped = false // unmounted or projectId changed

    const dispatch = (msg: { type: string; agent_id?: string; tests?: TestSummary }) => {
      const h = handlersRef.current
      if (msg.type === 'agents_changed') h.onAgentsChanged?.()
      else if (msg.type === 'projects_changed') h.onProjectsChanged?.()
      else if (msg.type === 'services_changed') h.onServicesChanged?.()
      else if (msg.type === 'push_status_changed') h.onPushStatusChanged?.()
      else if (msg.type === 'agent_tests_changed' && msg.agent_id && msg.tests) h.onAgentTestsChanged?.(msg.agent_id, msg.tests)
    }

    const clearReconnect = () => {
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    const closeSocket = () => {
      if (ws) {
        const c = ws
        ws = null
        closeWebSocket(c)
      }
    }

    const connect = () => {
      if (stopped || ws) return
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const url = `${proto}://${window.location.host}/ws/projects/${encodeURIComponent(projectId)}/events`
      const sock = new WebSocket(url)
      ws = sock
      sock.onopen = () => {
        backoff = 1000
      }
      sock.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as { type?: string; agent_id?: string; tests?: TestSummary }
          if (msg && typeof msg.type === 'string') dispatch(msg as { type: string; agent_id?: string; tests?: TestSummary })
        } catch {
          // ignore malformed frames
        }
      }
      sock.onclose = () => {
        if (ws === sock) ws = null
        if (stopped) return
        clearReconnect()
        reconnectTimer = setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 30_000)
      }
      sock.onerror = () => {
        try {
          sock.close()
        } catch {
          // ignore; onclose handles reconnect
        }
      }
    }

    const onVisibility = () => {
      // We deliberately keep the socket open while hidden (see the header), so
      // there's nothing to do on hide. On return, if the socket dropped while we
      // were backgrounded (e.g. the browser froze the connection), reconnect at
      // once rather than waiting out the pending backoff timer.
      if (document.hidden || ws) return
      backoff = 1000
      clearReconnect()
      connect()
    }

    connect()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      clearReconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      closeSocket()
    }
  }, [projectId])
}
