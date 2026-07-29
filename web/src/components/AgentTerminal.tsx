import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { TerminalEvent, type TerminalStatusEvent, type TerminalDataEvent, type TerminalDiffRefreshEvent, type TerminalSizeEvent, AgentStatus } from '../api'
import { RefreshCw, Plus, X, ChevronDown, Shield, ShieldOff } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { ResizeGrip } from './ResizeGrip'
import { uploadFile, extractFiles } from '../api/uploads'
import { copyWithToast } from '../lib/copyToast'
import { useAgentStore } from '../stores/agentStore'
import { fileUrlToWorktreeRelative, isTrustedLinkUrl } from '../lib/repoLink'
import { buildRepoSplat } from '../lib/repoSplat'
import { useDialogStore } from '../stores/dialogStore'
import { useShortcutsStore } from '../stores/shortcutsStore'
import { loadAgentViewPrefs, patchAgentViewPrefs } from '../lib/agentViewPrefs'
import { saveLastGeometry } from '../lib/terminalGeometry'
import { loadChatDefaultHeight, DEFAULT_CHAT_HEIGHT } from '../lib/chatPrefs'
import { useFontSizePx, useFontStack } from '../lib/fontPrefs'
import { closeWebSocket } from '../lib/ws'
import { getWsUrl } from '../lib/terminalWs'
import { ChatPane } from './AgentChat'

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


