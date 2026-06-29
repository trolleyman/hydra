import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { ArtifactSet, ArtifactLogLine } from '../api'
import { useIsDark } from '../lib/theme'

// LOG_SCROLLBACK bounds the xterm scrollback for build logs. The live in-memory
// log is capped at maxLogLines (5000) backend-side; persisted logs can run longer,
// so we keep a generous buffer — vastly cheaper than the old one-DOM-node-per-line.
const LOG_SCROLLBACK = 20000

// xterm palettes for the build-log terminal, matching the light/dark log box.
// Each theme sets an OPAQUE background matching its container (gray-50 in light,
// gray-900 in dark): xterm's `allowTransparency` doesn't reliably honour an
// alpha-0 background here — the rgb is painted opaque — so a transparent
// background rendered as solid black, leaving the light theme's dark gray-600
// text unreadable on black. stderr is tinted via SGR red, so `red` must read
// well on each background.
// selectionBackground / selectionInactiveBackground are set explicitly: xterm's
// default selection is a faint translucent grey that all but vanishes on the
// light theme's near-white background, so dragging to select log text gave no
// visible highlight (the log is copyable via Ctrl/Cmd+C — see LogView). A solid,
// theme-appropriate blue (the VS Code selection colours) keeps the selected text
// readable on both backgrounds.
const LOG_THEME_DARK = {
  background: '#111827', // gray-900
  foreground: '#d1d5db', // gray-300
  selectionBackground: '#264f78', selectionInactiveBackground: '#3a3d41',
  black: '#1f2937', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
  blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#f9fafb',
  brightBlack: '#6b7280', brightRed: '#fca5a5', brightGreen: '#86efac',
  brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9', brightWhite: '#ffffff',
}
const LOG_THEME_LIGHT = {
  background: '#f9fafb', // gray-50
  foreground: '#4b5563', // gray-600
  selectionBackground: '#add6ff', selectionInactiveBackground: '#e2e8f0',
  black: '#374151', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04',
  blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#6b7280',
  brightBlack: '#6b7280', brightRed: '#ef4444', brightGreen: '#22c55e',
  brightYellow: '#eab308', brightBlue: '#3b82f6', brightMagenta: '#a855f7',
  brightCyan: '#06b6d4', brightWhite: '#111827',
}

// formatLogLine turns one captured line into the bytes written to xterm. The
// line's own ANSI is preserved (rendered as real colour); a stderr line with no
// colour of its own is tinted red, with a trailing reset so it can't bleed into
// the next line.
function formatLogLine(l: ArtifactLogLine): string {
  return (l.stream as string) === 'stderr' ? `\x1b[31m${l.text}\x1b[0m\r\n` : `${l.text}\r\n`
}

