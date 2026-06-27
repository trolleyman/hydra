import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw, ImageOff, TriangleAlert, Camera } from 'lucide-react'
import { api } from '../stores/apiClient'
import { ApiError } from '../api'
import type { ArtifactLogLine, RepositoryArtifactFile } from '../api'
import { RepositoryArtifactResponse } from '../api'
import { formatError } from '../api/format_error'
import { IMG_CLASS, checkerStyle } from './artifactDiffShared'
import { isVideoArtifact, VIDEO_MIN_TILE_PX } from './VideoDiffView'
import { LogView, ElapsedTime, MasonryGrid, useMediaDims } from './ArtifactsPanel'
import { ArtifactFilterBar, TagBadge } from './ArtifactFilterBar'
import { computeVisibleFiles } from '../lib/artifactFilter'
import { loadTagFilter, saveTagFilter, type ArtifactTagFilter } from '../lib/artifactPrefs'
import { useArtifactSpans } from '../lib/artifactColumns'

// RepositoryArtifactsView renders one [[artifacts]] script's output for a single
// ref, single-sided (the repository browser shows one ref at a time, so there is
// no before/after diff). Generation is lazy: the backend only runs the script when
// this view first requests it; while it builds we poll and stream the live log,
// the same way the diff viewer's ArtifactsPanel does. We reuse that panel's media,
// tag and log primitives so the two viewers stay visually consistent.

const POLL_MS = 2500

// MediaCell shows one generated file: its name, tags, and the image (click-to-open)
// or video. Mirrors the diff viewer's FileRow, minus the before/after comparison
// machinery; width-driven (w-full) so it fills its masonry column.
function MediaCell({ file }: { file: RepositoryArtifactFile }) {
  const url = file.url ?? undefined
  return (
    <div className="p-3 w-full min-w-0 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">{file.name}</span>
      </div>
      {(file.tags ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2 max-w-full">
          {(file.tags ?? []).map((t) => <TagBadge key={t} tag={t} />)}
        </div>
      )}
      {!url ? (
        <div className="select-none flex flex-col items-center justify-center gap-1 w-full h-32 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-gray-400 dark:text-gray-500">
          <ImageOff className="w-5 h-5" />
          <span className="text-[11px] font-medium">No file</span>
        </div>
      ) : isVideoArtifact(file.name) ? (
        <video
          src={url}
          controls
          muted
          playsInline
          preload="metadata"
          className={`${IMG_CLASS} block`}
          style={checkerStyle}
        />
      ) : (
        // A plain click opens the image in a new tab; it fills the column width.
        <a href={url} target="_blank" rel="noreferrer" className="block">
          <img
            src={url}
            loading="lazy"
            draggable={false}
            style={checkerStyle}
            className={IMG_CLASS}
          />
        </a>
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
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { setLines(null); setErr(null) }, [url])
  useEffect(() => {
    if (!open || lines !== null) return
    let cancelled = false
    setErr(null)
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { lines?: ArtifactLogLine[] }) => { if (!cancelled) setLines(j.lines ?? []) })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)) })
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
        err ? (
          <div className="my-2 text-xs text-red-500 dark:text-red-400">Failed to load log: {err}</div>
        ) : (
          // While the log is in flight `lines` is still null — show the terminal
          // straight away with "Loading…" inside it rather than a bare line of
          // text, then swap in the output (or "No output") once it arrives.
          <div className="my-2"><LogView log={lines ?? []} emptyText={lines === null ? 'Loading…' : 'No output'} /></div>
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
  // Per-tile span overrides, shared (and persisted) with the diff viewer's
  // artifacts panel. Tiles without an override auto-span by aspect ratio.
  const { spans, setSpanOverride } = useArtifactSpans()

  // Tag/type filter + free-text search, reusing the diff viewer's filter bar and
  // rules (see ArtifactFilterBar / lib/artifactFilter). The change-type scope is
  // omitted — a single ref has no before/after diff. The persisted filter is keyed
  // per project + script (a "repo:<script>" agent slot), reloaded when either
  // changes and saved only on an explicit edit so the reload can't clobber it.
  const filterAgentKey = `repo:${scriptName}`
  const [filter, setFilter] = useState<ArtifactTagFilter>(() => loadTagFilter(projectId, filterAgentKey))
  useEffect(() => { setFilter(loadTagFilter(projectId, filterAgentKey)) }, [projectId, filterAgentKey])
  const updateFilter = useCallback((f: ArtifactTagFilter) => {
    setFilter(f)
    saveTagFilter(projectId, filterAgentKey, f)
  }, [projectId, filterAgentKey])
  // Ephemeral search (narrows + ranks without persisting), cleared when the script
  // changes since this view is reused across the repository browser's scripts.
  const [search, setSearch] = useState('')
  useEffect(() => { setSearch('') }, [projectId, scriptName])
  // Each file's aspect ratio + natural width, so the masonry can auto-span by shape
  // and cap the span to avoid upscaling a low-res shot (see MasonryGrid spanOf). The
  // server supplies width/height when it could measure them; useMediaDims only
  // downloads the rest to measure client-side.
  const dimSources = useMemo(
    () => (data?.files ?? []).map((f) => ({ key: f.name, url: f.url ?? null, video: isVideoArtifact(f.name), width: f.width, height: f.height })),
    [data?.files],
  )
  const dims = useMediaDims(dimSources)

  // The files the filter + search leave visible, ranked by search score. dims are
  // still measured over every file (keyed by name) so a re-show needs no remeasure.
  const allFiles = useMemo(() => data?.files ?? [], [data?.files])
  const visibleFiles = useMemo(() => computeVisibleFiles(allFiles, filter, search), [allFiles, filter, search])

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
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {/* The shared artifact filter bar (search + tag/type scopes). Only the
              ready state has files to filter; the change-type scope is omitted as a
              single ref has no before/after diff. */}
          {status === RepositoryArtifactResponse.status.READY && allFiles.length > 0 && (
            <ArtifactFilterBar
              files={allFiles}
              filter={filter}
              onFilterChange={updateFilter}
              search={search}
              onSearchChange={setSearch}
            />
          )}
          <button
            onClick={onRefresh}
            disabled={loading || generating}
            title="Regenerate"
            className="flex items-center justify-center w-7 h-7 rounded-md border text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />
          </button>
        </div>
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
          {/* The filter/search may hide every file; show why rather than a blank
              grid (the "no files produced" case is handled in the status bar). */}
          {data.files.length > 0 && visibleFiles.length === 0 ? (
            <div className="py-8 text-xs text-center text-gray-400 dark:text-gray-500">
              No files match {search.trim() ? 'your search' : 'the current filters'}.
            </div>
          ) : (
            <MasonryGrid
              items={visibleFiles.map((f) => ({
                key: f.name,
                node: <MediaCell file={f} />,
                aspect: dims[f.name]?.aspect,
                pxWidth: dims[f.name]?.pxWidth,
                // Videos need a minimum tile width for their transport controls.
                minWidthPx: isVideoArtifact(f.name) ? VIDEO_MIN_TILE_PX : undefined,
                // Video uses horizontal drag for scrubbing, so it resizes via the edge
                // handle only; images are draggable anywhere (see MasonryGrid).
                bodyResizable: !isVideoArtifact(f.name),
              }))}
              spans={spans}
              onSpanChange={setSpanOverride}
              scope={`${projectId}/repo/${scriptName}`}
            />
          )}
          {data.log_url && <PersistedLog url={data.log_url} />}
        </div>
      )}
    </div>
  )
}
