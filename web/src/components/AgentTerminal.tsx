import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '../stores/apiClient'

interface Props {
  agentId: string
  projectId: string | null
  containerStatus: string
  isEphemeral?: boolean
  onRefresh?: () => void
}

function getWsUrl(agentId: string, projectId: string | null): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''
  return `${protocol}//${host}/ws/agent/${encodeURIComponent(agentId)}/terminal${qs}`
}

export function AgentTerminal({ agentId, projectId, containerStatus, isEphemeral, onRefresh }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [reconnectAttempt, setReconnectAttempt] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, "Courier New", monospace',
      theme: {
        background: '#111827',
        foreground: '#d1d5db',
        cursor: '#60a5fa',
        black: '#1f2937',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#f9fafb',
        brightBlack: '#6b7280',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#ffffff',
      },
      scrollback: 5000,
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(el)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon

    const url = getWsUrl(agentId, projectId)
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      const { cols, rows } = term
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }

    ws.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data))
      } else if (typeof e.data === 'string') {
        term.write(e.data)
        // If the backend sent the "Build finished" message, it will close the connection.
        // We want to trigger a status refresh on the parent so it updates containerStatus,
        // which will trigger this useEffect to re-run and connect to the real container.
        if (e.data.includes('Build finished')) {
          setTimeout(() => onRefresh?.(), 500)
        }
      }
    }

    ws.onclose = () => {
      term.writeln('\r\n\x1b[90m[connection closed]\x1b[0m')
    }

    ws.onerror = () => {
      term.writeln('\r\n\x1b[31m[connection error]\x1b[0m')
    }

    // Forward keyboard input to the container
    const inputDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        const bytes = new TextEncoder().encode(data)
        ws.send(bytes)
      }
    })

    // Resize terminal when the container element resizes
    const observer = new ResizeObserver(() => {
      fitAddon.fit()
      if (ws.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    })
    observer.observe(el)

    return () => {
      observer.disconnect()
      inputDisposable.dispose()
      ws.close()
      term.dispose()
      termRef.current = null
      wsRef.current = null
      fitAddonRef.current = null

      if (isEphemeral) {
        // Fire and forget kill request
        api.default.killAgent(agentId, projectId ?? undefined).catch(() => { })
      }
    }
  }, [agentId, projectId, containerStatus, reconnectAttempt, isEphemeral])

  const isRunning = containerStatus.toLowerCase() === 'running';
  const isWaiting = containerStatus.toLowerCase() === 'waiting';
  const isLoading = containerStatus.toLowerCase() === 'pending' || containerStatus.toLowerCase() === 'building' || containerStatus.toLowerCase() === 'starting';

  return (
    <div className="rounded-lg overflow-hidden border border-gray-700 dark:border-gray-600 flex flex-col resize-y" style={{ background: '#111827', height: '450px', minHeight: '150px' }}>
      {/* Title bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700 dark:border-gray-600 bg-gray-800/80 shrink-0">
        <div className="flex gap-1.5">
          <span className="w-3 h-3 rounded-full bg-red-500/70" />
          <span className="w-3 h-3 rounded-full bg-yellow-500/70" />
          <span className="w-3 h-3 rounded-full bg-green-500/70" />
        </div>
        <span className="text-xs text-gray-400 font-mono ml-1">
          terminal - {agentId}
        </span>
        <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium ${isRunning ? 'text-green-400' : isLoading ? "text-blue-400" : isWaiting ?  'text-yellow-400' : 'text-gray-500'}`}>
          {isRunning ? '● ' : '○ '}{containerStatus.toLowerCase()}
        </span>
        <button
          onClick={() => {
            setReconnectAttempt(prev => prev + 1)
            onRefresh?.()
          }}
          className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
          title="Refresh terminal"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
      {/* xterm.js mount point */}
      <div
        ref={containerRef}
        className="p-2 flex-1 min-h-0"
      />
    </div>
  )
}