// LogView streams a build's stdout+stderr into an xterm.js terminal. It writes
// only newly-arrived lines to the terminal instead of re-rendering the whole log
// through React, renders ANSI colour natively, and auto-follows the tail unless
// the user scrolls up — xterm handles all three, so a very large, fast-updating
// log stays smooth where the old map-the-whole-array approach lagged badly.
export function LogView({ log, emptyText = 'Waiting for output…', failed = false, succeeded = false }: { log: ArtifactLogLine[]; emptyText?: string; failed?: boolean; succeeded?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // How many lines we've written to the terminal, plus the identity of the last
  // one. A live append keeps the same line objects for its prefix, so a matching
  // tail means "extended — write only the new lines"; any mismatch (the array
  // shrank, or was swapped wholesale, e.g. the settled log replacing the live one)
  // means "redraw from scratch".
  const writtenRef = useRef(0)
  const lastLineRef = useRef<ArtifactLogLine | null>(null)
  const isDark = useIsDark()

  // Create the terminal once: read-only (no stdin, hidden cursor), fit to its
  // container and refit on resize so wrapping tracks the box width.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      fontSize: 11,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, "Courier New", monospace',
      scrollback: LOG_SCROLLBACK,
      convertEol: true,
      allowTransparency: true,
      theme: document.documentElement.classList.contains('dark') ? LOG_THEME_DARK : LOG_THEME_LIGHT,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    try { fit.fit() } catch { /* not laid out yet; the ResizeObserver refits */ }
    term.write('\x1b[?25l') // hide the cursor — this is a read-only view

    // Ctrl/Cmd+C copies the current selection. stdin is disabled (read-only log),
    // so the key would otherwise do nothing; intercept it before xterm to put the
    // selected text on the clipboard, and let the keypress through when there's no
    // selection so the browser's own handling still applies.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'c' || e.key === 'C') && term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection())
        return false
      }
      return true
    })
    termRef.current = term
    fitRef.current = fit

    const ro = new ResizeObserver(() => { try { fit.fit() } catch { /* mid-layout */ } })
    ro.observe(el)
    return () => {
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      writtenRef.current = 0
      lastLineRef.current = null
    }
  }, [])

  // Recolour live when the theme flips.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = isDark ? LOG_THEME_DARK : LOG_THEME_LIGHT
  }, [isDark])

  // Write newly-arrived lines, or redraw from scratch on a wholesale change.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const written = writtenRef.current
    const isExtension = written === 0 || (log.length >= written && log[written - 1] === lastLineRef.current)
    let from = written
    if (!isExtension) {
      term.reset()
      term.write('\x1b[?25l')
      from = 0
    }
    if (log.length > from) {
      term.write(log.slice(from).map(formatLogLine).join(''))
    }
    writtenRef.current = log.length
    lastLineRef.current = log.length > 0 ? log[log.length - 1] : null
  }, [log])

  // A failed build's log gets a red border + faint red wash so the terminal
  // itself reads as the error surface — the script's stderr (rendered red) is the
  // failure detail, so no separate error box is needed beside it. A build that
  // finished successfully gets the mirror-image green border + faint green wash, so
  // a settled log reads its outcome at a glance (failed > succeeded if both set).
  return (
    <div className={`relative h-64 max-h-64 rounded-md border p-2 ${
      failed
        ? 'border-red-300 dark:border-red-800/80 bg-red-50/40 dark:bg-red-950/20'
        : succeeded
        ? 'border-green-300 dark:border-green-800/80 bg-green-50/40 dark:bg-green-950/20'
        : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60'
    }`}>
      <div ref={containerRef} className="h-full w-full" />
      {log.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-start p-2 font-mono text-[11px] text-gray-400 dark:text-gray-500">
          {emptyText}
        </div>
      )}
    </div>
  )
}

// LogColumnFrame is one side's labelled column wrapper, shared by the live and
// persisted log panes so both lay out identically.
function LogColumnFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-[10px] font-semibold tracking-wide text-gray-400 dark:text-gray-500 mb-1">{label}</div>
      {children}
    </div>
  )
}

// NoLog is the placeholder for an absent side (the script was added/removed on
// the branch). Sized to match the log box so the side-by-side layout stays
// balanced when only one side has a log.
function NoLog() {
  return (
    <div className="my-2 flex items-center justify-center h-64 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 text-[11px] text-gray-400 dark:text-gray-500">
      No log
    </div>
  )
}

// SideLogPane is one side's labelled log pane for the persisted (already-fetched)
// view. A side with no URL is absent on that version → "No log" placeholder.
// Otherwise it always renders a terminal: "Loading…" while the fetch is in flight,
// the fetch error inside the box (red border) if it failed, or the lines once
// loaded — so a settled card shows two real terminals immediately rather than a
// bare "Loading log…" line. `failed` marks a side whose build itself errored;
// `succeeded` marks one that finished cleanly (green border). A fetch error counts
// as failed and overrides succeeded. The build's own failure summary (its exit
// status, "timed out after …") is appended to the captured log by the backend, so
// it reads inline as the log's final line — no separate banner needed.
function SideLogPane({ label, url, log, loading, error, failed, succeeded }: {
  label: string
  url?: string | null
  log: ArtifactLogLine[] | null
  loading: boolean
  error: string | null
  failed?: boolean
  succeeded?: boolean
}) {
  if (!url) {
    return <LogColumnFrame label={label}><NoLog /></LogColumnFrame>
  }
  const emptyText = error ? `Failed to load log: ${error}` : loading ? 'Loading…' : 'No output'
  const didFail = failed || !!error
  return (
    <LogColumnFrame label={label}>
      <LogView log={log ?? []} emptyText={emptyText} failed={didFail} succeeded={succeeded && !didFail} />
    </LogColumnFrame>
  )
}