function TerminalPane({ agentId, projectId, shell, sandboxed, shellId, active, reconnectAttempt, onStatusUpdate, onDiffRefresh, onMetrics }: PaneProps) {
  const navigate = useNavigate()
  // The agent's branch + worktree, used to turn a file:// hyperlink the agent
  // printed into an in-app repository-view navigation (see the linkHandler
  // below). Selected as primitives so a poll that leaves them unchanged doesn't
  // re-render this pane. Falls back to the archived list for a finished head.
  const branchName = useAgentStore((s) =>
    (s.agents.find((a) => a.id === agentId) ?? s.archived.find((a) => a.id === agentId))?.branch_name ?? null,
  )
  const worktreePath = useAgentStore((s) =>
    (s.agents.find((a) => a.id === agentId) ?? s.archived.find((a) => a.id === agentId))?.worktree_path ?? null,
  )
  // The chosen terminal font (Settings -> Browser -> Fonts), as a real
  // font-family string: xterm measures the cell off this and takes an option,
  // not a class, so a CSS variable would never reach it.
  const terminalFont = useFontStack('terminal')
  // Held in a ref as well so the connect effect can read the current value
  // without listing it as a dependency - a font change must not tear the
  // WebSocket down and replay the scrollback. The effect below applies it to a
  // live terminal instead.
  const terminalFontRef = useRef(terminalFont)
  // The chosen terminal size, in px. Same story as the family: an xterm option
  // rather than a class, and held in a ref so changing it doesn't re-run the
  // connect effect.
  const terminalSize = useFontSizePx('terminal')
  const terminalSizeRef = useRef(terminalSize)
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
  // suppress any fit/resize that would change the width mid-replay - which would
  // land the replayed bytes in the wrong cells and corrupt the history. Once the
  // replay is in we clear this and refit to our own layout (a clean reflow).
  const replaySizingRef = useRef(false)
  const replayFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // True while a file is dragged over the terminal, driving the drop overlay.
  const [dragActive, setDragActive] = useState(false)

  // Latest status/diff handlers, read from the socket + data callbacks below. The
  // connection effect must NOT list them as deps (a fresh callback identity from the
  // parent each render would tear the terminal down and reconnect it), so mirror
  // them here and keep the mirror current after commit - the callbacks fire later.
  const onStatusUpdateRef = useRef(onStatusUpdate)
  const onDiffRefreshRef = useRef(onDiffRefresh)
  useEffect(() => {
    onStatusUpdateRef.current = onStatusUpdate
    onDiffRefreshRef.current = onDiffRefresh
  })

  // Latest context for the terminal's OSC 8 link handler. The handler is wired
  // once when the xterm instance is created (that effect must not depend on
  // these - a changed branch/worktree shouldn't tear down and reconnect the
  // socket), so it reads them through this ref, kept current after each commit.
  const linkCtxRef = useRef({ branchName, worktreePath, projectId, navigate })
  useEffect(() => {
    linkCtxRef.current = { branchName, worktreePath, projectId, navigate }
  })

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
  // Defined each render to capture the latest props/state, but published to the ref
  // in an effect below - a render must never write a ref. The async callers
  // (ResizeObserver, RAF, socket handlers) only ever read the ref after commit.
  const runFitAndSend = (force = false) => {
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
    // transition it can briefly measure a too-narrow width - sending that would
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
  useEffect(() => {
    fitAndSend.current = runFitAndSend
  })

  // Poll until the container geometry repeats across three frames (or we've
  // waited long enough), then send the one settled size. Width-only settling
  // raced a chat -> terminal switch: the split's width was already stable while
  // its flex height was still changing, leaving Codex's TUI blank/corrupted
  // until the user moved the divider and triggered another ResizeObserver tick.
  // Used both on socket open and
  // when a previously-hidden pane is re-shown: in either case the flex layout
  // can still be moving, and measuring mid-transition yields too few columns.
  // While this runs, settlingRef suppresses the ResizeObserver's own sends so
  // only the final, correct geometry reaches the backend PTY.
  const stabilizeThenSend = useRef<() => void>(() => {})
  // Same latest-closure-in-a-ref pattern as runFitAndSend above: defined each render,
  // published to the ref in an effect (never during render), read only by callers.
  const runStabilizeThenSend = () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (stabilizeRafRef.current != null) cancelAnimationFrame(stabilizeRafRef.current)
    settlingRef.current = true
    let lastGeometry = ''
    let stableFrames = 0
    let frames = 0
    const tick = () => {
      const node = containerRef.current
      if (!node || ws.readyState !== WebSocket.OPEN) {
        settlingRef.current = false
        return
      }
      const geometry = `${node.clientWidth}x${node.clientHeight}`
      stableFrames = geometry === lastGeometry ? stableFrames + 1 : 0
      if ((node.clientWidth > 0 && node.clientHeight > 0 && stableFrames >= 2) || frames > 30) {
        settlingRef.current = false
        fitAndSend.current(true)
        return
      }
      lastGeometry = geometry
      frames++
      stabilizeRafRef.current = requestAnimationFrame(tick)
    }
    stabilizeRafRef.current = requestAnimationFrame(tick)
  }
  useEffect(() => {
    stabilizeThenSend.current = runStabilizeThenSend
  })

  // Re-fit when tab becomes visible (after display:none -> display:block). The
  // container only has its real size once it's displayed, so a fit done while
  // hidden would compute a wrong (often too-small) geometry.
  useEffect(() => {
    if (!active) return
    // The pane just went display:none -> display:flex. The container only has
    // its real size once displayed and the flex layout has settled, so stabilize
    // on the width before sending - a bare fit here can read a half-laid-out
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
    // different agent after the user has switched - this pane is reused across
    // agents, so a late resolve would land on the wrong terminal.
    let cancelled = false

    // If a kill was scheduled, cancel it because we are remounting
    if (killTimeoutRef.current) {
      clearTimeout(killTimeoutRef.current)
      killTimeoutRef.current = null
    }

    isRefreshing.current = false
    lastSentSize.current = { cols: 0, rows: 0 }
    // Start each connection with a clean sizing state - these refs persist across
    // effect runs (agent switches / reconnects) and a stale value would suppress
    // the new connection's resize.
    settlingRef.current = false
    replaySizingRef.current = false
    const el = containerRef.current
    if (!el) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: terminalSizeRef.current,
      fontFamily: terminalFontRef.current,
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
      // Handle the OSC 8 hyperlinks agents print (Claude Code underlines the
      // files it touches, and prints https:// links for e.g. OAuth). Without a
      // handler xterm pops a `confirm()` for every link - and drops file:// ones
      // entirely unless allowNonHttpProtocols is set. We take over both:
      //   • a file:// link inside this agent's worktree opens in the in-app
      //     repository view on the agent's branch (no prompt);
      //   • an http(s) link opens straight away for trusted hosts, and for
      //     everything else raises Hydra's own confirmation dialog.
      // allowNonHttpProtocols lets file:// reach activate; the worktree check in
      // fileUrlToWorktreeRelative is the guard that flag warns to add.
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (_event, uri) => {
          const { branchName, worktreePath, projectId, navigate } = linkCtxRef.current
          const target = fileUrlToWorktreeRelative(uri, worktreePath)
          if (target && branchName && projectId) {
            navigate({
              to: '/project/$projectId/repository/$',
              params: { projectId, _splat: buildRepoSplat(branchName, target.path) },
              // Carry a line reference as an #L<n> hash the repository view
              // scrolls to and highlights.
              hash: target.line != null ? `L${target.line}` : undefined,
            })
            return
          }
          if (/^https?:/i.test(uri)) {
            if (isTrustedLinkUrl(uri, window.location.origin)) {
              window.open(uri, '_blank', 'noopener,noreferrer')
              return
            }
            // Hydra's own dialog rather than window.confirm: the whole decision
            // rests on reading the URL, and a native confirm renders it as
            // unstyled OS chrome, on one squeezed line, with no way to lowlight
            // the part that says where it really goes. Opening still happens
            // inside the confirm button's click, so it is a user gesture and no
            // popup blocker sees it.
            useDialogStore.getState().show({
              title: 'Open external link?',
              message: 'A link in the terminal wants to open outside Hydra. Check where it goes before you follow it - the text an agent prints is not necessarily where it points.',
              type: 'confirm',
              variant: 'externalLink',
              details: { url: uri },
              confirmLabel: 'Open link',
              onConfirm: () => window.open(uri, '_blank', 'noopener,noreferrer'),
            })
            return
          }
          // A file:// link outside the worktree (or any other scheme): the
          // browser can't usefully open it, so do nothing rather than confirm.
        },
      },
    })

    // Unicode 11 character widths. xterm's built-in table is Unicode 6, which
    // predates the emoji width rules: it gives ✅ 🚀 and friends ONE column,
    // where the browser paints them at ~2 (measured: 16px of ink in an 8px cell).
    // Everything on the other end of the PTY - glibc's wcwidth, ncurses, Go's
    // runewidth, the agent CLIs - has said 2 for years, so the built-in table is
    // the odd one out, and matching it is what keeps a TUI's columns lined up.
    //
    // The unicode11 addon rather than unicode-graphemes: the latter is the only
    // one that would also widen an explicit ⚠️ (U+26A0 U+FE0F) to two columns,
    // because it clusters the variation selector with its base - but upstream
    // marks it experimental and warns it "may introduce unexpected and
    // non-standard behaviour", which is not a thing to put under every agent's
    // terminal by default.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(el)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon

    // xterm measures the character cell once, at open(). If the chosen webfont
    // hasn't arrived yet it measures the fallback, and the grid stays that size
    // - visibly wrong columns, and a cols/rows the PTY was never told about.
    // Re-measure once the face is actually loaded. document.fonts.load resolves
    // immediately for a system stack, so this costs nothing in that case.
    document.fonts
      .load(`${term.options.fontSize}px ${terminalFontRef.current}`)
      .then(() => {
        if (cancelled || termRef.current !== term) return
        term.clearTextureAtlas()
        fitAndSend.current(true)
      })
      .catch(() => {})

    const url = getWsUrl(agentId, projectId, shell, sandboxed, shellId)
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      // Wait for the container to reach a stable width before telling the
      // backend PTY our geometry. On a fresh mount (e.g. navigating back to an
      // agent) the flex layout can still be settling when the socket opens;
      // measuring then yields too few columns, and sending that reflows the
      // agent's output narrow - which sticks in the scrollback and stays narrow
      // while detached. The backend replays the session's scrollback on attach,
      // so content renders without any buffer wiggling.
      stabilizeThenSend.current()
    }

    // Clear the replay-sizing window and refit to our own layout. Called once the
    // replayed scrollback has been written (or, via the fallback timer, when no
    // replay arrives at all - e.g. a fresh session with empty scrollback).
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
                onStatusUpdateRef.current?.(newStatus)
              }
              return
            }
            case TerminalEvent.type.DIFF_REFRESH: {
              const refreshEvent = msg as TerminalDiffRefreshEvent
              onDiffRefreshRef.current?.(refreshEvent.head_moved ?? false)
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
                // stay pinned to the PTY size - refit to our layout shortly.
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
      onStatusUpdateRef.current?.('stopped')
    }

    ws.onerror = () => {
      term.writeln('\r\n\x1b[31m[connection error]\x1b[0m')
    }

    const isMac = /Mac/.test(navigator.platform)

    // Custom key handler for clipboard operations
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true

      // While a modal dialog (or the shortcuts overlay) is open, Enter/Escape
      // belong to it - Enter confirms the primary action, Escape cancels (see
      // the window listener in Dialog.tsx). Swallow them here so xterm never
      // also sends a stray CR/ESC to the PTY (which would submit the agent's
      // prompt behind the dialog). Returning false stops xterm from forwarding
      // the byte while the keydown still bubbles to that window listener - the
      // same trick the Ctrl+M / Ctrl+U agent shortcuts rely on below.
      if (e.key === 'Enter' || e.key === 'Escape') {
        if (useDialogStore.getState().isOpen || useShortcutsStore.getState().open) {
          return false
        }
      }

      const isCopyShortcut = (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && e.code === 'KeyC'
      const isPasteShortcut = (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && e.code === 'KeyV'
      const isLiteralVShortcut = (isMac ? e.metaKey : e.ctrlKey) && e.shiftKey && e.code === 'KeyV'
      const isShiftEnter = e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (e.code === 'Enter' || e.code === 'NumpadEnter')

      // Shift+Enter -> insert a newline instead of submitting. A terminal can't
      // tell Shift+Enter apart from Enter on its own (both yield a bare CR), so
      // the agent submits. Send a bare line feed (\n, 0x0a): agent prompts
      // (Claude Code, Gemini) treat LF as a literal newline while CR submits.
      // The older ESC+CR (\x1b\r) sequence is unreliable on current Claude Code -
      // it shows a transient newline that collapses as soon as you keep typing.
      if (isShiftEnter) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(new Uint8Array([0x0a]))
        }
        return false
      }

      // Ctrl+M (merge) / Ctrl+U (mark unread) are agent-wide actions that must
      // work even while the terminal is focused. In a terminal these combos are
      // otherwise Enter (CR) and kill-line, so swallow them here: returning false
      // stops xterm from sending the byte to the PTY, while the keydown still
      // bubbles to the window listener in AgentDetail that runs the action. Ctrl
      // on every platform (matches lib/shortcuts hasMod), keyed off e.key so it
      // agrees with AgentDetail on which physical key counts as M / U.
      const actionKey = e.key.toLowerCase()
      const isAgentActionShortcut =
        e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && (actionKey === 'm' || actionKey === 'u')
      if (isAgentActionShortcut) {
        return false
      }

      // Copy with selection -> copy and clear selection (no ^C sent)
      if (isCopyShortcut) {
        const selection = term.getSelection()
        if (selection) {
          // The same copy toast every other copy action raises (title + the
          // copied text in a code block, clamped to a few lines). copyWithToast
          // goes through copyText, which works on insecure LAN origins
          // (undefined navigator.clipboard) and reports whether the text
          // actually landed - so the toast reflects the true outcome rather
          // than assuming the write succeeded.
          void copyWithToast(selection, { what: 'terminal selection' })
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
        //
        // But NOT when the agent is asking a question (needs_input): answering
        // one AskUserQuestion prompt often just leads to the next one, so forcing
        // "running" here would wrongly clear the "needs you" state - and the
        // optimistic override would then mask the real backend needs_input for
        // its whole TTL. Leave needs_input alone and let the backend report the
        // true next state (another question, or genuinely running).
        const curStatus = useAgentStore.getState().agents.find((a) => a.id === agentId)?.agent_status?.status
        if (!shell && data.includes('\r') && curStatus !== AgentStatus.NEEDS_INPUT) {
          useAgentStore.getState().setOptimisticStatus(agentId, AgentStatus.RUNNING)
          onStatusUpdateRef.current?.(AgentStatus.RUNNING)
        }
      }
    })

    // Intercept pastes that carry files (e.g. a screenshot, or a copied file).
    // We upload the file and type its absolute path into the agent's prompt so
    // the agent can read it - the path is valid inside the sandbox. Capture
    // phase + stopImmediatePropagation so xterm never also handles an
    // intercepted paste.
    async function handlePastedFiles(files: File[]) {
      for (const file of files) {
        showNotice(`Uploading ${file.name || 'file'}...`, false)
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
      if (files.length > 0) {
        ev.preventDefault()
        ev.stopImmediatePropagation()
        void handlePastedFiles(files)
        return
      }
      // Text pastes with newlines: xterm normalizes every newline to CR (\r),
      // and a bare CR submits the agent's prompt - so pasting text that ends
      // in a newline would send the message immediately. Unless the app has
      // enabled bracketed paste (in which case it handles pasted newlines
      // itself), rewrite newlines to LF (\n), which agent prompts treat as a
      // literal newline (the same trick as Shift+Enter above), and drop
      // trailing newlines entirely. Shells are left alone: for a shell LF
      // executes a line just like CR, so rewriting wouldn't help.
      if (shell || term.modes.bracketedPasteMode) return // let xterm handle it
      const text = ev.clipboardData?.getData('text') ?? ''
      if (!/[\r\n]/.test(text)) return // single-line paste, nothing to fix
      ev.preventDefault()
      ev.stopImmediatePropagation()
      const safe = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
      if (safe && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(safe))
        term.scrollToBottom()
      }
    }
    const textarea = term.textarea
    textarea?.addEventListener('paste', onPaste, true)

    // Drag-and-drop of files onto the terminal, mirroring the file-paste path:
    // upload each dropped file and type its absolute (sandbox-valid) path into
    // the agent's prompt. Only file drags are intercepted; a text/URL drag is
    // left to xterm. Listeners live on the container (el) so the drop zone
    // covers the whole pane, not just xterm's focus textarea.
    const isFileDrag = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes('Files')
    const onDragOver = (ev: DragEvent) => {
      if (!isFileDrag(ev.dataTransfer)) return
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
      setDragActive(true)
    }
    const onDragLeave = (ev: DragEvent) => {
      // Ignore leaves that just cross into a child element still inside the pane.
      if (ev.relatedTarget && el.contains(ev.relatedTarget as Node)) return
      setDragActive(false)
    }
    const onDrop = (ev: DragEvent) => {
      setDragActive(false)
      if (!isFileDrag(ev.dataTransfer)) return
      ev.preventDefault()
      const files = extractFiles(ev.dataTransfer)
      if (files.length > 0) void handlePastedFiles(files)
    }
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('drop', onDrop)

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
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('drop', onDrop)
      setDragActive(false)
      closeWebSocket(ws)
      term.dispose()
      if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current)
      // Drop any visible/pending notice so it doesn't linger on the agent we
      // switch (or reconnect) to - the pane is reused across agents.
      setNotice(null)
      termRef.current = null
      wsRef.current = null
      fitAddonRef.current = null
    }
    // shell/sandboxed/shellId define the connection (see getWsUrl) and are constant
    // for a pane's lifetime (TerminalPane is keyed by tab id), so listing them can't
    // cause spurious reconnects. onStatusUpdate/onDiffRefresh are read via refs above.
  }, [agentId, projectId, reconnectAttempt, shell, sandboxed, shellId])

  // Apply a font change - family or size - to the live terminal. Either one
  // means a different cell, so the grid has to be re-measured and the new
  // cols/rows pushed to the PTY; the agent sees this as a window resize, which
  // is the honest thing for it to see. One effect for both because they land on
  // the same terminal through the same re-measure, and doing them separately
  // would fit twice (and send the PTY an intermediate geometry) when a browser
  // rehydrates both prefs at once. The ref checks make the mount run a no-op:
  // the connect effect above already opened the terminal with these values.
  useEffect(() => {
    const sameFont = terminalFontRef.current === terminalFont
    const sameSize = terminalSizeRef.current === terminalSize
    if (sameFont && sameSize) return
    terminalFontRef.current = terminalFont
    terminalSizeRef.current = terminalSize
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = terminalFont
    term.options.fontSize = terminalSize
    document.fonts
      .load(`${terminalSize}px ${terminalFont}`)
      .catch(() => {})
      .finally(() => {
        if (termRef.current !== term) return
        term.clearTextureAtlas()
        fitAndSend.current(true)
      })
  }, [terminalFont, terminalSize])

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden flex flex-col">
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden"
      />
      {notice && (
        <div className="absolute top-2 left-2 px-2 py-1 bg-blue-900/90 text-gray-100 text-[10px] rounded border border-blue-700 shadow-lg pointer-events-none z-10 max-w-[80%] truncate">
          {notice}
        </div>
      )}
      {dragActive && (
        <div className="absolute inset-0 flex items-center justify-center bg-blue-950/70 border-2 border-dashed border-blue-400 rounded pointer-events-none z-20">
          <div className="px-3 py-1.5 bg-blue-900/90 text-gray-100 text-xs rounded border border-blue-700 shadow-lg">
            Drop files to attach
          </div>
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
  agentType?: string
  projectId: string | null
  isEphemeral?: boolean
  // chatMode renders the agent tab as a chat view (stream-json framing)
  // instead of an xterm. Bash tabs stay terminals either way.
  chatMode?: boolean
  // fill: the new split layout drops the fixed-height drag window and lets the
  // terminal/chat grow to fill its pane (the left working pane). The vertical
  // resize handle, row-snap and the terminalHeight/chat-default-height prefs are
  // all artifacts of being a window inside a scroll column, so they're inert
  // here. Omitted -> the classic fixed-height dragged window.
  fill?: boolean
  // reconnectSignal: bumping this number from the parent reconnects the agent
  // tab's socket, the same way the title bar's Refresh button does. Used after
  // restarting the agent process, so the pane attaches to the new session
  // instead of sitting on the closed one.
  reconnectSignal?: number
  onRefresh?: () => void
  onStatusUpdate?: (status: string) => void
  onDiffRefresh?: (headMoved: boolean) => void
  // Chat mode only: a commit chip was clicked - show that commit's diff.
  onSelectCommit?: (sha: string) => void
}

// memo: AgentDetail re-renders on every live tick of its agent (activity line,
// streamed test counts); the terminal only cares about identity-stable props,
// so those ticks skip the whole tab strip + xterm/chat subtree.
export const AgentTerminal = memo(AgentTerminalImpl)

function AgentTerminalImpl({ agentId, agentType, projectId, chatMode, fill, reconnectSignal, onRefresh, onStatusUpdate, onDiffRefresh, onSelectCommit }: Props) {
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
  // The panel opens at this agent's saved (dragged) height if it has one; failing
  // that, chat agents fall back to the chat default height and terminal agents to
  // the terminal default, so the two kinds of window can start at different sizes.
  const [height, setHeight] = useState(
    () =>
      loadAgentViewPrefs(projectId, agentId).terminalHeight ??
      (chatMode ? loadChatDefaultHeight() ?? DEFAULT_CHAT_HEIGHT : DEFAULT_TERMINAL_HEIGHT),
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

  // The whole AgentDetail subtree (this component included) is remounted on every
  // agent switch - the route keys it by project+agent - so each agent's terminal
  // mounts fresh with its own height, tabs and a brand-new xterm/WebSocket; the
  // backend replays scrollback on attach so the switch still looks seamless. No
  // hand-reset of height/tabs on an agent-id change is needed: this instance only
  // ever serves one agent.

  // Persist the bash tabs (and active tab) for this agent whenever they change.
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

  // Parent-driven reconnect (e.g. after restarting the agent process): folded
  // into the agent tab's reconnect count so bumping it remounts that pane - it
  // drops the closed socket and re-attaches to the fresh session (which replays
  // scrollback). Only the 'terminal' tab is the agent process; bash tabs are
  // unaffected. Derived rather than an effect so it can't cascade renders.
  const terminalReconnect = (reconnectKeys.terminal ?? 0) + (reconnectSignal ?? 0)

  const isRunning = status === AgentStatus.RUNNING || status === AgentStatus.STARTING
  const isNeedsInput = status === AgentStatus.NEEDS_INPUT
  const isWaiting = status === AgentStatus.WAITING
  const isLoading = status === AgentStatus.PENDING || status === AgentStatus.BUILDING

  // While the chat tab is showing, the panel sheds its terminal-window
  // costume (dark chrome, traffic lights) and follows the app theme like the
  // chat pane inside it; bash tabs bring the terminal look back.
  const chatActive = !!chatMode && activeTabId === 'terminal'
  // Ghost icon-button palette for the title bar, per costume.
  const ghostBtn = chatActive
    ? 'text-stone-400 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300 hover:bg-stone-200/60 dark:hover:bg-white/[0.06]'
    : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'

  return (
    <div
      ref={rootRef}
      className={`relative rounded-lg overflow-hidden border flex flex-col ${fill ? 'flex-1 min-h-0' : ''} ${
        chatActive
          ? 'border-stone-200 dark:border-stone-700/70 bg-[#faf9f5] dark:bg-[#262624]'
          : 'border-gray-700 dark:border-gray-600'
      }`}
      // fill: grow to the pane height (no fixed/dragged window). Otherwise the
      // classic dragged window at the saved/default pixel height.
      style={fill
        ? (chatActive ? {} : { background: '#111827' })
        : { ...(chatActive ? {} : { background: '#111827' }), height: `${height}px`, minHeight: '150px' }}
    >
      {/* Size indicator shown while dragging the resize handle; fades out when
          the drag stops. Snapping keeps rows whole, so this reads cleanly. Inset
          a bit from the top-right corner so it sits clearly inside the terminal.
          The chat pane has no character grid, so there's nothing meaningful to
          show (it would read "0x0") - suppress it there. */}
      {!chatActive && (
        <div
          className={`absolute top-14 right-4 px-2 py-1 bg-gray-900/90 text-gray-200 text-[11px] font-mono rounded border border-gray-600 shadow-lg pointer-events-none z-20 transition-opacity duration-500 ${isResizing ? 'opacity-100' : 'opacity-0'}`}
        >
          {dims.cols}×{dims.rows}
        </div>
      )}
      {/* Title bar with inline tabs */}
      <div
        className={`flex items-center gap-1 px-3 py-2 border-b shrink-0 ${
          chatActive
            ? 'border-stone-200/90 dark:border-white/[0.06] bg-[#f4f2ec] dark:bg-[#2b2b28]'
            : 'border-gray-700 dark:border-gray-600 bg-gray-800/80'
        }`}
      >
        {/* Traffic lights: terminal-window dressing only */}
        {!chatActive && (
          <div className="flex gap-1.5 shrink-0">
            <span className="w-3 h-3 rounded-full bg-red-500/70" />
            <span className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <span className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
        )}

        {/* Tabs */}
        <div className={`flex items-center gap-0.5 ${chatActive ? '' : 'ml-2'}`}>
          {tabs.map(tab => (
            <div key={tab.id} className="flex items-center">
              <button
                onClick={() => setActiveTabId(tab.id)}
                className={`px-2.5 py-0.5 text-xs font-mono rounded transition-colors cursor-pointer ${
                  chatActive
                    ? activeTabId === tab.id
                      ? 'bg-stone-200/80 dark:bg-white/[0.08] text-stone-800 dark:text-stone-100'
                      : 'text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-200/50 dark:hover:bg-white/[0.05]'
                    : activeTabId === tab.id
                      ? 'bg-gray-700 text-gray-200'
                      : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700/50'
                }`}
              >
                {tab.id === 'terminal' && chatMode ? 'Chat' : tab.label}
              </button>
              {tab.shell && (
                <Tooltip content="Close tab" side="bottom">
                  <button
                    onClick={() => closeTab(tab.id)}
                    className={`ml-0.5 p-0.5 rounded transition-colors cursor-pointer ${ghostBtn}`}
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
                  className={`p-0.5 rounded-l transition-colors cursor-pointer ${ghostBtn}`}
                >
                  <Plus className="w-3 h-3" />
                </button>
              </Tooltip>
              {/* Dropdown: choose sandboxed vs regular */}
              <Tooltip content="Choose shell type" side="bottom">
                <button
                  onClick={() => setShellMenuOpen(o => !o)}
                  className={`p-0.5 rounded-r transition-colors cursor-pointer ${ghostBtn}`}
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
              </Tooltip>
              {shellMenuOpen && (
                <>
                  {/* click-away backdrop. z-30 keeps it above the chat pane's
                      ChatViewSelector (z-20) so this dropdown wins the overlap. */}
                  <div className="fixed inset-0 z-30" onClick={() => setShellMenuOpen(false)} />
                  <div
                    className={`absolute left-0 top-full mt-1 z-40 w-56 rounded-md border shadow-lg py-1 text-xs ${
                      chatActive
                        ? 'border-stone-200 dark:border-white/10 bg-white dark:bg-[#30302e]'
                        : 'border-gray-700 bg-gray-800'
                    }`}
                  >
                    <button
                      onClick={() => addBashTab(true)}
                      className={`flex w-full items-start gap-2 px-3 py-1.5 text-left cursor-pointer ${
                        chatActive
                          ? 'text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-white/[0.06]'
                          : 'text-gray-200 hover:bg-gray-700'
                      }`}
                    >
                      <Shield className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${chatActive ? 'text-green-600 dark:text-green-400' : 'text-green-400'}`} />
                      <span>
                        <span className="block font-medium">Sandboxed shell</span>
                        <span className={`block ${chatActive ? 'text-stone-400 dark:text-stone-500' : 'text-gray-500'}`}>Confined to the worktree, like the agent.</span>
                      </span>
                    </button>
                    <button
                      onClick={() => addBashTab(false)}
                      className={`flex w-full items-start gap-2 px-3 py-1.5 text-left cursor-pointer ${
                        chatActive
                          ? 'text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-white/[0.06]'
                          : 'text-gray-200 hover:bg-gray-700'
                      }`}
                    >
                      <ShieldOff className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${chatActive ? 'text-amber-600 dark:text-yellow-400' : 'text-yellow-400'}`} />
                      <span>
                        <span className="block font-medium">Regular shell (host)</span>
                        <span className={`block ${chatActive ? 'text-stone-400 dark:text-stone-500' : 'text-gray-500'}`}>Full host access, no sandbox.</span>
                      </span>
                    </button>
                  </div>
                </>
              )}
          </div>
        </div>

        {/* Status + refresh */}
        <span
          className={`ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium ${
            isRunning
              ? chatActive ? 'text-green-600 dark:text-green-400' : 'text-green-400'
              : isNeedsInput
                ? chatActive ? 'text-red-600 dark:text-red-400' : 'text-red-400'
                : isWaiting
                  ? chatActive ? 'text-amber-600 dark:text-yellow-400' : 'text-yellow-400'
                  : isLoading
                    ? chatActive ? 'text-blue-600 dark:text-blue-400' : 'text-blue-400'
                    : chatActive ? 'text-stone-400 dark:text-stone-500' : 'text-gray-500'
          }`}
        >
          {isRunning || isNeedsInput || isWaiting ? '● ' : '○ '}{status}
        </span>
        <Tooltip content="Refresh" side="bottom">
          <button
            onClick={reconnectActive}
            className={`p-1 rounded transition-colors cursor-pointer ${ghostBtn}`}
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
          {tab.id === 'terminal' && chatMode ? (
            <ChatPane
              agentId={agentId}
              agentType={agentType}
              projectId={projectId}
              active={activeTabId === tab.id}
              reconnectAttempt={terminalReconnect}
              onStatusUpdate={handleStatusUpdate}
              onDiffRefresh={onDiffRefresh}
              onSelectCommit={onSelectCommit}
            />
          ) : (
            <TerminalPane
              agentId={agentId}
              projectId={projectId}
              shell={tab.shell}
              sandboxed={tab.sandboxed}
              shellId={tab.id}
              active={activeTabId === tab.id}
              reconnectAttempt={tab.id === 'terminal' ? terminalReconnect : (reconnectKeys[tab.id] ?? 0)}
              onStatusUpdate={tab.id === 'terminal' ? handleStatusUpdate : undefined}
              onDiffRefresh={tab.id === 'terminal' ? onDiffRefresh : undefined}
              onMetrics={reportMetrics}
            />
          )}
        </div>
      ))}

      {/* Custom resize handle: a thin strip along the bottom edge. Dragging it
          snaps the height to whole rows (see onResizeMove), so the terminal
          steps one character cell at a time rather than resizing smoothly.
          In fill mode the terminal grows to its pane, so there's nothing to drag. */}
      {!fill && (
        <div
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          title="Drag to resize"
          className="group/resize absolute bottom-0 left-0 right-0 h-2 flex items-end justify-center cursor-ns-resize z-20 touch-none"
        >
          <ResizeGrip orientation="horizontal" />
        </div>
      )}
    </div>
  )
}
