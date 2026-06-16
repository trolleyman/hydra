import { useEffect, useRef, useState, useCallback } from 'react'
import { api } from '../stores/apiClient'
import type { ArtifactSet, ArtifactFile } from '../api'
import { LoaderCircle, Image as ImageIcon, ChevronDown, ChevronRight, TriangleAlert, RefreshCw } from 'lucide-react'
import { InfoTooltip } from './InfoTooltip'

const CHANGE_LABEL: Record<string, string> = {
  added: 'added',
  removed: 'removed',
  modified: 'modified',
  unchanged: 'unchanged',
}

const CHANGE_COLOR: Record<string, string> = {
  added: 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20',
  removed: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20',
  modified: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20',
  unchanged: 'text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-800',
}

// A subtle checkerboard so transparent screenshots read clearly in both themes.
const checkerStyle: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, rgba(0,0,0,0.06) 25%, transparent 25%), linear-gradient(-45deg, rgba(0,0,0,0.06) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(0,0,0,0.06) 75%), linear-gradient(-45deg, transparent 75%, rgba(0,0,0,0.06) 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
}

// The four ways to compare a before/after image pair. Persisted in the diff
// viewer's settings; see DiffViewer's SettingsPopup.
export type ImageDiffMode = 'side-by-side' | 'ab' | 'slider' | 'onion'

export const IMAGE_DIFF_MODES: { value: ImageDiffMode; label: string }[] = [
  { value: 'side-by-side', label: 'Side by side' },
  { value: 'ab', label: 'A/B switch' },
  { value: 'slider', label: 'Before/after slider' },
  { value: 'onion', label: 'Onion skin' },
]

const IMG_CLASS = 'max-w-full max-h-[480px] rounded-md border border-gray-200 dark:border-gray-700 object-contain'
// Shared by the overlay modes: the base image sizes the box, the overlay is
// stretched to fill that same box so the two align pixel-for-pixel.
const OVERLAY_CLASS = 'absolute inset-0 w-full h-full object-contain rounded-md border border-gray-200 dark:border-gray-700'
const TAG_CLASS = 'absolute top-1 z-10 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-black/55 text-white pointer-events-none'

function ImageCell({ url, label }: { url?: string | null; label: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">{label}</div>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="block">
          <img
            src={url}
            loading="lazy"
            style={checkerStyle}
            className={IMG_CLASS}
          />
        </a>
      ) : (
        <div className="flex items-center justify-center w-40 h-24 rounded-md border border-dashed border-gray-200 dark:border-gray-700 text-xs text-gray-400 dark:text-gray-500">
          (none)
        </div>
      )}
    </div>
  )
}

// A/B switch: both images stay mounted and stacked; clicking (or the Before/After
// buttons) flips which one is shown for an instant, flicker-free hard switch.
function ABSwitch({ left, right }: { left: string; right: string }) {
  const [showAfter, setShowAfter] = useState(true)
  const btn = (active: boolean) =>
    `text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
      active ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
    }`
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 mb-1">
        <button onClick={() => setShowAfter(false)} className={btn(!showAfter)}>Before</button>
        <button onClick={() => setShowAfter(true)} className={btn(showAfter)}>After</button>
      </div>
      <div className="relative inline-block cursor-pointer" onClick={() => setShowAfter((s) => !s)}>
        <img src={right} style={{ ...checkerStyle, visibility: showAfter ? 'visible' : 'hidden' }} className={`${IMG_CLASS} block`} draggable={false} />
        <img src={left} style={{ ...checkerStyle, visibility: showAfter ? 'hidden' : 'visible' }} className={OVERLAY_CLASS} draggable={false} />
      </div>
    </div>
  )
}

