import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw, ImageOff, TriangleAlert, Camera, Copy, Check, X, ExternalLink } from 'lucide-react'
import { api } from '../stores/apiClient'
import { ApiError } from '../api'
import type { ArtifactLogLine, RepositoryArtifactFile } from '../api'
import { RepositoryArtifactResponse } from '../api'
import { formatError } from '../api/format_error'
import { canCopyImages, copyImageToClipboard } from '../lib/clipboard'
import { IMG_CLASS, checkerStyle, useMediaResize, ResizeGrip } from './artifactDiffShared'
import { isVideoArtifact } from './VideoDiffView'
import { TagBadge, LogView, ElapsedTime } from './ArtifactsPanel'
import { Tooltip } from './Tooltip'

// RepositoryArtifactsView renders one [[artifacts]] script's output for a single
// ref, single-sided (the repository browser shows one ref at a time, so there is
// no before/after diff). Generation is lazy: the backend only runs the script when
// this view first requests it; while it builds we poll and stream the live log,
// the same way the diff viewer's ArtifactsPanel does. We reuse that panel's media,
// tag and log primitives so the two viewers stay visually consistent.

const POLL_MS = 2500

// MediaActions is the hover overlay (top-right of a media thumbnail) offering a
// "copy image" and a "raw" (open in new tab) control, the same pair the
// repository file viewer shows in its header. It stops pointer-down propagation
// so clicking a button never starts the surrounding resize drag. Copy is offered
// only for images the browser can place on the clipboard (videos can't be).
function MediaActions({ url, canCopy }: { url: string; canCopy: boolean }) {
  const [state, setState] = useState<'idle' | 'ok' | 'err'>('idle')
  const onCopy = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      await copyImageToClipboard(url)
      setState('ok')
    } catch {
      setState('err')
    }
    setTimeout(() => setState('idle'), 1500)
  }

  const btn =
    'flex items-center justify-center w-6 h-6 rounded-md border border-gray-200 dark:border-gray-600 bg-white/90 dark:bg-gray-800/90 text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-700 shadow-sm backdrop-blur-sm cursor-pointer transition-colors'

  return (
    <div
      className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {canCopy && (
        <Tooltip content={state === 'ok' ? 'Copied!' : state === 'err' ? 'Copy failed' : 'Copy image'}>
          <button onClick={onCopy} className={btn}>
            {state === 'ok' ? <Check className="w-3.5 h-3.5 text-green-500" />
              : state === 'err' ? <X className="w-3.5 h-3.5 text-red-500" />
                : <Copy className="w-3.5 h-3.5" />}
          </button>
        </Tooltip>
      )}
      <Tooltip content="View raw">
        <a href={url} target="_blank" rel="noreferrer" className={btn} onClick={(e) => e.stopPropagation()}>
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </Tooltip>
    </div>
  )
}

// MediaCell shows one generated file: its name, tags, and the image (resizable,
// click-to-open) or video. Mirrors the diff viewer's FileRow, minus the
// before/after comparison machinery.
function MediaCell({ file }: { file: RepositoryArtifactFile }) {
  const { maxHeight, onResizeStart, consumeDrag } = useMediaResize()
  const url = file.url ?? undefined
  return (
    <div className="p-3 min-w-0 max-w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">{file.name}</span>
      </div>
      {(file.tags ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2 max-w-full">
          {(file.tags ?? []).map((t) => <TagBadge key={t} tag={t} />)}
        </div>
      )}
      {!url ? (
        <div className="select-none flex flex-col items-center justify-center gap-1 w-44 h-32 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-gray-400 dark:text-gray-500">
          <ImageOff className="w-5 h-5" />
          <span className="text-[11px] font-medium">No file</span>
        </div>
      ) : isVideoArtifact(file.name) ? (
        <div className="group relative inline-block">
          <video
            src={url}
            controls
            muted
            playsInline
            preload="metadata"
            className={`${IMG_CLASS} block`}
            style={{ ...checkerStyle, maxHeight: `${maxHeight}px` }}
          />
          <MediaActions url={url} canCopy={false} />
        </div>
      ) : (
        // A press-and-drag resizes (onPointerDown); a plain click opens the image in
        // a new tab, but consumeDrag() cancels that when the press became a drag.
        <div className="group relative inline-block select-none" onPointerDown={onResizeStart}>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="block"
            onClick={(e) => { if (consumeDrag()) e.preventDefault() }}
          >
            <img
              src={url}
              loading="lazy"
              draggable={false}
              style={{ ...checkerStyle, maxHeight: `${maxHeight}px` }}
              className={IMG_CLASS}
            />
          </a>
          <ResizeGrip onPointerDown={onResizeStart} />
          <MediaActions url={url} canCopy={canCopyImages()} />
        </div>
      )}
    </div>
  )
}

