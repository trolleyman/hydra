import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { TerminalEvent, type TerminalStatusEvent, type TerminalDataEvent, type TerminalDiffRefreshEvent, type TerminalSizeEvent, AgentStatus } from '../api'
import { RefreshCw, Plus, X, ChevronDown, Shield, ShieldOff } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { uploadFile, extractFiles } from '../api/uploads'
import { useAgentStore } from '../stores/agentStore'
import { loadAgentViewPrefs, patchAgentViewPrefs } from '../lib/agentViewPrefs'
import { loadLastGeometry, saveLastGeometry } from '../lib/terminalGeometry'

const DEFAULT_TERMINAL_HEIGHT = 450

interface PaneProps {
  agentId: string
  projectId: string | null
  shell: boolean
  sandboxed: boolean
  shellId: string
  active: boolean
  reconnectAttempt: number
  onStatusUpdate?: (status: string) => void
  onDiffRefresh?: (headMoved: boolean) => void
  onMetrics?: (m: { cols: number; rows: number; cellHeight: number }) => void
}

// loadLastGeometry/saveLastGeometry live in lib/terminalGeometry so the spawn
// form and settings page can share them. The backend uses the last geometry as
// the *initial* PTY size when it starts or resumes a session, so a fresh/resumed
// agent renders at the right width immediately instead of flashing the 80x24
// default and reflowing. It never resizes an already-live PTY (that still waits
// for the client's settled measurement).

function getWsUrl(agentId: string, projectId: string | null, shell?: boolean, sandboxed?: boolean, shellId?: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const params = new URLSearchParams()
  if (shell) {
    params.set('shell', 'true')
    // Default is sandboxed; only signal when the user opted into a host shell.
    if (sandboxed === false) params.set('sandboxed', 'false')
    // Per-tab id: each shell tab is its own process; a refresh reuses the same id.
    if (shellId) params.set('shell_id', shellId)
  }
  // Seed the initial PTY size from the last known geometry (see above).
  const geom = loadLastGeometry()
  if (geom) {
    params.set('cols', String(geom.cols))
    params.set('rows', String(geom.rows))
  }
  const qs = params.toString() ? `?${params.toString()}` : ''
  const pid = projectId ? encodeURIComponent(projectId) : '_'
  return `${protocol}//${host}/ws/projects/${pid}/agents/${encodeURIComponent(agentId)}/terminal${qs}`
}

