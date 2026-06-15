import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { TerminalEvent, type TerminalStatusEvent, type TerminalDataEvent, AgentStatus } from '../api'
import { RefreshCw, Plus, X, ChevronDown, Shield, ShieldOff } from 'lucide-react'
import { Tooltip } from './Tooltip'

interface PaneProps {
  agentId: string
  projectId: string | null
  shell: boolean
  sandboxed: boolean
  active: boolean
  reconnectAttempt: number
  forceRedrawAttempt: number
  onStatusUpdate?: (status: string) => void
  onDiffRefresh?: () => void
}

function getWsUrl(agentId: string, projectId: string | null, shell?: boolean, sandboxed?: boolean): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const params = new URLSearchParams()
  if (shell) {
    params.set('shell', 'true')
    // Default is sandboxed; only signal when the user opted into a host shell.
    if (sandboxed === false) params.set('sandboxed', 'false')
  }
  const qs = params.toString() ? `?${params.toString()}` : ''
  const pid = projectId ? encodeURIComponent(projectId) : '_'
  return `${protocol}//${host}/ws/projects/${pid}/agents/${encodeURIComponent(agentId)}/terminal${qs}`
}

function TerminalPane({ agentId, projectId, shell, sandboxed, active, reconnectAttempt, forceRedrawAttempt, onStatusUpdate, onDiffRefresh }: PaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const isRefreshing = useRef(false)
  const killTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSentSize = useRef({ cols: 0, rows: 0 })
  const [showCopiedAt, setShowCopiedAt] = useState(0)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Re-fit when tab becomes visible (after display:none -> display:block)
  useEffect(() => {
    if (!active) return
    const fitAddon = fitAddonRef.current
    const term = termRef.current
    const ws = wsRef.current
    if (!fitAddon || !term) return
    setTimeout(() => {
      fitAddon.fit()
      const { cols, rows } = term
      if (ws?.readyState === WebSocket.OPEN && cols > 0 && rows > 0) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
        lastSentSize.current = { cols, rows }
      }
    }, 0)
  }, [active])

  // Force a clean repaint of the live session (Refresh button). TUI apps like
  // Claude Code (Ink) repaint in place using a cached row count; shrinking the
  // width by even one column can throw that accounting off and corrupt the
  // layout for the rest of the session. Recover by wiping xterm's buffer and
  // wiggling the PTY size so the app receives two distinct SIGWINCHes and does a
  // full redraw. We go *bigger* first (never re-triggers the shrink bug) and
  // wait well past Ink's resize debounce so the two events aren't coalesced.
  useEffect(() => {
    if (!forceRedrawAttempt) return // skip the initial mount (attempt 0)
    const fitAddon = fitAddonRef.current
    const term = termRef.current
    const ws = wsRef.current
    if (!fitAddon || !term || ws?.readyState !== WebSocket.OPEN) return
    fitAddon.fit()
    const { cols, rows } = term
    if (cols <= 0 || rows <= 0) return
    ws.send(JSON.stringify({ type: 'resize', cols: cols + 2, rows }))
    const timer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      term.clear() // drop garbled scrollback before the app repaints
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      lastSentSize.current = { cols, rows }
    }, 150)
    return () => clearTimeout(timer)
  }, [forceRedrawAttempt])

  useEffect(() => {
    // If a kill was scheduled, cancel it because we are remounting
    if (killTimeoutRef.current) {
      clearTimeout(killTimeoutRef.current)
      killTimeoutRef.current = null
    }

    isRefreshing.current = false
    lastSentSize.current = { cols: 0, rows: 0 }
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

    const url = getWsUrl(agentId, projectId, shell, sandboxed)
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      const { cols, rows } = term
      // Send a slightly larger resize first, then the actual size, so the app
      // receives two distinct SIGWINCHes and fully redraws. The gap must clear
      // the app's resize debounce (Ink coalesces events ~10ms apart), and we go
      // larger first so the intermediate size never triggers the shrink bug.
      ws.send(JSON.stringify({ type: 'resize', cols: cols + 1, rows }))
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }))
          lastSentSize.current = { cols, rows }
        }
      }, 150)
    }

    ws.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data))
      } else if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data) as TerminalEvent
          switch (msg.type) {
            case TerminalEvent.type.STATUS: {
              const statusEvent = msg as TerminalStatusEvent
              if (statusEvent.status) {
                const newStatus = statusEvent.status.toLowerCase()
                onStatusUpdate?.(newStatus)
              }
              return
            }
            case TerminalEvent.type.DIFF_REFRESH: {
              onDiffRefresh?.()
              return
            }
            case TerminalEvent.type.DATA: {
              const dataEvent = msg as TerminalDataEvent
              if (dataEvent.data) {
                term.write(dataEvent.data)
              }
              return
            }
          }
        } catch { /* ignore, might be legacy plain text */ }

        term.write(e.data)
      }
    }

    ws.onclose = () => {
      term.writeln('\r\n\x1b[90m[connection closed]\x1b[0m')
      onStatusUpdate?.('stopped')
    }

    ws.onerror = () => {
      term.writeln('\r\n\x1b[31m[connection error]\x1b[0m')
    }

    const isMac = /Mac/.test(navigator.platform)

    // Custom key handler for clipboard operations
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true

      const isCopyShortcut = (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && e.code === 'KeyC'
      const isPasteShortcut = (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && e.code === 'KeyV'
      const isLiteralVShortcut = (isMac ? e.metaKey : e.ctrlKey) && e.shiftKey && e.code === 'KeyV'

      // Copy with selection -> copy and clear selection (no ^C sent)
      if (isCopyShortcut) {
        const selection = term.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection).then(() => {
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
            setShowCopiedAt(Date.now())
            copyTimeoutRef.current = setTimeout(() => setShowCopiedAt(0), 2000)
          }).catch(() => {})
          term.clearSelection()
          return false
        }
        return true
      }

      // Paste -> let browser handle it (triggers 'paste' event which xterm handles)
      if (isPasteShortcut) {
        return false
      }

      // Send actual ^V (0x16) to terminal
      if (isLiteralVShortcut) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(new Uint8Array([0x16]))
        }
        return false
      }

      return true
    })

    // Forward keyboard input to the container
    const inputDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        const bytes = new TextEncoder().encode(data)
        ws.send(bytes)
      }
    })

    // Resize terminal when the container element resizes.
    // Only send the resize signal when the column/row count actually changes to
    // avoid spurious SIGWINCH signals (e.g. from layout shifts caused by the
    // diff viewer loading content below the terminal).
    const observer = new ResizeObserver(() => {
      fitAddon.fit()
      const { cols, rows } = term
      if (
        ws.readyState === WebSocket.OPEN &&
        cols > 0 && rows > 0 &&
        (cols !== lastSentSize.current.cols || rows !== lastSentSize.current.rows)
      ) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
        lastSentSize.current = { cols, rows }
      }
    })
    observer.observe(el)

    return () => {
      observer.disconnect()
      inputDisposable.dispose()
      ws.close()
      term.dispose()
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      termRef.current = null
      wsRef.current = null
      fitAddonRef.current = null
    }
  }, [agentId, projectId, reconnectAttempt])

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden flex flex-col">
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden"
      />
      {showCopiedAt > 0 && (
        <div key={showCopiedAt} className="absolute top-2 right-2 px-2 py-1 bg-green-800/90 text-gray-200 text-[10px] rounded border border-green-700 shadow-lg pointer-events-none animate-fade-in-out z-10">
          Copied to clipboard!
        </div>
      )}
    </div>
  )
}