// Before/after slider: "after" is the base layer; "before" sits on top, clipped to
// the region left of the draggable handle, giving a sharp (hard-cut) boundary.
function SliderCompare({ left, right }: { left: string; right: string }) {
  const [pos, setPos] = useState(50)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const update = useCallback((clientX: number) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width === 0) return
    setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)))
  }, [])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => update(e.clientX)
    const onUp = () => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, update])

  return (
    <div
      ref={ref}
      className="relative inline-block select-none touch-none cursor-ew-resize"
      onPointerDown={(e) => { setDragging(true); update(e.clientX) }}
    >
      <span className={`${TAG_CLASS} left-1`}>Before</span>
      <span className={`${TAG_CLASS} right-1`}>After</span>
      <img src={right} style={checkerStyle} className={`${IMG_CLASS} block`} draggable={false} />
      <img
        src={left}
        style={{ ...checkerStyle, clipPath: `inset(0 ${100 - pos}% 0 0)` }}
        className={OVERLAY_CLASS}
        draggable={false}
      />
      <div className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)] pointer-events-none" style={{ left: `${pos}%` }}>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white shadow ring-1 ring-black/30" />
      </div>
    </div>
  )
}

// Onion skin: "before" is the base layer with "after" blended over it; the range
// slider controls the opacity of the "after" image (0 = before, 1 = after).
function OnionCompare({ left, right }: { left: string; right: string }) {
  const [opacity, setOpacity] = useState(50)
  return (
    <div className="min-w-0">
      <div className="relative inline-block">
        <img src={left} style={checkerStyle} className={`${IMG_CLASS} block`} draggable={false} />
        <img src={right} style={{ opacity: opacity / 100 }} className={OVERLAY_CLASS} draggable={false} />
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Before</span>
        <input
          type="range" min={0} max={100} value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          className="flex-1 accent-blue-500 cursor-pointer"
        />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">After</span>
      </div>
    </div>
  )
}

// Render a before/after image pair in the selected comparison mode. The overlay
// modes need both images, so when one side is missing (added/removed file) we fall
// back to the plain side-by-side layout regardless of the requested mode.
function ImageDiffView({ left, right, mode }: { left?: string | null; right?: string | null; mode: ImageDiffMode }) {
  if (mode === 'side-by-side' || !left || !right) {
    return (
      <div className="flex gap-3">
        <ImageCell url={left} label="Before" />
        <ImageCell url={right} label="After" />
      </div>
    )
  }
  if (mode === 'ab') return <ABSwitch left={left} right={right} />
  if (mode === 'slider') return <SliderCompare left={left} right={right} />
  return <OnionCompare left={left} right={right} />
}