function TerminalPane({ agentId, projectId, shell, sandboxed, shellId, active, reconnectAttempt, onStatusUpdate, onDiffRefresh, onMetrics }: PaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const isRefreshing = useRef(false)
  const killTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSentSize = useRef({ cols: 0, rows: 0 })
  const stabilizeRafRef = useRef<number | null>(null)
  // True while we're polling for a settled layout width (initial connect or a
  // pane re-activation). Resize events that fire during this window measure a
  // half-settled layout, so fitAndSend suppresses their sends and lets the
  // stabilizer emit the one authoritative size once the width stops changing.
  const settlingRef = useRef(false)
  // True between receiving the backend's "size" event (the PTY's current width)
  // and writing the scrollback replay that follows it. The replay's cursor moves
  // and wrapping were computed for that width, so we size the xterm to it and
  // suppress any fit/resize that would change the width mid-replay — which would
  // land the replayed bytes in the wrong cells and corrupt the history. Once the
  // replay is in we clear this and refit to our own layout (a clean reflow).
  const replaySizingRef = useRef(false)
  const replayFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showCopiedAt, setShowCopiedAt] = useState(0)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Toast above the terminal for upload progress/result of pasted files.
  function showNotice(msg: string, autoHide: boolean) {
    if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current)
    setNotice(msg)
    if (autoHide) noticeTimeoutRef.current = setTimeout(() => setNotice(null), 2500)
  }

  // Fit the terminal to its container and, if the geometry actually changed,
  // forward the new cols/rows to the backend PTY so the agent program receives
  // a SIGWINCH with the correct size. The FitAddon already subtracts the
  // viewport scrollbar width when proposing dimensions, so this never
  // overestimates cols. `force` re-sends even if the geometry is unchanged
  // (used right after the socket opens, when lastSentSize is reset).
  const fitAndSend = useRef<(force?: boolean) => void>(() => {})
  fitAndSend.current = (force = false) => {
    const fitAddon = fitAddonRef.current
    const term = termRef.current
    const ws = wsRef.current
    if (!fitAddon || !term) return
    // While we're applying the PTY's width for a scrollback replay, don't refit:
    // a fit here would resize the xterm away from the replay's authored width and
    // garble the history. We refit once the replay is written (see onmessage).
    if (replaySizingRef.current) return
    fitAddon.fit()
    const { cols, rows } = term
    // Report geometry + measured cell height to the parent so it can snap the
    // panel to whole rows and show the size indicator. Only the active pane is
    // visible/sized, so ignore background panes (their measurements are stale).
    if (active && onMetrics && rows > 0 && containerRef.current) {
      const core = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })._core
      let cellHeight = core?._renderService?.dimensions?.css?.cell?.height ?? 0
      if (!cellHeight) {
        const screen = containerRef.current.querySelector('.xterm-screen') as HTMLElement | null
        if (screen) cellHeight = screen.clientHeight / rows
      }
      if (cellHeight > 0) onMetrics({ cols, rows, cellHeight })
    }
    if (ws?.readyState !== WebSocket.OPEN || cols <= 0 || rows <= 0) return
    // Remember the latest real geometry to seed the next connection's initial
    // PTY size (see loadLastGeometry). Only the active pane reaches here with a
    // valid measurement, so this never records a hidden pane's stale 0-size.
    if (active) saveLastGeometry(cols, rows)
    // Only the visible pane drives the shared PTY size. A hidden pane's
    // ResizeObserver still fires (e.g. switching tabs flips it to display:none,
    // and the panel-resize drag re-lays-out every pane), and during the layout
    // transition it can briefly measure a too-narrow width — sending that would
    // reflow the agent narrow and bake the wrap into the scrollback, exactly the
    // corruption seen when re-showing a pane after closing a sibling tab.
    if (!active) return
    // Likewise suppress sends while a stabilizer is still settling the width;
    // it will emit the final size with force once the layout stops moving.
    if (settlingRef.current && !force) return
    if (!force && cols === lastSentSize.current.cols && rows === lastSentSize.current.rows) return
    ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    lastSentSize.current = { cols, rows }
  }

  // Poll until the container width repeats across two frames (or we've waited
  // long enough), then send the one settled size. Used both on socket open and
  // when a previously-hidden pane is re-shown: in either case the flex layout
  // can still be moving, and measuring mid-transition yields too few columns.
  // While this runs, settlingRef suppresses the ResizeObserver's own sends so
  // only the final, correct geometry reaches the backend PTY.
  const stabilizeThenSend = useRef<() => void>(() => {})
  stabilizeThenSend.current = () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (stabilizeRafRef.current != null) cancelAnimationFrame(stabilizeRafRef.current)
    settlingRef.current = true
    let lastWidth = -1
    let frames = 0
    const tick = () => {
      const node = containerRef.current
      if (!node || ws.readyState !== WebSocket.OPEN) {
        settlingRef.current = false
        return
      }
      const w = node.clientWidth
      if ((w > 0 && w === lastWidth) || frames > 30) {
        settlingRef.current = false
        fitAndSend.current(true)
        return
      }
      lastWidth = w
      frames++
      stabilizeRafRef.current = requestAnimationFrame(tick)
    }
    stabilizeRafRef.current = requestAnimationFrame(tick)
  }

  // Re-fit when tab becomes visible (after display:none -> display:block). The
  // container only has its real size once it's displayed, so a fit done while
  // hidden would compute a wrong (often too-small) geometry.
  useEffect(() => {
    if (!active) return
    // The pane just went display:none -> display:flex. The container only has
    // its real size once displayed and the flex layout has settled, so stabilize
    // on the width before sending — a bare fit here can read a half-laid-out
    // (too-narrow) size and reflow the agent narrow, which then sticks in the
    // scrollback. This is the close-a-sibling-tab / switch-back-to-agent case.
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => stabilizeThenSend.current())
    })
    return () => cancelAnimationFrame(raf)
  }, [active])

  useEffect(() => {
    // Tracks whether this effect run is still current. Set in cleanup so async
    // work started here (e.g. a file upload below) doesn't paint a toast on a
    // different agent after the user has switched — this pane is reused across
    // agents, so a late resolve would land on the wrong terminal.
    let cancelled = false

    // If a kill was scheduled, cancel it because we are remounting
    if (killTimeoutRef.current) {
      clearTimeout(killTimeoutRef.current)
      killTimeoutRef.current = null
    }

    isRefreshing.current = false
    lastSentSize.current = { cols: 0, rows: 0 }
    // Start each connection with a clean sizing state — these refs persist across
    // effect runs (agent switches / reconnects) and a stale value would suppress
    // the new connection's resize.
    settlingRef.current = false
    replaySizingRef.current = false
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

    const url = getWsUrl(agentId, projectId, shell, sandboxed, shellId)
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      // Wait for the container to reach a stable width before telling the
      // backend PTY our geometry. On a fresh mount (e.g. navigating back to an
      // agent) the flex layout can still be settling when the socket opens;
      // measuring then yields too few columns, and sending that reflows the
      // agent's output narrow — which sticks in the scrollback and stays narrow
      // while detached. The backend replays the session's scrollback on attach,
      // so content renders without any buffer wiggling.
      stabilizeThenSend.current()
    }

    // Clear the replay-sizing window and refit to our own layout. Called once the
    // replayed scrollback has been written (or, via the fallback timer, when no
    // replay arrives at all — e.g. a fresh session with empty scrollback).
    const finishReplaySizing = () => {
      if (replayFallbackRef.current) {
        clearTimeout(replayFallbackRef.current)
        replayFallbackRef.current = null
      }
      if (!replaySizingRef.current) return
      replaySizingRef.current = false
      stabilizeThenSend.current()
    }

    ws.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data))
        // The first chunk after a size event is the scrollback replay; now that
        // it's rendered at the PTY's width, refit to our layout (a clean reflow).
        if (replaySizingRef.current) finishReplaySizing()
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
              const refreshEvent = msg as TerminalDiffRefreshEvent
              onDiffRefresh?.(refreshEvent.head_moved ?? false)
              return
            }
            case TerminalEvent.type.DATA: {
              const dataEvent = msg as TerminalDataEvent
              if (dataEvent.data) {
                term.write(dataEvent.data)
              }
              return
            }
            case TerminalEvent.type.SIZE: {
              // The backend reports the PTY's current width right before replaying
              // its scrollback. Size the xterm to match so the replay's cursor
              // moves land correctly, and suppress fits until the replay is in.
              const sizeEvent = msg as TerminalSizeEvent
              if (sizeEvent.cols && sizeEvent.rows) {
                replaySizingRef.current = true
                term.resize(sizeEvent.cols, sizeEvent.rows)
                // Fallback: if no replay chunk follows (empty scrollback), don't
                // stay pinned to the PTY size — refit to our layout shortly.
                if (replayFallbackRef.current) clearTimeout(replayFallbackRef.current)
                replayFallbackRef.current = setTimeout(finishReplaySizing, 200)
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
      const isShiftEnter = e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (e.code === 'Enter' || e.code === 'NumpadEnter')

      // Shift+Enter -> insert a newline instead of submitting. A terminal can't
      // tell Shift+Enter apart from Enter on its own (both yield a bare CR), so
      // the agent submits. Send a bare line feed (\n, 0x0a): agent prompts
      // (Claude Code, Gemini) treat LF as a literal newline while CR submits.
      // The older ESC+CR (\x1b\r) sequence is unreliable on current Claude Code —
      // it shows a transient newline that collapses as soon as you keep typing.
      if (isShiftEnter) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(new Uint8Array([0x0a]))
        }
        return false
      }

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
        // Optimistically flip the agent to "running" the moment a prompt is
        // submitted. A bare CR (Enter) submits the agent's input; Shift+Enter
        // sends ESC+CR straight over the socket (bypassing onData), so it never
        // reaches here and doesn't falsely trigger. The backend UserPromptSubmit
        // hook reports the real status shortly after; until then this avoids the
        // badge lagging on "waiting"/"finished". Shells have no agent status.
        if (!shell && data.includes('\r')) {
          useAgentStore.getState().setOptimisticStatus(agentId, AgentStatus.RUNNING)
          onStatusUpdate?.(AgentStatus.RUNNING)
        }
      }
    })

    // Intercept pastes that carry files (e.g. a screenshot, or a copied file).
    // We upload the file and type its absolute path into the agent's prompt so
    // the agent can read it — the path is valid inside the sandbox. Plain text
    // pastes fall through to xterm. Capture phase + stopImmediatePropagation so
    // xterm never also handles a file paste.
    async function handlePastedFiles(files: File[]) {
      for (const file of files) {
        showNotice(`Uploading ${file.name || 'file'}…`, false)
        try {
          const res = await uploadFile(projectId, file)
          if (cancelled) return
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(new TextEncoder().encode(res.path + ' '))
          }
          showNotice(`Attached ${res.filename}`, true)
        } catch (err) {
          if (cancelled) return
          showNotice(`Upload failed: ${err instanceof Error ? err.message : 'error'}`, true)
        }
      }
    }
    const onPaste = (ev: ClipboardEvent) => {
      const files = extractFiles(ev.clipboardData)
      if (files.length === 0) return // let xterm handle text pastes
      ev.preventDefault()
      ev.stopImmediatePropagation()
      void handlePastedFiles(files)
    }
    const textarea = term.textarea
    textarea?.addEventListener('paste', onPaste, true)

    // Resize terminal when the container element resizes. fitAndSend only sends
    // when the column/row count actually changes, avoiding spurious SIGWINCH
    // signals (e.g. from layout shifts caused by the diff viewer loading content
    // below the terminal).
    const observer = new ResizeObserver(() => fitAndSend.current())
    observer.observe(el)

    return () => {
      cancelled = true
      observer.disconnect()
      if (stabilizeRafRef.current != null) cancelAnimationFrame(stabilizeRafRef.current)
      if (replayFallbackRef.current) clearTimeout(replayFallbackRef.current)
      inputDisposable.dispose()
      textarea?.removeEventListener('paste', onPaste, true)
      ws.close()
      term.dispose()
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current)
      // Drop any visible/pending toast so it doesn't linger on the agent we
      // switch (or reconnect) to — the pane is reused across agents.
      setNotice(null)
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
      {notice && (
        <div className="absolute top-2 left-2 px-2 py-1 bg-blue-900/90 text-gray-100 text-[10px] rounded border border-blue-700 shadow-lg pointer-events-none z-10 max-w-[80%] truncate">
          {notice}
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

// The always-present agent tab. Bash tabs are appended after it.
const TERMINAL_TAB: TabConfig = { id: 'terminal', label: 'Terminal', shell: false, sandboxed: true }

// Rebuild the tab list for an agent from its persisted bash tabs, always keeping
// the fixed agent terminal first.
function tabsFromPrefs(projectId: string | null, agentId: string): TabConfig[] {
  const saved = loadAgentViewPrefs(projectId, agentId).bashTabs ?? []
  return [TERMINAL_TAB, ...saved.map((t) => ({ id: t.id, label: t.label, shell: true, sandboxed: t.sandboxed }))]
}

interface Props {
  agentId: string
  projectId: string | null
  isEphemeral?: boolean
  onRefresh?: () => void
  onStatusUpdate?: (status: string) => void
  onDiffRefresh?: (headMoved: boolean) => void
}

export function AgentTerminal({ agentId, projectId, onRefresh, onStatusUpdate, onDiffRefresh }: Props) {
  // Restore this agent's bash tabs (and which was active) from localStorage, so
  // switching away and back brings the same shells with you rather than dropping
  // them or leaking another agent's tabs in.
  const [tabs, setTabs] = useState<TabConfig[]>(() => tabsFromPrefs(projectId, agentId))
  const [activeTabId, setActiveTabId] = useState(() => {
    const restored = tabsFromPrefs(projectId, agentId)
    const saved = loadAgentViewPrefs(projectId, agentId).activeTabId
    return saved && restored.some((t) => t.id === saved) ? saved : 'terminal'
  })
  const [reconnectKeys, setReconnectKeys] = useState<Record<string, number>>({})
  const [status, setStatus] = useState<string>('pending')
  const [shellMenuOpen, setShellMenuOpen] = useState(false)

  // Persist the height the user drags the terminal panel to, per agent, so each
  // agent's page restores its own layout.
  const rootRef = useRef<HTMLDivElement>(null)
  const paneWrapRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(
    () => loadAgentViewPrefs(projectId, agentId).terminalHeight ?? DEFAULT_TERMINAL_HEIGHT,
  )
  const lastHeightRef = useRef(height)

  // Latest terminal geometry, reported by the active pane. cellHeight drives the
  // row-snapping below; cols/rows feed the "WxH" indicator shown while resizing.
  const metricsRef = useRef({ cellHeight: 0 })
  const [dims, setDims] = useState({ cols: 0, rows: 0 })
  const [isResizing, setIsResizing] = useState(false)
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reportMetrics = useCallback((m: { cols: number; rows: number; cellHeight: number }) => {
    metricsRef.current.cellHeight = m.cellHeight
    setDims(prev => (prev.cols === m.cols && prev.rows === m.rows ? prev : { cols: m.cols, rows: m.rows }))
  }, [])

  // This component is reused (not remounted) when switching agents, so reload
  // the height when the agent changes. Done during render per React's "adjust
  // state when a prop changes" guidance, so the right height paints immediately.
  const heightAgentRef = useRef(agentId)
  if (heightAgentRef.current !== agentId) {
    heightAgentRef.current = agentId
    const h = loadAgentViewPrefs(projectId, agentId).terminalHeight ?? DEFAULT_TERMINAL_HEIGHT
    lastHeightRef.current = h
    setHeight(h)
  }

  // Likewise reload the per-agent bash tabs during render when the agent changes,
  // so we never carry the previous agent's shells over (or persist them onto the
  // new agent). Keep the active tab if it still exists, else fall back to the
  // agent terminal.
  const tabsAgentRef = useRef(agentId)
  if (tabsAgentRef.current !== agentId) {
    tabsAgentRef.current = agentId
    const restored = tabsFromPrefs(projectId, agentId)
    const savedActive = loadAgentViewPrefs(projectId, agentId).activeTabId
    setTabs(restored)
    setActiveTabId(savedActive && restored.some((t) => t.id === savedActive) ? savedActive : 'terminal')
  }

  // Persist the bash tabs (and active tab) for this agent whenever they change.
  // Runs after the agent-switch reset above commits, so it always writes the
  // current agent's tabs to that agent's key.
  useEffect(() => {
    patchAgentViewPrefs(projectId, agentId, {
      bashTabs: tabs.filter((t) => t.shell).map((t) => ({ id: t.id, label: t.label, sandboxed: t.sandboxed })),
      activeTabId,
    })
  }, [tabs, activeTabId, projectId, agentId])

  // Custom drag handle for vertical resize. We deliberately avoid CSS `resize-y`,
  // which changes the height pixel-by-pixel; instead we snap to whole rows on
  // every pointer move so the terminal grows/shrinks one character cell at a time,
  // like GNOME Terminal. `overhead` (title bar + borders) is captured once at drag
  // start and held constant; only the viewport portion is rounded to the nearest
  // cell. Pointer capture routes moves to the handle even when the cursor leaves
  // it, and is released automatically if the component unmounts mid-drag.
  const dragRef = useRef<{ startY: number; startHeight: number; overhead: number; cellHeight: number } | null>(null)

  function onResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const el = rootRef.current
    if (!el) return
    const pane = paneWrapRef.current
    const overhead = pane ? el.offsetHeight - pane.offsetHeight : 0
    dragRef.current = { startY: e.clientY, startHeight: el.offsetHeight, overhead, cellHeight: metricsRef.current.cellHeight }
    e.currentTarget.setPointerCapture(e.pointerId)
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current)
    setIsResizing(true)
  }

  function onResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current
    if (!d) return
    const raw = d.startHeight + (e.clientY - d.startY)
    let target = Math.max(150, Math.round(raw))
    if (d.cellHeight > 0) {
      const rows = Math.max(1, Math.round((raw - d.overhead) / d.cellHeight))
      target = Math.max(150, Math.round(d.overhead + rows * d.cellHeight))
    }
    if (target !== lastHeightRef.current) {
      lastHeightRef.current = target
      setHeight(target)
    }
  }

  function onResizeEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    // Let the indicator linger briefly after the drag, then fade out.
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current)
    resizeTimeoutRef.current = setTimeout(() => setIsResizing(false), 600)
    patchAgentViewPrefs(projectId, agentId, { terminalHeight: lastHeightRef.current })
  }

  // Clear the indicator fade timer on unmount.
  useEffect(() => () => {
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current)
  }, [])

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
    // Closing a shell tab is a deliberate close, so kill its process now rather
    // than letting it idle out the grace period (which exists for reloads /
    // transient disconnects, where the pane unmounts without a real close).
    const tab = tabs.find(t => t.id === id)
    if (tab?.shell) {
      const pid = projectId ? encodeURIComponent(projectId) : '_'
      const params = new URLSearchParams({ shell_id: id })
      if (tab.sandboxed === false) params.set('sandboxed', 'false')
      void fetch(`/shells/projects/${pid}/agents/${encodeURIComponent(agentId)}/close?${params.toString()}`, {
        method: 'POST',
      }).catch(() => { /* best-effort; the idle reaper is the backstop */ })
    }
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
  }

  // Refresh: reconnect the active tab's WebSocket by remounting its pane. On
  // attach the backend replays the session's scrollback, so the terminal
  // re-renders all existing content (rather than just clearing the buffer) and
  // the agent's PTY is re-fitted to the current size.
  function reconnectActive() {
    setReconnectKeys(prev => ({ ...prev, [activeTabId]: (prev[activeTabId] ?? 0) + 1 }))
    onRefresh?.()
  }

  const isRunning = status === AgentStatus.RUNNING || status === AgentStatus.STARTING
  const isWaiting = status === AgentStatus.WAITING
  const isLoading = status === AgentStatus.PENDING || status === AgentStatus.BUILDING

  return (
    <div ref={rootRef} className="relative rounded-lg overflow-hidden border border-gray-700 dark:border-gray-600 flex flex-col" style={{ background: '#111827', height: `${height}px`, minHeight: '150px' }}>
      {/* Size indicator shown while dragging the resize handle; fades out when
          the drag stops. Snapping keeps rows whole, so this reads cleanly. Inset
          a bit from the top-right corner so it sits clearly inside the terminal. */}
      <div
        className={`absolute top-14 right-4 px-2 py-1 bg-gray-900/90 text-gray-200 text-[11px] font-mono rounded border border-gray-600 shadow-lg pointer-events-none z-20 transition-opacity duration-500 ${isResizing ? 'opacity-100' : 'opacity-0'}`}
      >
        {dims.cols}×{dims.rows}
      </div>
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
          ref={activeTabId === tab.id ? paneWrapRef : undefined}
          className="flex-1 min-h-0 overflow-hidden"
          style={{ display: activeTabId === tab.id ? 'flex' : 'none', flexDirection: 'column' }}
        >
          <TerminalPane
            agentId={agentId}
            projectId={projectId}
            shell={tab.shell}
            sandboxed={tab.sandboxed}
            shellId={tab.id}
            active={activeTabId === tab.id}
            reconnectAttempt={reconnectKeys[tab.id] ?? 0}
            onStatusUpdate={tab.id === 'terminal' ? handleStatusUpdate : undefined}
            onDiffRefresh={tab.id === 'terminal' ? onDiffRefresh : undefined}
            onMetrics={reportMetrics}
          />
        </div>
      ))}

      {/* Custom resize handle: a thin strip along the bottom edge. Dragging it
          snaps the height to whole rows (see onResizeMove), so the terminal
          steps one character cell at a time rather than resizing smoothly. */}
      <div
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        className="group absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize z-20 touch-none"
      >
        <div className="mx-auto mt-1 h-0.5 w-10 rounded-full bg-gray-600/0 group-hover:bg-gray-500 transition-colors" />
      </div>
    </div>
  )
}