interface TabConfig {
  id: string
  label: string
  shell: boolean
  sandboxed: boolean
}

interface Props {
  agentId: string
  projectId: string | null
  isEphemeral?: boolean
  bashEnabled?: boolean
  onRefresh?: () => void
  onStatusUpdate?: (status: string) => void
  onDiffRefresh?: () => void
}

export function AgentTerminal({ agentId, projectId, bashEnabled, onRefresh, onStatusUpdate, onDiffRefresh }: Props) {
  const [tabs, setTabs] = useState<TabConfig[]>([{ id: 'terminal', label: 'Terminal', shell: false, sandboxed: true }])
  const [activeTabId, setActiveTabId] = useState('terminal')
  const [reconnectKeys, setReconnectKeys] = useState<Record<string, number>>({})
  const [forceRedrawKeys, setForceRedrawKeys] = useState<Record<string, number>>({})
  const [status, setStatus] = useState<string>('pending')
  const [shellMenuOpen, setShellMenuOpen] = useState(false)

  function handleStatusUpdate(newStatus: string) {
    setStatus(newStatus)
    onStatusUpdate?.(newStatus)
  }

  function addBashTab(sandboxed: boolean) {
    const bashCount = tabs.filter(t => t.shell).length
    const id = `bash-${Date.now()}`
    const base = sandboxed ? 'Bash' : 'Bash (host)'
    const label = bashCount === 0 ? base : `${base} ${bashCount + 1}`
    setTabs(prev => [...prev, { id, label, shell: true, sandboxed }])
    setActiveTabId(id)
    setShellMenuOpen(false)
  }

  function closeTab(id: string) {
    setTabs(prev => {
      const newTabs = prev.filter(t => t.id !== id)
      if (activeTabId === id && newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id)
      }
      return newTabs
    })
    setReconnectKeys(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setForceRedrawKeys(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  // Refresh: force a clean repaint of the live session without tearing down the
  // WebSocket (see the force-redraw effect in TerminalPane). This fixes the
  // common case where resizing the terminal corrupts a TUI app's layout.
  function reconnectActive() {
    setForceRedrawKeys(prev => ({ ...prev, [activeTabId]: (prev[activeTabId] ?? 0) + 1 }))
    onRefresh?.()
  }

  const isRunning = status === AgentStatus.RUNNING || status === AgentStatus.STARTING
  const isWaiting = status === AgentStatus.WAITING
  const isLoading = status === AgentStatus.PENDING || status === AgentStatus.BUILDING

  return (
    <div className="rounded-lg overflow-hidden border border-gray-700 dark:border-gray-600 flex flex-col resize-y" style={{ background: '#111827', height: '450px', minHeight: '150px' }}>
      {/* Title bar with inline tabs */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-700 dark:border-gray-600 bg-gray-800/80 shrink-0">
        {/* Traffic lights */}
        <div className="flex gap-1.5 shrink-0">
          <span className="w-3 h-3 rounded-full bg-red-500/70" />
          <span className="w-3 h-3 rounded-full bg-yellow-500/70" />
          <span className="w-3 h-3 rounded-full bg-green-500/70" />
        </div>

        {/* Tabs */}
        <div className="flex items-center ml-2 gap-0.5">
          {tabs.map(tab => (
            <div key={tab.id} className="flex items-center">
              <button
                onClick={() => setActiveTabId(tab.id)}
                className={`px-2.5 py-0.5 text-xs font-mono rounded transition-colors cursor-pointer ${
                  activeTabId === tab.id
                    ? 'bg-gray-700 text-gray-200'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700/50'
                }`}
              >
                {tab.label}
              </button>
              {tab.shell && (
                <Tooltip content="Close tab" side="bottom">
                  <button
                    onClick={() => closeTab(tab.id)}
                    className="ml-0.5 p-0.5 rounded text-gray-600 hover:text-gray-300 hover:bg-gray-700 transition-colors cursor-pointer"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </Tooltip>
              )}
            </div>
          ))}
          {bashEnabled && (
            <div className="relative ml-1 flex items-center">
              {/* Default action: sandboxed shell */}
              <Tooltip content="New sandboxed shell" side="bottom">
                <button
                  onClick={() => addBashTab(true)}
                  className="p-0.5 rounded-l text-gray-500 hover:text-gray-300 hover:bg-gray-700 transition-colors cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </Tooltip>
              {/* Dropdown: choose sandboxed vs regular */}
              <Tooltip content="Choose shell type" side="bottom">
                <button
                  onClick={() => setShellMenuOpen(o => !o)}
                  className="p-0.5 rounded-r text-gray-500 hover:text-gray-300 hover:bg-gray-700 transition-colors cursor-pointer"
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
              </Tooltip>
              {shellMenuOpen && (
                <>
                  {/* click-away backdrop */}
                  <div className="fixed inset-0 z-10" onClick={() => setShellMenuOpen(false)} />
                  <div className="absolute left-0 top-full mt-1 z-20 w-56 rounded-md border border-gray-700 bg-gray-800 shadow-lg py-1 text-xs">
                    <button
                      onClick={() => addBashTab(true)}
                      className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-gray-200 hover:bg-gray-700 cursor-pointer"
                    >
                      <Shield className="w-3.5 h-3.5 mt-0.5 text-green-400 shrink-0" />
                      <span>
                        <span className="block font-medium">Sandboxed shell</span>
                        <span className="block text-gray-500">Confined to the worktree, like the agent.</span>
                      </span>
                    </button>
                    <button
                      onClick={() => addBashTab(false)}
                      className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-gray-200 hover:bg-gray-700 cursor-pointer"
                    >
                      <ShieldOff className="w-3.5 h-3.5 mt-0.5 text-yellow-400 shrink-0" />
                      <span>
                        <span className="block font-medium">Regular shell (host)</span>
                        <span className="block text-gray-500">Full host access, no sandbox.</span>
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Status + refresh */}
        <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium ${isRunning ? 'text-green-400' : isWaiting ? 'text-yellow-400' : isLoading ? 'text-blue-400' : 'text-gray-500'}`}>
          {isRunning || isWaiting ? '● ' : '○ '}{status}
        </span>
        <Tooltip content="Refresh" side="bottom">
          <button
            onClick={reconnectActive}
            className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>

      {/* Terminal panes - all mounted, show/hide via CSS */}
      {tabs.map(tab => (
        <div
          key={tab.id}
          className="flex-1 min-h-0 overflow-hidden"
          style={{ display: activeTabId === tab.id ? 'flex' : 'none', flexDirection: 'column' }}
        >
          <TerminalPane
            agentId={agentId}
            projectId={projectId}
            shell={tab.shell}
            sandboxed={tab.sandboxed}
            active={activeTabId === tab.id}
            reconnectAttempt={reconnectKeys[tab.id] ?? 0}
            forceRedrawAttempt={forceRedrawKeys[tab.id] ?? 0}
            onStatusUpdate={tab.id === 'terminal' ? handleStatusUpdate : undefined}
            onDiffRefresh={tab.id === 'terminal' ? onDiffRefresh : undefined}
          />
        </div>
      ))}
    </div>
  )
}
