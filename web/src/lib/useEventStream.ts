import { useEffect, useRef } from 'react'

export interface EventStreamHandlers {
  onAgentsChanged?: () => void
  onProjectsChanged?: () => void
  onServicesChanged?: () => void
  onPushStatusChanged?: () => void
}

// useEventStream subscribes to the daemon's per-project events WebSocket and
// invokes the matching handler whenever the server signals a change, so the UI
// refetches on demand instead of polling on a timer (PLAN #50). The server sends
// an initial "refetch everything" burst on connect, so the handlers also fire once
// on every (re)connect — giving a returning/reconnecting client fresh data.
//
// - Reconnects with capped exponential backoff if the socket drops.
// - Closes the socket while the tab is hidden and reconnects on return, matching
//   startVisibilityPolling so a backgrounded tab holds no connection.
// - Handlers are read through a ref, so passing fresh closures each render does
//   NOT reconnect; only a projectId change restarts the stream.
export function useEventStream(projectId: string | null, handlers: EventStreamHandlers): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (!projectId) return

    let ws: WebSocket | null = null
    let backoff = 1000
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let stopped = false // unmounted or projectId changed

    const dispatch = (type: string) => {
      const h = handlersRef.current
      if (type === 'agents_changed') h.onAgentsChanged?.()
      else if (type === 'projects_changed') h.onProjectsChanged?.()
      else if (type === 'services_changed') h.onServicesChanged?.()
      else if (type === 'push_status_changed') h.onPushStatusChanged?.()
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
        try {
          c.close()
        } catch {
          // ignore
        }
      }
    }

    const connect = () => {
      if (stopped || document.hidden || ws) return
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const url = `${proto}://${window.location.host}/ws/projects/${encodeURIComponent(projectId)}/events`
      const sock = new WebSocket(url)
      ws = sock
      sock.onopen = () => {
        backoff = 1000
      }
      sock.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as { type?: string }
          if (msg && typeof msg.type === 'string') dispatch(msg.type)
        } catch {
          // ignore malformed frames
        }
      }
      sock.onclose = () => {
        if (ws === sock) ws = null
        if (stopped || document.hidden) return
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
      if (document.hidden) {
        clearReconnect()
        closeSocket()
      } else if (!ws) {
        backoff = 1000
        connect()
      }
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