// LiveLogColumn renders one side's log while the set is still generating. Once a
// side settles, the backend clears its live `log` (it lives only in memory while
// in-flight) and exposes the persisted log at `logUrl` — but the OTHER side may
// still be building, so the set as a whole stays "generating". Rather than revert
// the finished side to "Waiting for output…", fetch its persisted log and keep
// showing the final output until the whole set settles.
function LiveLogColumn({ label, log, logUrl }: { label: string; log: ArtifactLogLine[]; logUrl?: string | null }) {
  // This side has finished if it has no live lines left but a persisted log URL.
  const settled = log.length === 0 && !!logUrl
  const [settledLog, setSettledLog] = useState<ArtifactLogLine[] | null>(null)

  useEffect(() => {
    if (!settled || !logUrl) {
      setSettledLog(null)
      return
    }
    let cancelled = false
    fetch(logUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { lines?: ArtifactLogLine[] } | null) => {
        if (!cancelled && j) setSettledLog(j.lines ?? [])
      })
      .catch(() => { /* ignore; fall back to the loading placeholder */ })
    return () => { cancelled = true }
  }, [settled, logUrl])

  return (
    <LogColumnFrame label={label}>
      {settled ? (
        <LogView log={settledLog ?? []} emptyText="Loading…" />
      ) : (
        <LogView log={log} />
      )}
    </LogColumnFrame>
  )
}

// LiveLogPanes shows both in-flight builds side by side while the set generates,
// each side falling back to its persisted log once it finishes (see LiveLogColumn).
export function LiveLogPanes({ set }: { set: ArtifactSet }) {
  return (
    <div className="flex gap-2 my-2">
      <LiveLogColumn label="Before" log={set.left_log ?? []} logUrl={set.left_log_url} />
      <LiveLogColumn label="After" log={set.right_log ?? []} logUrl={set.right_log_url} />
    </div>
  )
}

// PersistedLogView renders a settled card's build log when open: it lazily fetches
// each side's persisted log (left_log_url / right_log_url) and shows them in the
// same side-by-side panes as the live log. The open/close toggle lives in the card
// header (the "build log" button next to refresh), so this is content-only.
export function PersistedLogView({ leftUrl, rightUrl, open, leftFailed, rightFailed, leftSucceeded, rightSucceeded }: { leftUrl?: string | null; rightUrl?: string | null; open: boolean; leftFailed?: boolean; rightFailed?: boolean; leftSucceeded?: boolean; rightSucceeded?: boolean }) {
  const [logs, setLogs] = useState<{ left: ArtifactLogLine[] | null; right: ArtifactLogLine[] | null } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Lazily fetch each side's log whenever the view is open — driven by an effect
  // (not the click handler) so a restored-open state also loads the log. The deps
  // ([open, leftUrl, rightUrl]) already make this run once per url-pair and refetch
  // when a regenerate swaps the urls; unrelated re-renders don't change them so they
  // don't re-fire it. Each run owns its own `cancelled` flag and always clears
  // `loading` in its finally, so a run superseded mid-flight — React StrictMode's
  // mount→cleanup→remount, which fires for a card whose log is open from the start
  // (a failed build) — never strands the panes on "Loading…": the latest run
  // resolves the state. (An earlier url-keyed ref guard bailed the remount out
  // before re-fetching, leaving the cancelled first run's `loading` stuck true.)
  useEffect(() => {
    if (!open || (!leftUrl && !rightUrl)) return
    let cancelled = false
    setLoading(true)
    setErr(null)
    setLogs(null)
    ;(async () => {
      try {
        // A side with no URL (absent on that version) stays null → "No log" pane.
        const fetchSide = async (u?: string | null): Promise<ArtifactLogLine[] | null> => {
          if (!u) return null // side absent or no log → "No log" pane
          const r = await fetch(u)
          if (!r.ok) return null
          const j = (await r.json()) as { lines?: ArtifactLogLine[] }
          return j.lines ?? []
        }
        const [left, right] = await Promise.all([fetchSide(leftUrl), fetchSide(rightUrl)])
        if (!cancelled) setLogs({ left, right })
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, leftUrl, rightUrl])

  if (!open || (!leftUrl && !rightUrl)) return null

  // Render the two terminals straight away — loading/error states live inside each
  // pane (as its empty text + red border) rather than replacing the panes with a
  // line of text, so the layout doesn't jump as the logs arrive.
  return (
    <div className="pt-1.5">
      <div className="flex gap-2 my-2">
        <SideLogPane label="Before" url={leftUrl} log={logs?.left ?? null} loading={loading} error={err} failed={leftFailed} succeeded={leftSucceeded} />
        <SideLogPane label="After" url={rightUrl} log={logs?.right ?? null} loading={loading} error={err} failed={rightFailed} succeeded={rightSucceeded} />
      </div>
    </div>
  )
}
