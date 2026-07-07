import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { ExternalLink, LoaderCircle, MonitorPlay, Play, RotateCcw, Square } from 'lucide-react'
import { api } from '../stores/apiClient'
import type { PreviewStatus } from '../api/models/PreviewStatus'
import { CollapsibleCard, MELT_BTN } from './CollapsibleCard'
import { useMeasuredHeight } from '../lib/useMeasuredHeight'
import { LogView } from './ArtifactLogView'
import { InfoTooltip } from './InfoTooltip'

// How eagerly the panel re-polls GET /previews, by the most active instance
// state it can see. There is no WebSocket for previews (deliberately - the
// interesting live feedback is on the preview port's own loading page); a
// spawning instance is polled fast enough to stream its build log here too.
function pollDelay(previews: PreviewStatus[]): number {
  if (previews.some((p) => p.state === 'starting')) return 1500
  if (previews.some((p) => p.state === 'running')) return 10000
  return 30000
}

// stateChip renders the colored dot + label for an instance state.
function StateChip({ state }: { state: PreviewStatus['state'] }) {
  const skin = {
    stopped: { dot: 'bg-gray-300 dark:bg-gray-600', text: 'text-gray-400 dark:text-gray-500', label: 'stopped' },
    starting: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-600 dark:text-amber-400', label: 'starting' },
    running: { dot: 'bg-green-500', text: 'text-green-600 dark:text-green-400', label: 'running' },
    error: { dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400', label: 'failed' },
  }[state]
  return (
    <span className={`flex items-center gap-1.5 text-[11px] ${skin.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${skin.dot}`} />
      {skin.label}
    </span>
  )
}

// PreviewPanel lists the project's live server previews ([[artifacts]] scripts
// with type = "server") for the diff viewer's selected "after" version - the
// same single-sided selection contract as the tests panel. Each row is a demo
// server Hydra spins up on demand behind a dedicated proxy port: Open starts it
// (the tab shows a live loading page while it builds) and idle instances tear
// themselves down; the row also exposes stop/restart and the captured build log.
export function PreviewPanel({ projectId, agentId, headRef, includeUncommitted, refreshKey }: {
  projectId: string
  agentId: string
  // The version to preview, mirrored from the diff viewer's right-hand selector.
  // Undefined -> the agent's branch tip. includeUncommitted previews the live
  // worktree instead of a commit.
  headRef?: string
  includeUncommitted?: boolean
  // Bumped by the diff viewer's refresh control to force a fresh fetch.
  refreshKey?: number
}) {
  // null = not yet loaded (render nothing); [] = loaded, nothing configured.
  const [previews, setPreviews] = useState<PreviewStatus[] | null>(null)
  // Bumped after start/stop actions so the poll effect re-runs immediately.
  const [nonce, setNonce] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Reset when the target (agent/version) changes so a stale list never shows.
  const connKey = `${projectId}\n${agentId}\n${headRef ?? ''}\n${includeUncommitted ? 1 : 0}`
  const [prevConnKey, setPrevConnKey] = useState(connKey)
  if (prevConnKey !== connKey) {
    setPrevConnKey(connKey)
    setPreviews(null)
  }

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const resp = await api.default.getAgentPreviews(projectId, agentId, headRef, includeUncommitted)
        if (cancelled) return
        setPreviews(resp.previews ?? [])
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(tick, pollDelay(resp.previews ?? []))
      } catch {
        if (cancelled) return
        // Transient fetch failure (daemon restarting, ...): retry lazily.
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(tick, 15000)
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [projectId, agentId, headRef, includeUncommitted, refreshKey, nonce])

  const start = useCallback(async (name: string, openTab: boolean) => {
    // Open the tab synchronously (popup blockers distrust post-await opens),
    // then point it at the preview URL the start call returns. The preview
    // port itself serves a loading page until the server is ready.
    const win = openTab ? window.open('', '_blank') : null
    try {
      const st = await api.default.startAgentPreview(projectId, agentId, name, headRef, includeUncommitted)
      if (win) {
        if (st.url) win.location = st.url
        else win.close()
      }
    } catch {
      win?.close()
    }
    setNonce((n) => n + 1)
  }, [projectId, agentId, headRef, includeUncommitted])

  const stop = useCallback(async (name: string) => {
    try {
      await api.default.stopAgentPreview(projectId, agentId, name, headRef, includeUncommitted)
    } catch { /* the poll below re-syncs state either way */ }
    setNonce((n) => n + 1)
  }, [projectId, agentId, headRef, includeUncommitted])

  // Restart = stop then start (no tab): the worktree channel re-mirrors the
  // live code and rebuilds, so a "code changed" (stale) build gets current.
  const restart = useCallback(async (name: string) => {
    try {
      await api.default.stopAgentPreview(projectId, agentId, name, headRef, includeUncommitted)
      await api.default.startAgentPreview(projectId, agentId, name, headRef, includeUncommitted)
    } catch { /* the poll below re-syncs state either way */ }
    setNonce((n) => n + 1)
  }, [projectId, agentId, headRef, includeUncommitted])

  // Panel section header height, exported as the CSS var card headers stick under.
  const [headerRef, headerH] = useMeasuredHeight(41)

  // Nothing configured (or not loaded yet) -> render nothing, like the tests
  // panel, so the diff viewer doesn't reserve space for an absent feature.
  if (!previews || previews.length === 0) return null

  const startingCount = previews.filter((p) => p.state === 'starting').length

  return (
    <div className="mb-4" style={{ '--sticky-section-h': `${headerH}px` } as CSSProperties}>
      <div
        ref={headerRef}
        style={{ top: 'calc(var(--sticky-changes-h, 45px) - 16px)' }}
        className="sticky z-20 flex flex-wrap items-center gap-2 mb-2 min-h-[1.625rem] bg-gray-50 dark:bg-gray-900 -mx-1 px-1 py-1.5 border-b border-gray-200 dark:border-gray-800 shadow-sm"
      >
        <MonitorPlay className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
        <h3 className="text-xs font-semibold tracking-wide text-gray-500 dark:text-gray-400">Previews</h3>
        {startingCount > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] font-normal text-gray-400 dark:text-gray-500">
            <LoaderCircle className="w-3 h-3 animate-spin" />
            Starting
          </span>
        )}
        <InfoTooltip title="Previews" width={520}>
          <p>Live demo servers built from the selected version - the diff viewer's <strong>after</strong> side (a commit, or your uncommitted working tree), defaulting to the branch tip.</p>
          <p>Each row is a project-defined <code className="text-blue-300">[artifacts.&lt;name&gt;]</code> script with <code className="text-blue-300">type = "server"</code> in <code className="text-blue-300">.hydra/config.toml</code>. <strong>Open</strong> spins the server up on its own port (the tab shows the build log live until it is ready) and proxies to it; with no open connections past its idle timeout it shuts down again, and revisiting the link transparently respawns it.</p>
          <p>There is one server per script, following your <strong>after</strong> selection: pointing at a different version rebuilds it in place - the URL and port never change. On <strong>Latest commit</strong> it tracks the branch tip, building the new commit in the background and hot-swapping it in when ready. On <strong>Latest changes</strong> it runs in its own checkout that mirrors your uncommitted edits; a build-then-serve preview then shows <span className="text-amber-400">code changed - restart</span> so you can rebuild.</p>
          <p>The card body shows the captured build log; a running preview keeps its port, so bookmarks within one session stay valid.</p>
        </InfoTooltip>
      </div>
      <div className="flex flex-col gap-2">
        {previews.map((p) => (
          <PreviewCard
            key={`${agentId}::${p.name}`}
            preview={p}
            onOpen={() => { void start(p.name, true) }}
            onStart={() => { void start(p.name, false) }}
            onStop={() => { void stop(p.name) }}
            onRestart={() => { void restart(p.name) }}
          />
        ))}
      </div>
    </div>
  )
}