// PersistedLog is a "Show build log" toggle for a settled (ready/error) script: it
// lazily fetches the persisted log from log_url and renders it via the shared
// LogView. Resets when the url changes (a regenerate swaps it).
function PersistedLog({ url }: { url: string }) {
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<ArtifactLogLine[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { setLines(null); setErr(null) }, [url])
  useEffect(() => {
    if (!open || lines !== null) return
    let cancelled = false
    setLoading(true)
    setErr(null)
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { lines?: ArtifactLogLine[] }) => { if (!cancelled) setLines(j.lines ?? []) })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, url, lines])

  return (
    <div className="pt-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
      >
        {open ? 'Hide' : 'Show'} build log
      </button>
      {open && (
        loading ? (
          <div className="my-2 text-xs text-gray-400 dark:text-gray-500">Loading log…</div>
        ) : err ? (
          <div className="my-2 text-xs text-red-500 dark:text-red-400">Failed to load log: {err}</div>
        ) : (
          <div className="my-2"><LogView log={lines ?? []} emptyText="No output" /></div>
        )
      )}
    </div>
  )
}

export function RepositoryArtifactsView({
  projectId, refQuery, scriptName,
}: {
  projectId: string
  refQuery: string | undefined
  scriptName: string
}) {
  const [data, setData] = useState<RepositoryArtifactResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  // Bumped by the refresh button to force a regenerate (passes refresh=true once).
  const [reloadNonce, setReloadNonce] = useState(0)
  const wantRefresh = useRef(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const run = async (initial: boolean) => {
      if (initial) { setLoading(true); setError(null); setNotFound(false) }
      const useRefresh = wantRefresh.current
      wantRefresh.current = false
      try {
        const resp = await api.default.getRepositoryArtifact(projectId, scriptName, refQuery, useRefresh || undefined)
        if (cancelled) return
        setData(resp)
        // Keep polling while the script is still generating.
        if (resp.status === RepositoryArtifactResponse.status.GENERATING) {
          timer = setTimeout(() => run(false), POLL_MS)
        }
      } catch (err) {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) setNotFound(true)
        else setError(formatError(err))
      } finally {
        if (!cancelled && initial) setLoading(false)
      }
    }
    run(true)
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [projectId, scriptName, refQuery, reloadNonce])

  const onRefresh = () => { wantRefresh.current = true; setReloadNonce((n) => n + 1) }

  const status = data?.status
  const generating = status === RepositoryArtifactResponse.status.GENERATING

  return (
    <div className="p-3">
      {/* Status / refresh bar */}
      <div className="flex items-center gap-2 mb-3">
        <Camera className="w-4 h-4 shrink-0 text-pink-500" />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{scriptName}</span>
        {generating && (
          <span className="inline-flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
            <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
            Generating
            {data?.started_at != null && <span className="text-gray-400 dark:text-gray-500">· <ElapsedTime startedAt={data.started_at} /></span>}
          </span>
        )}
        {status === RepositoryArtifactResponse.status.READY && data && data.files.length === 0 && (
          <span className="text-xs text-gray-400 dark:text-gray-500">No files produced</span>
        )}
        <button
          onClick={onRefresh}
          disabled={loading || generating}
          title="Regenerate"
          className="ml-auto flex items-center justify-center w-7 h-7 rounded-md border text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Body */}
      {loading && !data ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <LoaderCircle className="w-5 h-5 animate-spin" />
        </div>
      ) : notFound ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-gray-400 dark:text-gray-500">
          <ImageOff className="w-8 h-8" />
          <p className="text-sm">No <span className="font-mono">{scriptName}</span> artifact script at this ref.</p>
        </div>
      ) : error ? (
        <div className="py-8 text-sm text-red-500 text-center">{error}</div>
      ) : !data ? null : data.status === RepositoryArtifactResponse.status.ERROR ? (
        <div className="space-y-2">
          <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400">
            <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <span>Generation failed</span>
          </div>
          {data.error && (
            <pre className="whitespace-pre-wrap break-words rounded-md border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 p-2 font-mono text-[11px] text-red-700 dark:text-red-300">{data.error}</pre>
          )}
          {data.log_url && <PersistedLog url={data.log_url} />}
        </div>
      ) : data.status === RepositoryArtifactResponse.status.GENERATING ? (
        <div className="space-y-2">
          {data.progress && (
            <div className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate">{data.progress}</div>
          )}
          <LogView log={data.log ?? []} />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start gap-3">
            {data.files.map((f) => <MediaCell key={f.name} file={f} />)}
          </div>
          {data.log_url && <PersistedLog url={data.log_url} />}
        </div>
      )}
    </div>
  )
}