function FileRow({ file, mode }: { file: ArtifactFile; mode: ImageDiffMode }) {
  const ct = file.change_type as string
  return (
    <div className="p-3 min-w-0 max-w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">{file.name}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CHANGE_COLOR[ct] ?? ''}`}>{CHANGE_LABEL[ct] ?? ct}</span>
      </div>
      <ImageDiffView left={file.left_url} right={file.right_url} mode={mode} />
    </div>
  )
}

// Lay the per-file before/after blocks out as flex-wrap items so a tall, narrow
// artifact (e.g. a phone screenshot) only claims the width it needs and several
// can share a row, while a wide desktop screenshot wraps onto its own line. Each
// file's name + before + after stays a single, unbreakable block.
function FileGrid({ files, mode }: { files: ArtifactFile[]; mode: ImageDiffMode }) {
  return (
    <div className="flex flex-wrap gap-3 pt-1">
      {files.map((f) => <FileRow key={f.name} file={f} mode={mode} />)}
    </div>
  )
}

function ArtifactSetCard({ set, mode, onRefresh }: { set: ArtifactSet; mode: ImageDiffMode; onRefresh: (name: string) => void }) {
  const status = set.status as string
  const changedFiles = set.files.filter((f) => f.change_type !== 'unchanged')
  const unchangedFiles = set.files.filter((f) => f.change_type === 'unchanged')
  const noChanges = status === 'ready' && !set.changed

  // Every state (generating / error / no-changes / changed) renders inside the
  // same bordered card so switching between them never shifts the layout (e.g.
  // hitting refresh after a failure) and the refresh button is always reachable —
  // including when there are no visual changes. Default to collapsed only for the
  // no-changes case, where there's nothing worth showing until asked; the initial
  // status is evaluated once on mount, and the card stays mounted across status
  // changes (keyed by name) so a manual regenerate keeps its expanded state.
  const [collapsed, setCollapsed] = useState(() => status === 'ready' && !set.changed)
  const [showUnchanged, setShowUnchanged] = useState(false)

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 overflow-hidden">
      <div className="flex items-stretch bg-gray-50 dark:bg-gray-800/60">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer text-left"
        >
          {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
          <ImageIcon className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400 shrink-0" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate shrink-0">{set.name}</span>
          {status === 'generating' && (
            // Live progress: the latest stdout line from the running script
            // (e.g. "wrote artifacts-ab-dark.png 7/12"), or a fallback before the
            // first line lands. min-w-0 + truncate keeps a long line from pushing
            // the refresh button off the row.
            <span className="flex items-center gap-1.5 min-w-0 text-xs text-gray-400 dark:text-gray-500">
              <LoaderCircle className="w-3 h-3 shrink-0 animate-spin" />
              <span className="truncate">{set.progress || 'generating…'}</span>
            </span>
          )}
          {status === 'error' && (
            <span className="flex items-center gap-1 text-xs text-red-500 dark:text-red-400 shrink-0">
              <TriangleAlert className="w-3 h-3" /> failed
            </span>
          )}
          {status === 'ready' &&
            (noChanges ? (
              <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">no visual changes</span>
            ) : (
              <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">{changedFiles.length} changed</span>
            ))}
        </button>
        {/* Bust the per-commit cache and regenerate — chiefly to retry a failure,
            whose error is otherwise cached until the ref changes, but always
            available (even with no visual changes) so a render can be re-run. */}
        <button
          onClick={() => onRefresh(set.name)}
          title="Regenerate this artifact"
          aria-label="Regenerate this artifact"
          className="shrink-0 px-3 flex items-center text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {!collapsed && (
        <div className="px-3 pb-2">
          {status === 'generating' && (
            <div className="my-2 font-mono text-xs text-gray-400 dark:text-gray-500 whitespace-pre-wrap break-words">
              {set.progress || 'Generating…'}
            </div>
          )}
          {status === 'error' && (
            <div className="my-2 px-3 py-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 font-mono text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">
              {set.error || 'Artifact generation failed.'}
            </div>
          )}
          {status === 'ready' &&
            (noChanges ? (
              // No visual changes: show the (unchanged) artifacts anyway when
              // expanded — useful for confirming a screenshot still renders.
              set.files.length > 0 ? (
                <FileGrid files={set.files} mode={mode} />
              ) : (
                <div className="my-2 text-xs text-gray-400 dark:text-gray-500">No artifacts produced.</div>
              )
            ) : (
              <>
                <FileGrid files={changedFiles} mode={mode} />
                {unchangedFiles.length > 0 && (
                  <div className="pt-2">
                    <button
                      onClick={() => setShowUnchanged((s) => !s)}
                      className="text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
                    >
                      {showUnchanged ? 'Hide' : 'Show'} {unchangedFiles.length} unchanged
                    </button>
                    {showUnchanged && <FileGrid files={unchangedFiles} mode={mode} />}
                  </div>
                )}
              </>
            ))}
        </div>
      )}
    </div>
  )
}

export function ArtifactsPanel({ projectId, agentId, baseRef, headRef, includeUncommitted, refreshKey, imageDiffMode }: {
  projectId: string | null
  agentId: string
  baseRef?: string
  headRef?: string
  includeUncommitted?: boolean
  refreshKey: number
  imageDiffMode: ImageDiffMode
}) {
  const [sets, setSets] = useState<ArtifactSet[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A manual refresh stashes the script name here and bumps refreshNonce, which
  // re-runs the polling effect; the first fetch of that run forwards the name to
  // the API so the backend discards the cached (possibly errored) result.
  const [refreshNonce, setRefreshNonce] = useState(0)
  const refreshScriptRef = useRef<string | null>(null)

  const fetchArtifacts = useCallback(async (refreshScript?: string): Promise<boolean> => {
    const resp = await api.default.getAgentArtifacts(projectId ?? '', agentId, baseRef, headRef, includeUncommitted, refreshScript)
    setSets(resp.scripts)
    setError(null)
    // Keep polling while anything is still generating.
    return resp.scripts.some((s) => (s.status as string) === 'generating')
  }, [projectId, agentId, baseRef, headRef, includeUncommitted])

  const requestRefresh = useCallback((name: string) => {
    refreshScriptRef.current = name
    // Optimistically flip the card to "generating" so the spinner/progress shows
    // immediately, before the (re)started poll returns.
    setSets((prev) => prev?.map((s) => (s.name === name ? { ...s, status: 'generating' as unknown as ArtifactSet['status'] } : s)) ?? prev)
    setRefreshNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    const clear = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }
    const refreshScript = refreshScriptRef.current
    refreshScriptRef.current = null

    const tick = async (first: boolean) => {
      try {
        const stillGenerating = await fetchArtifacts(first ? refreshScript ?? undefined : undefined)
        if (!cancelled && stillGenerating) {
          timerRef.current = setTimeout(() => tick(false), 2500)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    clear()
    tick(true)
    return () => { cancelled = true; clear() }
  }, [fetchArtifacts, refreshKey, refreshNonce])

  // Render nothing until we know there are configured scripts.
  if (error) {
    return (
      <div className="mb-4 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400">
        Failed to load artifacts: {error}
      </div>
    )
  }
  if (!sets || sets.length === 0) return null

  // Generation progress (#38): how many artifact scripts have settled (ready or
  // failed) versus how many are still generating. Shown only while work is in
  // flight; the poll above keeps it ticking until everything settles.
  const generatingCount = sets.filter((s) => (s.status as string) === 'generating').length
  const settledCount = sets.length - generatingCount

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <ImageIcon className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Artifacts</h3>
        {generatingCount > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] font-normal text-gray-400 dark:text-gray-500">
            <LoaderCircle className="w-3 h-3 animate-spin" />
            Generating {settledCount}/{sets.length}
          </span>
        )}
        <InfoTooltip title="Artifacts">
          <p>Artifacts are visual snapshots — typically screenshots — rendered from your code so you can see what a change <em>looks like</em>, side by side with the base branch.</p>
          <p>Each one is produced by a project-defined <strong>artifact script</strong>. Hydra checks out both the base ref and the head ref (or your uncommitted working tree), runs the script against each with <code className="text-blue-300">$HYDRA_ARTIFACT_OUTPUT</code>, <code className="text-blue-300">$HYDRA_ARTIFACT_SOURCE</code> and <code className="text-blue-300">$HYDRA_ARTIFACT_REF</code> set, and compares the images it writes. Results are cached per commit, so re-viewing a diff is free.</p>
          <p>Configure them in <code className="text-blue-300">.hydra/config.toml</code> with <code className="text-blue-300">[[artifacts]]</code> blocks (<code className="text-blue-300">name</code>, <code className="text-blue-300">command</code>, optional <code className="text-blue-300">timeout_sec</code>) — for example a script that builds the app and screenshots a page, so visual UI changes show up here in the diff viewer.</p>
          <p>A script with no visual changes collapses to a single header row; click it to expand and view the artifacts anyway. The refresh button (top-right of each card) re-runs a script — handy to retry a failure or re-render even when nothing visibly changed.</p>
        </InfoTooltip>
      </div>
      <div className="flex flex-col gap-2">
        {sets.map((s) => <ArtifactSetCard key={s.name} set={s} mode={imageDiffMode} onRefresh={requestRefresh} />)}
      </div>
    </div>
  )
}