// PreviewCard is one server row: state dot, name, version chip, Open link and
// stop/start melt icons, with the captured build log as the collapsible body.
function PreviewCard({ preview: p, onOpen, onStart, onStop, onRestart }: {
  preview: PreviewStatus
  onOpen: () => void
  onStart?: () => void
  onStop: () => void
  onRestart: () => void
}) {
  // The log body is collapsed by default; auto-expand when a spawn fails so
  // the failure is visible without hunting for the scroll icon (render-time
  // state adjust, same pattern as TestsPanel's key resets).
  const [collapsed, setCollapsed] = useState(true)
  const [prevState, setPrevState] = useState(p.state)
  if (prevState !== p.state) {
    setPrevState(p.state)
    if (p.state === 'error') setCollapsed(false)
  }

  const live = p.state === 'running' || p.state === 'starting'
  return (
    <CollapsibleCard
      icon={<MonitorPlay className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />}
      name={p.name}
      status={
        <span className="flex items-center gap-2 min-w-0">
          <StateChip state={p.state} />
          <span className="text-[11px] text-gray-400 dark:text-gray-500">{p.version}</span>
          {p.state === 'starting' && p.progress && (
            <span className="text-[11px] text-gray-400 dark:text-gray-500 truncate">{p.progress}</span>
          )}
          {p.state === 'running' && (p.connections ?? 0) > 0 && (
            <span className="text-[11px] text-gray-400 dark:text-gray-500">{p.connections} conn</span>
          )}
          {p.state === 'error' && p.message && (
            <span className="text-[11px] text-red-500 dark:text-red-400 truncate max-w-64" title={p.message}>{p.message}</span>
          )}
          {p.state === 'running' && p.stale && (
            <span className="text-[11px] text-amber-600 dark:text-amber-500" title="The code changed since this server was built. Restart to rebuild.">code changed - restart</span>
          )}
        </span>
      }
      actions={
        <span className="flex items-center gap-2">
          {live && p.stale && (
            <button
              onClick={onRestart}
              title="Restart to rebuild from the current code"
              aria-label={`Restart preview ${p.name}`}
              className={MELT_BTN}
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          {live && (
            <button
              onClick={onStop}
              title="Stop the preview server"
              aria-label={`Stop preview ${p.name}`}
              className={MELT_BTN}
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          )}
          {!live && onStart && (
            <button
              onClick={onStart}
              title="Start the server"
              aria-label={`Start preview ${p.name}`}
              className={MELT_BTN}
            >
              <Play className="w-3.5 h-3.5" />
            </button>
          )}
          {p.url && live ? (
            <a
              href={p.url}
              target="_blank"
              rel="noreferrer"
              title="Open the preview in a new tab"
              className="flex items-center gap-1 h-6 px-2 rounded-md border text-[11px] font-medium cursor-pointer transition-colors bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600"
            >
              <ExternalLink className="w-3 h-3" />
              Open
            </a>
          ) : (
            <button
              onClick={onOpen}
              title="Start the preview and open it in a new tab"
              className="flex items-center gap-1 h-6 px-2 rounded-md border text-[11px] font-medium cursor-pointer transition-colors bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600"
            >
              <ExternalLink className="w-3 h-3" />
              Open
            </button>
          )}
        </span>
      }
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed(!collapsed)}
    >
      <LogView log={p.log ?? []} failed={p.state === 'error'} succeeded={p.state === 'running'} />
    </CollapsibleCard>
  )
}
