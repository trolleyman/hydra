// closeWebSocket abandons a WebSocket from an effect cleanup without tripping
// the browser's "WebSocket is closed before the connection is established"
// console warning: calling close() on a socket that is still CONNECTING logs
// it, and that is exactly what happens when a component unmounts (or React
// StrictMode double-invokes an effect) before the handshake finishes. A
// still-connecting socket instead closes itself the moment it opens; an
// established one closes immediately. All handlers are detached first so
// nothing fires into the component after it has moved on.
export function closeWebSocket(ws: WebSocket): void {
  ws.onmessage = null
  ws.onerror = null
  ws.onclose = null
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.onopen = () => ws.close()
  } else {
    ws.onopen = null
    try {
      ws.close()
    } catch {
      // already closed
    }
  }
}
