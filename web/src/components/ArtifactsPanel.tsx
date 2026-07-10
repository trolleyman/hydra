import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../stores/apiClient'
import { apiErrorBody, formatError } from '../api/format_error'
import { PanelError } from './PanelError'
import type { ArtifactSet, ArtifactFile, ArtifactLogLine } from '../api'
import { ArtifactFile as ArtifactFileNS } from '../api'
import { LoaderCircle, Image as ImageIcon, ChevronDown, TriangleAlert, RefreshCw, ScrollText, SquarePlus, SquareMinus, SquareDot, Download, FileArchive } from 'lucide-react'
import { InfoTooltip } from './InfoTooltip'
import { SettingsPopover, SettingsGroupLabel, SettingsOptionRow } from './SettingsPopover'
import { CollapsibleCard, MELT_BTN } from './CollapsibleCard'
import { useMeasuredHeight } from '../lib/useMeasuredHeight'
import { useMediaDims } from '../lib/artifactDims'
import { loadArtifactPrefs, saveArtifactPrefs, loadTagFilter, saveTagFilter, loadArtifactChrome, saveArtifactChrome, clampChangeThreshold, type ArtifactTagFilter, type ArtifactChrome } from '../lib/artifactPrefs'
import { computeVisibleFiles, filterIsActive, effectiveChangeType, isVideoArtifact, isDownloadArtifact } from '../lib/artifactFilter'
import { formatBytes } from '../lib/formatBytes'
import { ArtifactFilterBar, TagBadge } from './ArtifactFilterBar'
import { stripAnsi } from '../lib/ansi'
import { useLogCoalescer } from '../lib/useLogCoalescer'
import { closeWebSocket } from '../lib/ws'
import { type ArtifactSpans, BASE_ARTIFACT_COLUMNS, defaultSpanForAspect } from '../lib/artifactColumns'
import { VideoDiffView, VIDEO_MIN_TILE_PX } from './VideoDiffView'
import { ImageDiffView, SegmentedToggle, type ImageDiffMode, type ArtifactABControls } from './ArtifactImageDiff'
import { ABControlsContext, IMAGE_DIFF_MODES } from './artifactDiffContext'
import type { LightboxImage } from './ImageLightbox'
import { useImageLightboxStore } from '../stores/imageLightboxStore'
import { applyABShortcut } from '../lib/abShortcuts'
import { LiveLogPanes, PersistedLogView } from './ArtifactLogView'

const CHANGE_LABEL: Record<string, string> = {
  added: 'added',
  removed: 'removed',
  modified: 'modified',
  unchanged: 'unchanged',
}

// ArtifactChangeIcon marks a file's change type next to its name, mirroring the diff
// viewer's file-list icons: green [+] added, red [-] removed, amber [•] modified.
// Unchanged files (revealed only via the changes filter) get no icon.
function ArtifactChangeIcon({ type, className = 'w-3.5 h-3.5' }: { type: string; className?: string }) {
  const cls = `${className} shrink-0`
  switch (type) {
    case 'added':
      return <SquarePlus className={`${cls} text-green-600 dark:text-green-400`} />
    case 'removed':
      return <SquareMinus className={`${cls} text-red-600 dark:text-red-400`} />
    case 'modified':
      return <SquareDot className={`${cls} text-amber-600 dark:text-amber-400`} />
    default:
      return null
  }
}

// partialFailedSide reports which single side of a set failed while the other
// rendered (a partial failure). A whole-set "error" (both sides failed) returns
// null - there's no surviving side to reconcile. Mirrors the backend: status
// stays "ready"/"generating" with just one side's error set.
function partialFailedSide(set: ArtifactSet): 'left' | 'right' | null {
  if ((set.status as string) === 'error') return null
  return set.left_error ? 'left' : set.right_error ? 'right' : null
}

// presentedFiles is a set's files as the panel actually shows them. A partial
// failure has no real diff - the surviving side's files would each read as
// added/removed against an absent counterpart - so they're presented as unchanged,
// hidden by the change filter's default. Both the per-card grid (cardFiles) and the
// panel-wide filter counts run through this, so the "changes" dropdown's per-type
// counts agree with the card body (no "538 added" while the card says "unchanged").
function presentedFiles(set: ArtifactSet): ArtifactFile[] {
  return partialFailedSide(set)
    ? set.files.map((f) => ({ ...f, change_type: ArtifactFileNS.change_type.UNCHANGED }))
    : set.files
}

// Masonry layout constants. The grid always works in BASE_ARTIFACT_COLUMNS columns
// (shared with the repository artifacts view, see lib/artifactColumns), but renders
// fewer when the container is too narrow to keep each base column at least
// BASE_MIN_COL_PX wide. MASONRY_GAP is the inter-column gutter.
const BASE_MIN_COL_PX = 140
const MASONRY_GAP = 12
// Assumed tile height before a tile has been measured.
const MASONRY_FALLBACK_H = 240

// Tile reflow animation. An easeOutBack curve (the >1 control point) overshoots
// slightly before settling - the gentle "boing" when a tile snaps to its new column
// span, and the cue that tiles can be moved as siblings ease out of the way. Width
// settles a touch slower than position so the snap reads as deliberate, not abrupt.
// Suppressed on the tile being actively dragged (it tracks the pointer 1:1) and for
// the first beat after mount (so the initial bulk layout doesn't animate in).
const TILE_EASE = 'cubic-bezier(0.34, 1.56, 0.64, 1)'
const TILE_TRANSITION = `left 220ms ${TILE_EASE}, top 220ms ${TILE_EASE}, width 280ms ${TILE_EASE}`

// Resize "stickiness": the extra fraction of a column you must drag past the halfway
// point before a tile's SPAN commits to the next/previous column. It's a hysteresis
// deadband centred on each column boundary so the siblings don't flip-flop between
// two packings as the pointer jitters near a boundary. It only gates when the
// neighbours reflow - the dragged tile itself tracks the pointer 1:1 regardless.
// 0.3 ≈ a third of a column of slack on each side.
const RESIZE_STICK = 0.3

// mediaAspect returns a file's aspect ratio (width / height) from the artifact
// metadata, or undefined when the server didn't record dimensions. Passed to the
// differ to reserve the media box height via CSS aspect-ratio, so a tile lays out
// at its final size before the image downloads (no reflow on load). dpi cancels
// out of a ratio, so it isn't needed here.
function mediaAspect(file: ArtifactFile): number | undefined {
  return file.width && file.height ? file.width / file.height : undefined
}

function FileRow({ file, mode, changeThreshold = 0, gallery, index }: {
  file: ArtifactFile; mode: ImageDiffMode; changeThreshold?: number
  // The grid's diff gallery + this file's index in it, so opening an image lets ←/→
  // walk the files and the lightbox shows the comparison (see ImageDiffView). Images only.
  gallery?: LightboxImage[]; index?: number
}) {
  // The badge reflects the *effective* change type, so a modified file gated below
  // the "% changed" threshold shows as unchanged (no badge) - matching how it's
  // filtered and counted.
  const ct = effectiveChangeType(file, changeThreshold)
  return (
    // w-full: the masonry wrapper sets the tile's (column) width; the card fills it.
    <div className="p-3 w-full min-w-0 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
      {/* nowrap so the change icon stays on the filename's line: the name truncates
          with an ellipsis when space is tight rather than bumping the icon down. */}
      <div className="flex items-center gap-1.5 mb-2 min-w-0">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate min-w-0">{file.name}</span>
        {ct !== 'unchanged' && (
          <span title={CHANGE_LABEL[ct] ?? ct} className="inline-flex shrink-0">
            <ArtifactChangeIcon type={ct} />
          </span>
        )}
        {file.unverified && (
          <span
            className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20"
            title="Compared by byte hash only - install ffmpeg for frame-accurate video diffs. This “modified” result may be spurious (e.g. only container metadata changed)."
          >
            <TriangleAlert className="w-3 h-3" />
            byte-compared
          </span>
        )}
      </div>
      {(file.tags ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2 max-w-full">
          {(file.tags ?? []).map((t) => <TagBadge key={t} tag={t} />)}
        </div>
      )}
      {/* data-tile-drag marks the resize surface: only a horizontal drag that starts
          here grows the tile (see MasonryGrid.startBodyResize), so dragging on the
          header above just selects the file name. */}
      <div data-tile-drag>
        {isDownloadArtifact(file.name) ? (
          <DownloadTile file={file} />
        ) : isVideoArtifact(file.name) ? (
          <VideoDiffView left={file.left_url} right={file.right_url} mode={mode} fps={file.fps} aspect={mediaAspect(file)} />
        ) : (
          <ImageDiffView left={file.left_url} right={file.right_url} mode={mode} name={file.name} aspect={mediaAspect(file)} gallery={gallery} index={index} />
        )}
      </div>
    </div>
  )
}

// DownloadTile renders a download-class artifact (an .apk, a .zip - see
// isDownloadArtifact): no media to show, so it's an icon, the byte size, and a
// save link per side. The blob endpoint serves these with
// Content-Disposition: attachment, so a click downloads rather than renders.
function DownloadTile({ file }: { file: ArtifactFile }) {
  const sides = [
    { label: 'before', url: file.left_url },
    { label: 'after', url: file.right_url },
  ].filter((s): s is { label: string; url: string } => !!s.url)
  return (
    <div className="flex items-center gap-3 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2.5">
      <FileArchive className="w-6 h-6 shrink-0 text-gray-400 dark:text-gray-500" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-gray-400 dark:text-gray-500">
          {file.size != null ? formatBytes(file.size) : 'download'}
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          {sides.map((side) => (
            <a
              key={side.label}
              href={side.url}
              download
              title={`Download the ${side.label} version`}
              className="flex items-center gap-1 h-6 px-2 rounded-md border text-[11px] font-medium cursor-pointer transition-colors bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600"
            >
              <Download className="w-3 h-3" />
              {side.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}

// An artifact's measured intrinsic dimensions: its aspect ratio (width / height)
// drives the default column span, and its natural pixel width lets the grid avoid
// upscaling a low-resolution shot past 1:1 on a high-DPI/large screen (see spanOf).
// dpi is the media's capture density (device-scale factor); pxWidth / dpi is its
// logical width, which is what the grid caps a tile to (see spanOf). 1 when unknown
// (measured client-side, or a server entry without a dpi sidecar) - logical == physical.
// Balanced (shortest-column) masonry. Each tile is absolutely positioned: we
// measure every tile's rendered height with a ResizeObserver, then place tiles one
// by one into whichever run of columns is currently shortest - so they pack tightly
// with minimal trailing gap while keeping a rough left-to-right, top-to-bottom
// reading order (unlike CSS columns, which fill one column top-to-bottom first).
//
// Everything is WIDTH-driven: a tile's width is its (equal-width) column run, and
// the media inside fills that width with its height following the aspect ratio. The
// grid always works in BASE_ARTIFACT_COLUMNS columns (fewer only when the container
// is too narrow). Each tile's span comes from its `aspect` via defaultSpanForAspect
// (scaled by `spanScale` - 2 for side-by-side, whose before/after pair needs the
// room), unless the user has dragged its edge to set an explicit span in `spans`.
export function MasonryGrid({ items, spanScale = 1, scale = 1, spans, onSpanChange, scope }: {
  // bodyResizable defaults to true; set false for tiles whose media owns horizontal
  // drag (the before/after slider, video scrubbing) - those resize via the edge
  // handle only, so the two gestures don't fight.
  items: { key: string; node: React.ReactNode; aspect?: number; pxWidth?: number; dpi?: number; minWidthPx?: number; bodyResizable?: boolean }[]
  spanScale?: number
  // User's global size multiplier (diff settings size slider): scales every tile's
  // auto span up/down. 1 = the aspect-ratio default. Explicit drag overrides ignore it.
  scale?: number
  spans: ArtifactSpans
  onSpanChange?: (key: string, span: number | null) => void
  // Namespace for persisted span overrides: an item's identity key (its file name,
  // used for React/layout identity) is unique only within this grid, but the spans
  // map is shared across every agent/set/view, so it's prefixed with `scope` before
  // lookup/write. Omitted → the bare file name is the persistence key (legacy/global).
  // See spanKey; callers pass e.g. `${agentId}/${setName}` so a resize stays local.
  scope?: string
}) {
  // Persisted-override key for a tile: prefix its file name with `scope`, joined by
  // a NUL - which can't appear in a file name, agent id or set name, so the
  // composite never collides with a different (scope, name) pair even when either
  // contains slashes or spaces. No scope → the bare file name (legacy global key).
  const spanKey = useCallback((itemKey: string) => (scope ? `${scope}\0${itemKey}` : itemKey), [scope])
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  // Measured tile heights, keyed by item key. Updated by the ResizeObserver below.
  const [heights, setHeights] = useState<Record<string, number>>({})
  // The tile currently being edge/body-dragged. `width` is the width the tile
  // renders at - the pointer-tracked width, glued 1:1 to the cursor (the tile's own
  // transition is suppressed for the drag, see the tile style). `snapW` is the
  // snapped span width - what the tile will settle to on release - which is what the
  // ghost measures at (see below). The column span is committed live as the width
  // crosses a column boundary (with stickiness), and the siblings reflow at each
  // snap - see startResize.
  // `col` is the column the dragged tile started in: the live span commits below
  // would otherwise let the masonry packer re-home the dragged tile to a different
  // start column the moment it snaps wider, making it jump out from under the pointer.
  // Pinning it to its start column (see placement) keeps it anchored - it grows
  // rightward from a fixed left edge while the siblings reflow around it.
  const [drag, setDrag] = useState<{ key: string; width: number; snapW: number; col: number } | null>(null)
  // The exact height the dragged tile will occupy at its current (snapped) width,
  // measured off an invisible "ghost" copy rendered at that width with no transition
  // (see the ghost render + layout effect below). The visible tile's measured height
  // is frozen during the drag to avoid the columns beneath jittering as its width
  // TRANSITION animates; the ghost gives placement the real settled height instead -
  // accounting for label wrapping and other chrome that a formula can't - so the
  // tiles below reserve the right space and reflow around it at each snap.
  const [ghostH, setGhostH] = useState<number | null>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  // The key of the tile currently being resized, read by the ResizeObserver below to
  // freeze that tile's measured height for the duration of the drag. A tile grows
  // taller as it widens (its media is w-full with a fixed aspect ratio), and letting
  // that live height feed back into placement would shove the tiles beneath it around
  // continuously as you drag. Holding the height constant means siblings only move
  // when the span actually snaps to a new column count - not while the pointer moves.
  const resizeKeyRef = useRef<string | null>(null)
  // Gate the reflow transition off for the first beat so the initial bulk layout (and
  // its first height-measure pass) snaps into place rather than animating in.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setReady(true), 200)
    return () => clearTimeout(id)
  }, [])

  // One ResizeObserver for every tile, created lazily the first time a tile ref
  // attaches (in the commit phase, not during render). Tiles tag themselves with
  // data-mkey so the callback knows which tile's height changed.
  const roRef = useRef<ResizeObserver | null>(null)
  const ensureRO = () => {
    if (!roRef.current && typeof ResizeObserver !== 'undefined') {
      roRef.current = new ResizeObserver((entries) => {
        setHeights((prev) => {
          let next = prev
          for (const e of entries) {
            const el = e.target as HTMLElement
            const key = el.dataset.mkey
            if (!key) continue
            // Skip the tile that's actively being resized: its width (and so its
            // height) is changing continuously under the pointer, and folding that
            // live height back into the layout would jitter every tile beneath it.
            // It re-measures naturally once the drag ends (resizeKeyRef cleared).
            if (key === resizeKeyRef.current) continue
            const h = el.offsetHeight
            if (next[key] !== h) {
              if (next === prev) next = { ...prev }
              next[key] = h
            }
          }
          return next
        })
      })
    }
    return roRef.current
  }
  useEffect(() => () => roRef.current?.disconnect(), [])

  // Track the container's available width (clientWidth is the column space even
  // while the absolutely-positioned tiles give it ~0 content height).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // A single stable ref callback for every tile: observe on attach, and (via the
  // returned React 19 cleanup) unobserve on detach. The tile carries its key as a
  // data-mkey attribute so the observer callback knows which height changed - no
  // per-key closure, so nothing reads a ref during render.
  const observeTile = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const ro = ensureRO()
    ro?.observe(el)
    return () => ro?.unobserve(el)
  }, [])

  // Resolve the rendered column count and the (equal) width of one base column. We
  // render BASE_ARTIFACT_COLUMNS columns, dropping to fewer only when the container
  // is too narrow to keep each base column at least BASE_MIN_COL_PX wide.
  const layout = useMemo(() => {
    const gap = MASONRY_GAP
    const w = width || 0
    const fit = w > 0 ? Math.max(1, Math.floor((w + gap) / (BASE_MIN_COL_PX + gap))) : BASE_ARTIFACT_COLUMNS
    const cols = Math.max(1, Math.min(BASE_ARTIFACT_COLUMNS, fit))
    const contentW = Math.max(0, w - gap * (cols - 1))
    const colW = cols > 0 ? contentW / cols : 0
    return { cols, gap, colW }
  }, [width])

  // Resolve a tile's span: an explicit override (from dragging) wins, otherwise the
  // aspect-ratio default scaled for side-by-side, then capped to the media's logical
  // width so we never lay it out wider than it "is". Clamped to the rendered columns.
  //
  // The cap reasons in LOGICAL pixels, not physical ones: what matters for a UI
  // screenshot is its logical size (a 390pt phone shot is a phone whether captured at
  // 1x or 2x), so we cap the auto span to the widest run that stays within the media's
  // logical width = natural px ÷ its capture dpi (the device-scale factor from its
  // sidecar; 1 when unknown). This keeps a consistent default regardless of how
  // densely the shot was captured or what display you're viewing on - a 2x capture
  // lays out the same as a 1x one, just sharper. In side-by-side the run holds the
  // before+after pair so each image only gets ~half of it, hence the spanScale budget.
  // The `scale` multiplier (size slider) loosens the cap so turning the slider up
  // enlarges past logical size deliberately. Explicit drag overrides bypass it entirely.
  const spanOf = useCallback((it: { key: string; aspect?: number; pxWidth?: number; dpi?: number; minWidthPx?: number }): number => {
    let req = spans[spanKey(it.key)]
    if (req == null) {
      req = defaultSpanForAspect(it.aspect) * spanScale * scale
      const unit = layout.colW + layout.gap
      if (it.pxWidth && layout.colW > 0) {
        const dpi = it.dpi && it.dpi > 0 ? it.dpi : 1
        // The media's logical width, then scaled by the size-slider `scale` (turning it
        // up opts into enlarging past logical size).
        const budgetCss = (it.pxWidth / dpi) * spanScale * scale
        // tileW(s) = s*colW + (s-1)*gap ≤ budgetCss  ⇒  s ≤ (budgetCss + gap)/(colW + gap)
        const maxSpan = Math.max(1, Math.floor((budgetCss + layout.gap) / unit))
        req = Math.min(req, maxSpan)
      }
      // Floor for media whose chrome needs a minimum width - a video's transport
      // controls. The resolution cap above can shrink a small clip below its control
      // bar, so ensure the tile spans enough columns to fit minWidthPx; this wins
      // over the cap (a slightly-upscaled clip beats unusable controls).
      if (it.minWidthPx && layout.colW > 0) {
        // tileW(s) ≥ minWidthPx  ⇒  s ≥ (minWidthPx + gap)/(colW + gap)
        const minSpan = Math.ceil((it.minWidthPx + layout.gap) / unit)
        req = Math.max(req, minSpan)
      }
    }
    return Math.max(1, Math.min(Math.round(req), layout.cols))
  }, [spans, spanScale, scale, layout.cols, layout.colW, layout.gap, spanKey])

  // Place each tile into the run of `span` columns whose tallest column is currently
  // shortest (ties resolve leftmost, preserving reading order). Each tile fills its
  // run's combined width; its height comes from the measured content.
  // Only drag.key/drag.col drive the layout (see below), so read them into locals:
  // the memo then closes over exactly its deps, not the whole `drag` object.
  const dragKey = drag?.key
  const dragCol = drag?.col
  const placement = useMemo(() => {
    const { cols, gap, colW } = layout
    const FALLBACK_H = MASONRY_FALLBACK_H // assumed height before a tile is first measured
    const bottoms = new Array(cols).fill(0)
    const pos: Record<string, { left: number; top: number; width: number; span: number }> = {}
    for (const it of items) {
      const h = heights[it.key] ?? FALLBACK_H
      const s = spanOf(it)
      let bestC = 0
      if (dragKey === it.key) {
        // The tile being dragged is pinned to its start column (clamped so a wider
        // span can't run off the right edge) rather than re-packed, so a live span
        // snap grows it in place instead of teleporting it under the pointer. Its top
        // still comes from the columns it now covers, which is stable since the tiles
        // placed before it are unaffected.
        bestC = Math.max(0, Math.min(dragCol ?? 0, cols - s))
        let top = 0
        for (let k = bestC; k < bestC + s; k++) top = Math.max(top, bottoms[k])
        const left = bestC * (colW + gap)
        const tileW = s * colW + (s - 1) * gap
        pos[it.key] = { left, top, width: tileW, span: s }
        // The tile's own measured height is frozen during the drag, so reserve the
        // exact height measured off the invisible ghost (rendered at this same snapped
        // width, no transition) - that's what the tile will actually settle to, chrome
        // and label wrapping included. Falls back to the frozen height until the ghost
        // has measured (a pre-paint layout effect, so no visible under-reserve).
        const dh = ghostH ?? h
        for (let k = bestC; k < bestC + s; k++) bottoms[k] = top + dh + gap
        continue
      }
      // Best start column: minimise the tallest of the columns this tile would cover.
      let bestTop = Infinity
      for (let c = 0; c + s <= cols; c++) {
        let top = 0
        for (let k = c; k < c + s; k++) top = Math.max(top, bottoms[k])
        if (top < bestTop) { bestTop = top; bestC = c }
      }
      if (!Number.isFinite(bestTop)) bestTop = 0
      const left = bestC * (colW + gap)
      const tileW = s * colW + (s - 1) * gap
      pos[it.key] = { left, top: bestTop, width: tileW, span: s }
      for (let k = bestC; k < bestC + s; k++) bottoms[k] = bestTop + h + gap
    }
    const height = bottoms.length ? Math.max(...bottoms) - gap : 0
    return { pos, height: Math.max(0, height) }
    // drag.key/drag.col (not the whole drag object) so a width-only change while
    // dragging doesn't re-pack the grid - only a start/end or a span snap does. ghostH
    // feeds the dragged tile's reserved height (it changes only when the span snaps).
  }, [items, heights, layout, spanOf, dragKey, dragCol, ghostH])

  // Set while a body drag (below) is resizing a tile, so the trailing click can be
  // swallowed before the media reacts to it. Holds the key of the tile being dragged.
  const draggedKeyRef = useRef<string | null>(null)

  // Start a live resize from `startSpan`, anchored at pointer `startX`. The dragged
  // tile itself tracks the pointer 1:1 (its width transition is suppressed for the
  // drag), so the resize feels direct - no trailing animation, no rubber-band. The
  // column SPAN is quantised with stickiness (see RESIZE_STICK) and committed the
  // instant it crosses a boundary - live, as you drag, not deferred to release - so
  // the siblings reflow (animated) at each snap while nothing rearranges between
  // them (the dragged tile's height is frozen too; see resizeKeyRef). A snap-preview
  // outline (see the render) shows the column box the tile will settle into,
  // flipping a column at a time with the eased tile transition; on release the tile
  // eases from the pointer width into that box. Returns move/finish, or null if the
  // grid can't resize right now. `key` is the tile's file name; the override
  // persists under its scoped key (see spanKey).
  const startResize = (key: string, startSpan: number, startX: number) => {
    const unit = layout.colW + layout.gap
    if (unit <= 0 || !onSpanChange) return null
    const startWidth = startSpan * layout.colW + (startSpan - 1) * layout.gap
    const minW = layout.colW
    const maxW = layout.cols * layout.colW + (layout.cols - 1) * layout.gap
    // Freeze this tile's measured height for the drag's duration so its siblings hold
    // still as it widens - they reflow off the ghost measurement instead (see ghostH).
    resizeKeyRef.current = key
    // The column the tile currently sits in, so placement can pin it there (a snap to
    // a wider span must not let the packer relocate it under the pointer).
    const startCol = unit > 0 ? Math.round((placement.pos[key]?.left ?? 0) / unit) : 0
    let liveSpan = startSpan
    const move = (clientX: number) => {
      const w = Math.max(minW, Math.min(maxW, startWidth + (clientX - startX)))
      // Quantise the live width to a column span with hysteresis: hold `liveSpan`
      // until the pointer is dragged clearly past the midpoint toward the next or
      // previous column (a RESIZE_STICK-wide deadband around each boundary), so a
      // tile resting near a column edge doesn't flip-flop. A fast drag that overshoots
      // a whole column still jumps straight there - the deadband only catches the ±1
      // neighbour right at the boundary.
      const spanFloat = (w + layout.gap) / unit
      let target = Math.round(spanFloat)
      if (target > liveSpan && spanFloat < liveSpan + 0.5 + RESIZE_STICK) target = liveSpan
      else if (target < liveSpan && spanFloat > liveSpan - 0.5 - RESIZE_STICK) target = liveSpan
      target = Math.max(1, Math.min(layout.cols, target))
      if (target !== liveSpan) {
        // Snap: commit the new span now so the grid rearranges into the new column
        // layout the moment the tile reaches it.
        liveSpan = target
        onSpanChange(spanKey(key), liveSpan)
      }
      // Render the tile at the raw pointer width - glued 1:1 to the cursor. snapW
      // (the quantised span width) is kept alongside for the measurement ghost,
      // and is what the tile settles to on release.
      const snapW = liveSpan * layout.colW + (liveSpan - 1) * layout.gap
      setDrag({ key, width: w, snapW, col: startCol })
    }
    const finish = () => {
      resizeKeyRef.current = null
      // Adopt the ghost's settled height as this tile's measured height. The tile's
      // own ResizeObserver readings were frozen for the whole drag, and if its width
      // transition finished before the pointer was released there is no further size
      // change to re-trigger the observer - the stale pre-drag height would stick,
      // leaving a permanent gap below a shrunk tile (or an overlap for a grown one).
      // A transition still running at release re-measures via the observer as usual.
      const settled = ghostRef.current?.offsetHeight
      if (settled) setHeights((prev) => (prev[key] === settled ? prev : { ...prev, [key]: settled }))
      setDrag(null)
      // The span was already committed at the last snap; this just ensures the final
      // value is persisted (a no-op if unchanged - onSpanChange dedupes).
      onSpanChange(spanKey(key), liveSpan)
    }
    return { move, finish }
  }

  // Edge-handle resize: drag the thin handle in the right gutter to grow/shrink the
  // tile. stopPropagation so it doesn't also trigger the body drag below; double-click
  // clears the override (back to the aspect-ratio default).
  const startEdgeResize = (key: string, startSpan: number) => (e: React.PointerEvent) => {
    if (e.button !== 0 || !onSpanChange) return
    e.preventDefault()
    e.stopPropagation()
    const ctl = startResize(key, startSpan, e.clientX)
    if (!ctl) return
    // Only this drag's own pointer drives it (a second finger elsewhere must not
    // steer this tile's width).
    const id = e.pointerId
    const onMove = (ev: PointerEvent) => { if (ev.pointerId === id) ctl.move(ev.clientX) }
    // pointercancel too: if the browser takes the pointer away mid-drag (touch
    // scroll takeover, window losing the device) the drag must still end - without
    // it the listeners leak and the tile stays wedged in its dragging state.
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      ctl.finish()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Body resize: drag horizontally on a tile's media (the region the node marks with
  // data-tile-drag) to grow or shrink its span. Starting on the card chrome - the file
  // name, badges, padding - does nothing, so click-dragging to select the name no
  // longer enlarges the tile. A plain click/tap on the media falls through to its own
  // gesture (flip, open) - we only take over once the pointer moves decisively
  // horizontally past a small threshold, then swallow the trailing click so the media
  // doesn't also react. Touch keeps vertical panning (touch-action: pan-y) so the page
  // scrolls.
  const startBodyResize = (key: string, startSpan: number) => (e: React.PointerEvent) => {
    if (e.button !== 0 || !onSpanChange) return
    // Only the media drags; the card header/padding is left alone (text-selectable).
    if (!(e.target instanceof Element) || !e.target.closest('[data-tile-drag]')) return
    // ...but never hijack an interactive control that owns its own horizontal drag - the
    // onion-skin opacity slider (an <input type="range">) lives inside the media region,
    // and dragging it must move the slider, not resize the tile. `data-no-tile-drag` is
    // the general escape hatch for any such control.
    if (e.target.closest('input, [data-no-tile-drag]')) return
    draggedKeyRef.current = null // reset any stale value from a drag that produced no click
    const startX = e.clientX
    const startY = e.clientY
    const id = e.pointerId // only this drag's own pointer drives it (multi-touch)
    let ctl: ReturnType<typeof startResize> = null
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      const dx = ev.clientX - startX
      if (!ctl) {
        // Require a decisive horizontal move so taps and vertical scrolls pass through.
        if (Math.abs(dx) < 6 || Math.abs(dx) <= Math.abs(ev.clientY - startY)) return
        // Anchor the live width to the gesture origin so the tile grows by the full
        // drag distance (not just from the activation point).
        ctl = startResize(key, startSpan, startX)
        if (!ctl) return
        draggedKeyRef.current = key
      }
      ev.preventDefault()
      ctl.move(ev.clientX)
    }
    // pointercancel too (see startEdgeResize): a vertical touch drag starts here,
    // pans the page (touch-action: pan-y) and CANCELS the pointer - pointerup never
    // fires, so without this the listeners leaked on every scroll over a tile.
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      ctl?.finish()
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // After a body drag, eat the click it would otherwise turn into (capture phase, so
  // it never reaches the media's own onClick / link navigation).
  const swallowDragClick = (key: string) => (e: React.MouseEvent) => {
    if (draggedKeyRef.current !== key) return
    e.preventDefault()
    e.stopPropagation()
    draggedKeyRef.current = null
  }

  // Measure the ghost before paint so the columns beneath reserve the dragged tile's
  // real settled height. Keyed on drag.snapW - NOT the rubber-band render width, which
  // changes every pointermove - so it re-measures only when the span snaps to a new
  // width (the ghost has no transition, so its height is the target height immediately
  // - not an intermediate animation frame). Cleared when the drag ends (setGhostH(null)
  // is a bail-out no-op if it was already null).
  useLayoutEffect(() => {
    if (!drag) { setGhostH(null); return }
    const el = ghostRef.current
    if (el) setGhostH(el.offsetHeight)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.key, drag?.snapW])

  const draggedItem = drag ? items.find((i) => i.key === drag.key) : undefined
  const canResize = !!onSpanChange && layout.cols > 1
  return (
    <div ref={containerRef} className="relative w-full" style={{ height: placement.height }}>
      {/* Invisible ghost of the tile being dragged, rendered at its current snapped
          width with NO transition, purely to measure the exact height it will settle
          to (chrome + wrapped labels included). Absolutely positioned and hidden via
          opacity - `invisible` (visibility: hidden) alone is NOT enough, because the
          flip view's layers set an explicit `visibility: visible` on themselves
          (children can override an inherited hidden), which made the ghost's image
          paint at the grid's top-left and flash during the drag. opacity has no such
          escape hatch: it composites the whole subtree away. It doesn't affect the
          container height either (that's placement.height, set explicitly). */}
      {drag && draggedItem && (
        <div
          ref={ghostRef}
          aria-hidden
          data-masonry-ghost
          className="absolute invisible pointer-events-none"
          style={{ left: 0, top: 0, width: drag.snapW, opacity: 0 }}
        >
          {draggedItem.node}
        </div>
      )}
      {/* Snap preview: the dragged tile tracks the pointer 1:1, so this outline
          shows the column box it will SETTLE into on release - the tile's pinned
          left/top, the snapped span width, and the ghost-measured settled height
          (the exact space the siblings are reserving). It carries the tile
          transition, so the "sticky" snap feel lives HERE, where it can't lag the
          pointer: the outline holds through the hysteresis deadband, then flips a
          whole column at a time - resisting, then boinging to the next slot - as
          the span commits. Drawn above the lifted tile (z-30 > 20) so it reads
          whether the pointer is ahead of or behind the snap; pointer-events-none
          so it never intercepts the drag. */}
      {drag && (
        <div
          aria-hidden
          data-masonry-snap-preview
          className="absolute z-30 pointer-events-none rounded-lg border-2 border-blue-400/70"
          style={{
            left: placement.pos[drag.key]?.left ?? 0,
            top: placement.pos[drag.key]?.top ?? 0,
            width: drag.snapW,
            height: ghostH ?? heights[drag.key] ?? MASONRY_FALLBACK_H,
            // TILE_TRANSITION covers left/top/width; height (the ghost re-measure
            // at each snap) eases in step with the width flip.
            transition: ready ? `${TILE_TRANSITION}, height 280ms ${TILE_EASE}` : undefined,
          }}
        />
      )}
      {items.map((it) => {
        const p = placement.pos[it.key] ?? { left: 0, top: 0, width: 0, span: 1 }
        const bodyResize = canResize && it.bodyResizable !== false
        const dragging = drag?.key === it.key
        return (
          <div
            key={it.key}
            ref={observeTile}
            data-mkey={it.key}
            className={`absolute group/tile ${bodyResize ? 'touch-pan-y' : ''}`}
            style={{
              left: p.left,
              top: p.top,
              // While dragging this tile, render the live pointer-tracked width and
              // lift it above its neighbours; otherwise its placed span width. The
              // transition is suppressed on the dragged tile so it stays glued to
              // the cursor (an animated width would trail the pointer, restarting on
              // every move); it comes back the moment the drag ends, so the release
              // eases the tile from the pointer width into its snapped span width.
              // The siblings keep their transition throughout and reflow smoothly at
              // each live span snap.
              width: dragging ? (drag as { width: number }).width : p.width,
              zIndex: dragging ? 20 : undefined,
              transition: ready && !dragging ? TILE_TRANSITION : undefined,
            }}
            onPointerDown={bodyResize ? startBodyResize(it.key, p.span) : undefined}
            onClickCapture={bodyResize ? swallowDragClick(it.key) : undefined}
          >
            {it.node}
            {canResize && (
              // A grab handle on the tile's right edge (sitting in the gutter); the
              // blue rule appears on hover so the resize affordance stays subtle at
              // rest. The tile's media is also draggable (startBodyResize); this handle
              // gives a visible cue and a double-click target to auto-size.
              <div
                onPointerDown={startEdgeResize(it.key, p.span)}
                onDoubleClick={() => onSpanChange?.(spanKey(it.key), null)}
                title="Drag to resize · double-click to auto-size"
                className="absolute inset-y-0 right-0 z-10 w-3 -mr-1.5 cursor-col-resize flex justify-center items-stretch touch-none opacity-0 group-hover/tile:opacity-100 transition-opacity"
              >
                <div className="w-px self-stretch bg-blue-400/60" />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Lay the per-file before/after blocks out as a balanced masonry so a tall, narrow
// artifact (e.g. a phone screenshot) packs in next to others with no big gap to the
// right. Each tile auto-spans by aspect ratio (a wide desktop shot takes more
// columns than a tall phone shot); side-by-side doubles the span so the before/after
// pair has room. Drag a tile's edge to override its span.
// memo: the parent card re-renders on every streamed progress/log frame while
// its script regenerates; the files array identity only changes when the
// results actually change, so the masonry skips those frames entirely.
const FileGrid = memo(function FileGrid({ files, mode, scale = 1, spans, onSpanChange, scope, changeThreshold = 0 }: {
  files: ArtifactFile[]
  mode: ImageDiffMode
  // Global tile-size multiplier from the diff settings size slider (see MasonryGrid).
  scale?: number
  spans: ArtifactSpans
  onSpanChange?: (key: string, span: number | null) => void
  scope?: string
  // The active "% changed" threshold, forwarded to each FileRow so its change
  // badge matches how the file was filtered/counted (see effectiveChangeType).
  changeThreshold?: number
}) {
  const spanScale = mode === 'side-by-side' ? 2 : 1
  const sources = useMemo(
    // Download-class files have no loadable media, so they're excluded from
    // dimension probing (their tile uses a fixed flat aspect below).
    () => files.filter((f) => !isDownloadArtifact(f.name)).map((f) => ({
      key: f.name,
      url: f.right_url ?? f.left_url ?? null,
      video: isVideoArtifact(f.name),
      width: f.width,
      height: f.height,
      dpi: f.dpi,
    })),
    [files],
  )
  const dims = useMediaDims(sources)
  // The lightbox diff gallery: each visible image file (videos play inline, so they're
  // excluded) contributes one entry, in display order, carrying its before/after pair
  // and the current comparison mode - so opening any image lets ←/→ walk the files and
  // the lightbox shows the same comparison. A file with no image at all is skipped, so
  // it has no index and falls back to opening the single clicked image. `url` is the
  // representative side, used for the lightbox's edge previews.
  const imageFiles = useMemo(
    () => files.filter((f) => !isVideoArtifact(f.name) && !isDownloadArtifact(f.name) && (f.left_url || f.right_url)),
    [files],
  )
  const diffGallery = useMemo<LightboxImage[]>(
    () => imageFiles.map((f) => {
      // Same status the tile's badge shows - effectiveChangeType folds in the
      // "% changed" threshold, so a sub-threshold "modified" reads as unchanged
      // (no glyph) in both places.
      const ct = effectiveChangeType(f, changeThreshold)
      return {
        url: (f.right_url ?? f.left_url) as string,
        filename: f.name,
        size: 0,
        diff: { left: f.left_url, right: f.right_url, mode },
        dpi: f.dpi ?? undefined,
        // Known pixel size seeds the lightbox caption + comparator aspect on
        // navigation, so neither collapses and re-measures per image.
        width: f.width ?? undefined,
        height: f.height ?? undefined,
        changeType: ct === 'added' || ct === 'removed' || ct === 'modified' ? ct : undefined,
      }
    }),
    [imageFiles, mode, changeThreshold],
  )
  const galleryIndex = useMemo(() => {
    const m = new Map<string, number>()
    imageFiles.forEach((f, i) => m.set(f.name, i))
    return m
  }, [imageFiles])
  const items = useMemo(
    () => files.map((f) => ({
      key: f.name,
      node: <FileRow file={f} mode={mode} changeThreshold={changeThreshold} gallery={diffGallery} index={galleryIndex.get(f.name)} />,
      // Downloads have no media dimensions; a flat wide aspect keeps their
      // compact tile from being placed as a tall column.
      aspect: isDownloadArtifact(f.name) ? 3.2 : dims[f.name]?.aspect,
      pxWidth: dims[f.name]?.pxWidth,
      dpi: dims[f.name]?.dpi,
      // Videos need a minimum tile width for their transport controls (see
      // VIDEO_MIN_TILE_PX); images have no such chrome.
      minWidthPx: isVideoArtifact(f.name) ? VIDEO_MIN_TILE_PX : undefined,
      // Every tile - image AND video - resizes by dragging its media (data-tile-drag).
      // Controls that own their own horizontal drag (the slider divider, the onion
      // opacity range, the video transport bar) opt out with data-no-tile-drag /
      // <input>, so the two gestures never fight. Download tiles' save links are
      // plain anchors: a click still navigates (drags are distinguished by
      // threshold, like image clicks).
      bodyResizable: true,
    })),
    [files, mode, dims, changeThreshold, diffGallery, galleryIndex],
  )
  // pt-3 so the gap above the first row matches the card body's px-3 left inset.
  return (
    <div className="pt-3">
      <MasonryGrid items={items} spanScale={spanScale} scale={scale} spans={spans} onSpanChange={onSpanChange} scope={scope} />
    </div>
  )
})

// formatElapsed renders a running duration compactly: "12s", or "1m 05s" once it
// passes a minute.
function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

// ElapsedTime shows how long an in-flight generation has been running, ticking
// once a second. startedAt is a Unix time in seconds (from the backend, so it
// survives reloads/reconnects).
export function ElapsedTime({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return <>{formatElapsed(Math.max(0, Math.floor(now / 1000 - startedAt)))}</>
}

// memo: while a script is generating, every streamed progress/log frame
// replaces just that script's set object - memo confines the re-render to the
// one affected card instead of every card in the panel.
const ArtifactSetCard = memo(function ArtifactSetCard({ set, mode, scale, spans, onSpanChange, filter, search, onRefresh, projectId, agentId }: { set: ArtifactSet; mode: ImageDiffMode; scale: number; spans: ArtifactSpans; onSpanChange: (key: string, span: number | null) => void; filter: ArtifactTagFilter; search: string; onRefresh: (name: string, side?: ArtifactSide) => void; projectId: string | null; agentId: string }) {
  const status = set.status as string
  // Apply the (shared) tag filter and the search query to this card's files. The
  // grid shows only matches - ranked by search score when searching; the header
  // still reports the true diff size so "x/y changed" makes it obvious some are
  // hidden.
  const isFiltered = filterIsActive(filter)
  const searching = search.trim().length > 0
  const narrowed = isFiltered || searching
  const changeThreshold = clampChangeThreshold(filter.changeThreshold)

  // Which side(s) failed. A whole-set "error" status means both sides failed (or
  // the set couldn't be loaded at all); a "ready" set with a single side_error is
  // a partial failure - the other side rendered. Either way the failing side's
  // build log is the error surface (its stderr is the detail), so we mark it and
  // show its red-bordered terminal rather than a separate error box.
  const leftFailed = status === 'error' || !!set.left_error
  const rightFailed = status === 'error' || !!set.right_error
  // The mirror of *Failed: a side that settled cleanly (it produced a build log and
  // didn't error) gets a green-bordered terminal, matching the red one for failures.
  const leftSucceeded = !leftFailed && !!set.left_log_url
  const rightSucceeded = !rightFailed && !!set.right_log_url
  // One side failed while the other rendered (status stays "ready").
  const failedSide = partialFailedSide(set)

  // When one side failed, the surviving side's files would each surface as
  // added/removed (the failed side contributes none), exploding the card into a
  // pile of one-sided "changes" for a comparison we never actually made. Present
  // them as unchanged instead (see presentedFiles), so the default change filter
  // hides them and the card stays calm - the failure is already surfaced by the
  // red-bordered build-log terminal and the header chip, not a flood of fake diffs.
  // Depend on the exact inputs (not the whole set): a streamed progress/log
  // frame replaces the set object but not its files, and keeping these arrays
  // identity-stable through those frames is what lets the memo'd FileGrid
  // below skip re-laying-out the masonry on every frame. Mirrors
  // presentedFiles (which needs the whole set).
  const cardFiles = useMemo(
    () => (failedSide
      ? set.files.map((f) => ({ ...f, change_type: ArtifactFileNS.change_type.UNCHANGED }))
      : set.files),
    [set.files, failedSide],
  )

  const visibleFiles = useMemo(
    () => computeVisibleFiles(cardFiles, filter, search),
    [cardFiles, filter, search],
  )
  // "changed" counts honour the change-type threshold, so a sub-threshold tweak
  // doesn't inflate the "x/y changed" header (see effectiveChangeType).
  const changedFiles = visibleFiles.filter((f) => effectiveChangeType(f, changeThreshold) !== 'unchanged')
  const totalChanged = cardFiles.filter((f) => effectiveChangeType(f, changeThreshold) !== 'unchanged').length
  const changedLabel = narrowed && changedFiles.length !== totalChanged ? `${changedFiles.length}/${totalChanged} changed` : `${totalChanged} changed`
  // A partial failure isn't a "visual change" - the surviving side's files are
  // neutralised above, so the header reads "no visual changes" + the failed chip.
  const noChanges = status === 'ready' && (!set.changed || !!failedSide)

  // Restore any saved view prefs for this card (persisted per project+agent+name).
  // loadArtifactPrefs returns null when the saved status no longer matches the
  // current one, so a regenerate / generating→ready transition falls back to the
  // status-derived defaults below rather than a stale toggle. Read once on mount
  // via the lazy useState initializers.
  const loadPrefs = () => loadArtifactPrefs(projectId, agentId, set.name, status)

  // Every state (generating / error / no-changes / changed) renders inside the
  // same bordered card so switching between them never shifts the layout (e.g.
  // hitting refresh after a failure) and the refresh button is always reachable -
  // including when there are no visual changes. Default to collapsed (the card is
  // opt-in: click to expand) when nothing is saved for this agent; the saved
  // per-agent state, when present, wins. The card is keyed by project+agent+name
  // at the call site, so switching agents remounts it and re-reads that agent's
  // saved state instead of leaking the previous agent's toggle.
  const [collapsed, setCollapsed] = useState(() => loadPrefs()?.collapsed ?? true)
  // Default the build log open when a side failed: the red-bordered terminal is
  // now the primary way the failure is surfaced (it replaces the old error box),
  // so a freshly-expanded failed card should show it without a second click. A
  // saved pref still wins, and the user can collapse it.
  const [buildLogOpen, setBuildLogOpen] = useState(() => loadPrefs()?.buildLogOpen ?? (leftFailed || rightFailed))

  // Persist the view prefs whenever a toggle changes (and re-key them under the
  // current status, so they only restore while that status holds).
  useEffect(() => {
    saveArtifactPrefs(projectId, agentId, set.name, status, { collapsed, buildLogOpen })
  }, [projectId, agentId, set.name, status, collapsed, buildLogOpen])

  // The build log lives behind a header toggle (next to refresh) for settled cards
  // that produced a log. Opening it also expands the card, since the log renders in
  // the body.
  const hasBuildLog = (status === 'ready' || status === 'error') && !!(set.left_log_url || set.right_log_url)
  // When either side failed, the build log is the error surface, so an expanded card
  // ALWAYS shows it (its red-bordered stderr is the failure detail) - the user can't
  // hide it, so the toggle is suppressed below. With no failure it follows the
  // buildLogOpen toggle (restored from saved prefs).
  const anyFailed = leftFailed || rightFailed
  const buildLogVisible = buildLogOpen || anyFailed
  const toggleBuildLog = () => setBuildLogOpen((o) => {
    const next = !o
    if (next) setCollapsed(false)
    return next
  })

  // The regenerate button is a split button: a main click regenerates both sides,
  // the chevron opens a menu to regenerate just the before/after side (handy when
  // only one side failed, or only one is slow to rebuild). The menu is rendered in
  // a portal with fixed coords because the card is `overflow-hidden` (to clip its
  // rounded header), which would otherwise clip an in-flow absolute dropdown.
  const [regenMenuOpen, setRegenMenuOpen] = useState(false)
  const regenBtnRef = useRef<HTMLDivElement>(null)
  const [regenCoords, setRegenCoords] = useState<{ left: number; top: number } | null>(null)
  const REGEN_MENU_WIDTH = 208 // w-52
  useLayoutEffect(() => {
    if (!regenMenuOpen) return
    const update = () => {
      const el = regenBtnRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const padding = 8
      // Right-align the menu to the button group, clamped into the viewport.
      const left = Math.max(padding, Math.min(rect.right - REGEN_MENU_WIDTH, window.innerWidth - REGEN_MENU_WIDTH - padding))
      setRegenCoords({ left, top: rect.bottom + 4 })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [regenMenuOpen])

  // Header progress while generating: both sides' latest progress lines joined by
  // a "·" (the two builds run in parallel), e.g. "building frontend · home 7/24".
  const progressText = [set.left_progress, set.right_progress].filter(Boolean).join(' · ')

  const statusChips = (
    <>
      {status === 'generating' && (
            // Live header: spinner, the latest stdout line as progress (truncated so
            // it can't push the refresh button off the row), then how long the job
            // has been running, separated by a "·". Expand the card for the full log.
            <span className="flex items-center gap-1.5 min-w-0 text-xs text-gray-400 dark:text-gray-500">
              <LoaderCircle className="w-3 h-3 shrink-0 animate-spin" />
              <span className="truncate">{progressText || 'generating...'}</span>
              {set.started_at ? (
                <span className="shrink-0">· <ElapsedTime startedAt={set.started_at} /></span>
              ) : null}
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
              // Highlight the change count so a card with visual changes stands
              // out at a glance from the muted "no visual changes" cards. When the
              // filter hides some, the label reads "shown/total changed".
              <span className="text-xs font-medium text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 rounded-full px-2 py-0.5 shrink-0">{changedLabel}</span>
            ))}
      {status === 'ready' && failedSide && (
            // One side failed to render; flag it in the header so it's visible
            // even while the card is collapsed (the images shown are one-sided).
            <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 shrink-0">
              <TriangleAlert className="w-3 h-3" /> {failedSide === 'left' ? 'before' : 'after'} failed
            </span>
          )}
    </>
  )

  const actionButtons = (
    <>
      {/* Show/hide the build log. Opening it also expands the card (the log
              renders in the body). Only for settled cards with a log. The open
              state stays tinted blue even at rest so "log is showing" is legible,
              brightening a touch on its own hover; the resting affordance otherwise
              melts away (see MELT_BTN). Hidden when a side failed: the log is
              force-shown there, so there's nothing to toggle. */}
          {hasBuildLog && !anyFailed && (
            <button
              onClick={toggleBuildLog}
              title={buildLogOpen ? 'Hide build log' : 'Show build log'}
              aria-label={buildLogOpen ? 'Hide build log' : 'Show build log'}
              className={`h-7 px-2 inline-flex items-center justify-center rounded-md transition-colors cursor-pointer ${
                buildLogOpen
                  ? 'text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300'
                  : MELT_BTN
              }`}
            >
              <ScrollText className="w-3.5 h-3.5" />
            </button>
          )}
          {/* Split regenerate button: a main click busts the per-commit cache and
              regenerates both sides (chiefly to retry a failure, whose error is
              otherwise cached until the ref changes); the chevron opens a menu to
              regenerate just one side. */}
          <div ref={regenBtnRef} className="relative inline-flex">
            <button
              onClick={() => onRefresh(set.name)}
              title="Regenerate this artifact"
              aria-label="Regenerate this artifact"
              className={`h-7 pl-2 pr-1.5 inline-flex items-center rounded-l-md ${MELT_BTN}`}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setRegenMenuOpen((o) => !o)}
              title="Regenerate one side"
              aria-label="Regenerate options"
              aria-expanded={regenMenuOpen}
              className={`h-7 px-1 inline-flex items-center rounded-r-md ${MELT_BTN}`}
            >
              <ChevronDown className="w-3 h-3" />
            </button>
            {/* Portal'd so the card's overflow-hidden can't clip it (see regenCoords). */}
            {regenMenuOpen && regenCoords && createPortal(
              <>
                {/* click-away backdrop */}
                <div className="fixed inset-0 z-[9998]" onClick={() => setRegenMenuOpen(false)} />
                <div
                  className="fixed z-[9999] w-52 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1 text-xs"
                  style={{ left: regenCoords.left, top: regenCoords.top }}
                >
                  {/* The main button already regenerates both sides; the menu is
                      just the per-side shortcuts. */}
                  {([
                    { side: 'left' as ArtifactSide, label: 'Regenerate before' },
                    { side: 'right' as ArtifactSide, label: 'Regenerate after' },
                  ]).map(({ side, label }) => (
                    <button
                      key={label}
                      onClick={() => { setRegenMenuOpen(false); onRefresh(set.name, side) }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                      {label}
                    </button>
                  ))}
                </div>
              </>,
              document.body,
            )}
          </div>
    </>
  )

  return (
    <CollapsibleCard
      sticky
      icon={<ImageIcon className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400 shrink-0" />}
      name={set.name}
      status={statusChips}
      actions={actionButtons}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((c) => !c)}
      // Toggling the build log is a deliberate in-place swap - glide the card to its
      // new height rather than snapping.
      glideKey={buildLogVisible}
    >
          {/* While generating, stream both builds' live logs side by side; a side
              that finishes first shows its final log instead of "waiting". */}
          {status === 'generating' && <LiveLogPanes set={set} />}
          {status === 'error' && (
            <>
              {/* Both sides failed: the red-bordered build-log terminals (the
                  script's stderr) ARE the error surface, so no separate error box.
                  Fall back to the captured error text only when no log exists. */}
              <PersistedLogView leftUrl={set.left_log_url} rightUrl={set.right_log_url} open={buildLogVisible} leftFailed={leftFailed} rightFailed={rightFailed} leftSucceeded={leftSucceeded} rightSucceeded={rightSucceeded} />
              {!hasBuildLog && (
                <div className="my-2 px-3 py-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 font-mono text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">
                  {set.error ? stripAnsi(set.error) : 'Artifact generation failed.'}
                </div>
              )}
            </>
          )}
          {status === 'ready' && (
            // The files matching the panel's filters (the change-type filter hides
            // unchanged by default - see the header "changes" dropdown) laid out in
            // one masonry. Empty states cover "produced nothing" vs "filtered out".
            <>
              {/* Build log sits at the top of the body so "Show build log" reveals
                  it without scrolling past the image grid. When one side failed it
                  auto-opens with that side's terminal red-bordered (its stderr is
                  the failure detail), and the surviving side's files are neutralised
                  to "unchanged" (cardFiles) so they're hidden by default rather than
                  flooding the grid with one-sided diffs. */}
              <PersistedLogView leftUrl={set.left_log_url} rightUrl={set.right_log_url} open={buildLogVisible} leftFailed={leftFailed} rightFailed={rightFailed} leftSucceeded={leftSucceeded} rightSucceeded={rightSucceeded} />
              {failedSide && !hasBuildLog && (
                // One side died and left no log to show: fall back to a one-line note
                // so the partial result is still explained.
                <div className="my-2 flex items-center gap-1.5 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs font-medium text-amber-700 dark:text-amber-300">
                  <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                  The {failedSide === 'left' ? 'before' : 'after'} side failed to render - showing the {failedSide === 'left' ? 'after' : 'before'} side only.
                </div>
              )}
              {cardFiles.length === 0 ? (
                <div className="my-2 text-xs text-gray-400 dark:text-gray-500">No artifacts produced.</div>
              ) : visibleFiles.length === 0 ? (
                <div className="my-2 text-xs text-gray-400 dark:text-gray-500">
                  {failedSide
                    ? `Only the ${failedSide === 'left' ? 'after' : 'before'} side rendered - its ${cardFiles.length} file${cardFiles.length === 1 ? '' : 's'} ${cardFiles.length === 1 ? 'is' : 'are'} hidden as unchanged (nothing to compare). Show "unchanged" in the changes filter to view ${cardFiles.length === 1 ? 'it' : 'them'}.`
                    : `No files match ${searching ? 'your search' : 'the current filters'}.`}
                </div>
              ) : (
                <FileGrid files={visibleFiles} mode={mode} scale={scale} spans={spans} onSpanChange={onSpanChange} scope={`${agentId}/${set.name}`} changeThreshold={changeThreshold} />
              )}
            </>
          )}
    </CollapsibleCard>
  )
})

// useStableArray keeps an array's identity stable while its ELEMENTS are
// reference-equal to the previous render's. Derived flatMap/filter arrays get a
// fresh identity every render even when nothing in them changed, which would
// defeat the memo() on components taking them as props (the filter bar).
// Uses the render-phase derived-state idiom (not a ref, which must not be
// read/written during render).
function useStableArray<T>(arr: T[]): T[] {
  const [prev, setPrev] = useState(arr)
  const same = prev === arr || (prev.length === arr.length && arr.every((v, i) => v === prev[i]))
  if (!same) setPrev(arr)
  return same ? prev : arr
}

type ArtifactSide = 'left' | 'right'

// Server→client message on the artifacts WebSocket. Mirrors internal/http/artifacts_ws.go.
// log/progress carry a `side` so the two builds (before/after) stay in separate
// panes instead of interleaving into one stream.
type ArtifactWSMessage =
  | { type: 'snapshot'; scripts: ArtifactSet[] }
  | { type: 'set'; set: ArtifactSet }
  | { type: 'log'; script: string; side: ArtifactSide; line: ArtifactLogLine }
  | { type: 'progress'; script: string; side: ArtifactSide; progress: string }

function artifactsWsUrl(projectId: string | null, agentId: string, baseRef?: string, headRef?: string, includeUncommitted?: boolean): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const pid = projectId ? encodeURIComponent(projectId) : '_'
  const params = new URLSearchParams()
  if (baseRef) params.set('base_ref', baseRef)
  if (headRef) params.set('head_ref', headRef)
  if (includeUncommitted) params.set('include_uncommitted', 'true')
  const qs = params.toString() ? `?${params.toString()}` : ''
  return `${protocol}//${host}/ws/projects/${pid}/agents/${encodeURIComponent(agentId)}/artifacts${qs}`
}

// memo: hosted by DiffViewer (see TestsPanel) - every prop is a primitive, a
// stable setter, or an identity-stable object (artifactSpans), so the panel
// only re-renders for its own WS/stream state or a deliberate prop change.
export const ArtifactsPanel = memo(ArtifactsPanelImpl)

function ArtifactsPanelImpl({ projectId, agentId, baseRef, headRef, includeUncommitted, refreshKey, imageDiffMode, onImageDiffModeChange, artifactScale, onArtifactScaleChange, artifactView, onArtifactViewChange, artifactHighlight, onArtifactHighlightChange, artifactSpans, onArtifactSpanChange }: {
  projectId: string | null
  agentId: string
  baseRef?: string
  headRef?: string
  includeUncommitted?: boolean
  refreshKey: number
  imageDiffMode: ImageDiffMode
  // The image-diff mode (before/after, slider, side-by-side, onion) and the tile
  // size multiplier - their controls live in this panel's own header cog (were in
  // the diff-toolbar cog), so the state stays lifted in the diff viewer.
  onImageDiffModeChange: (v: ImageDiffMode) => void
  // Global tile-size multiplier (the size slider), forwarded to every card.
  artifactScale: number
  onArtifactScaleChange: (v: number) => void
  // Global before/after view + "highlight" for A/B tiles, owned by the diff viewer so
  // they persist and so the header controls + B/H keyboard shortcuts drive every tile.
  artifactView: 'before' | 'after'
  onArtifactViewChange: (v: 'before' | 'after') => void
  artifactHighlight: boolean
  onArtifactHighlightChange: (v: boolean) => void
  artifactSpans: ArtifactSpans
  onArtifactSpanChange: (key: string, span: number | null) => void
}) {
  const [sets, setSets] = useState<ArtifactSet[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Connection mode: WS while live, polling if the socket can't connect or drops.
  const [mode, setMode] = useState<'connecting' | 'ws' | 'poll'>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Manual-refresh state for the polling fallback (the WS path sends a message
  // instead): stash the script name and bump the nonce to re-run the poll effect.
  const [refreshNonce, setRefreshNonce] = useState(0)
  const refreshScriptRef = useRef<{ name: string; side?: ArtifactSide } | null>(null)

  // Measured height of the sticky Artifacts filter bar, published as the shared
  // --sticky-section-h so each card header can dock flush beneath it. The bar grows
  // when it wraps to two rows on narrow widths, so a fixed offset would gap/overlap -
  // measure it instead (see useMeasuredHeight; the same hook gives the tests panel's
  // header the same treatment). Defaults to the unwrapped height meanwhile.
  const [filterBarRef, filterBarH] = useMeasuredHeight(41)

  // Tag filter, shared across every card for this agent. Reload it when the
  // project/agent changes; persist it only on an explicit user change (a save
  // effect would race the reload and clobber the new key with the old value).
  const [tagFilter, setTagFilter] = useState<ArtifactTagFilter>(() => loadTagFilter(projectId, agentId))
  useEffect(() => { setTagFilter(loadTagFilter(projectId, agentId)) }, [projectId, agentId])

  // Free-text search over filenames + tags (split-word fuzzy match + rank). Kept
  // ephemeral - it narrows/ranks the view without persisting - and cleared when the
  // project/agent changes since this panel is reused across agents.
  const [search, setSearch] = useState('')
  useEffect(() => { setSearch('') }, [projectId, agentId])

  // Lightweight "chrome" (script names + available tags) read from localStorage -
  // a previous render of this agent (or, as a fallback, any agent in this project)
  // - so the header, tag filter and collapsed card headers paint immediately, with
  // NO network round-trip, before the WS snapshot arrives. Re-read when the
  // project/agent changes (the panel is reused across agents). Saved back below
  // once a live comparison settles.
  const [chrome, setChrome] = useState<ArtifactChrome | null>(() => loadArtifactChrome(projectId, agentId))
  useEffect(() => { setChrome(loadArtifactChrome(projectId, agentId)) }, [projectId, agentId])
  // Persist the chrome once every script has settled, so the next open of this
  // agent (or a sibling) renders it instantly. Skipped while anything is still
  // generating so a partial tag set isn't cached as complete.
  useEffect(() => {
    if (!sets || sets.length === 0) return
    if (sets.some((s) => (s.status as string) === 'generating')) return
    const names = [...new Set(sets.map((s) => s.name))].sort()
    const tags = [...new Set(sets.flatMap((s) => s.files.flatMap((f) => f.tags ?? [])))].sort()
    saveArtifactChrome(projectId, agentId, { names, tags })
  }, [sets, projectId, agentId])
  const updateTagFilter = useCallback((f: ArtifactTagFilter) => {
    setTagFilter(f)
    saveTagFilter(projectId, agentId, f)
  }, [projectId, agentId])

  // Global before/after + highlight for the A/B tiles, handed down via context so every
  // tile flips/highlights together instead of each carrying its own pill. Only the 'ab'
  // mode routes to those tiles, so the header controls + shortcuts below gate on it.
  const abControls = useMemo<ArtifactABControls>(() => ({
    view: artifactView,
    highlight: artifactHighlight,
    toggleView: () => onArtifactViewChange(artifactView === 'before' ? 'after' : 'before'),
  }), [artifactView, artifactHighlight, onArtifactViewChange])

  // Keyboard: the shared X/B/A/H comparator shortcuts (see applyABShortcut) - only in
  // A/B mode. Suppressed while the image lightbox is open: the lightbox has its own
  // X/B/A/H (scoped to its fullscreen comparator, see LightboxDiff), and a single key
  // must not flip both the lightbox and the grid behind it at once.
  useEffect(() => {
    if (imageDiffMode !== 'ab') return
    const onKey = (e: KeyboardEvent) => {
      if (useImageLightboxStore.getState().images) return
      applyABShortcut(e, {
        view: artifactView,
        highlight: artifactHighlight,
        onViewChange: onArtifactViewChange,
        onHighlightChange: onArtifactHighlightChange,
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [imageDiffMode, artifactView, artifactHighlight, onArtifactViewChange, onArtifactHighlightChange])

  // Coalesce streamed log lines: a chatty generator emits many `log` frames per
  // tick, and appending each on its own would re-copy the whole growing log
  // array per line (O(n^2)). Queue them by script+side and apply one batch per
  // ~frame. The key packs both axes so left/right stay separate.
  const { enqueue: enqueueLog, flushNow: flushLogs } = useLogCoalescer<ArtifactLogLine>((batches) => {
    setSets((prev) => prev?.map((s) => {
      const left = batches.get(`${s.name}\0left`)
      const right = batches.get(`${s.name}\0right`)
      if (!left && !right) return s
      return {
        ...s,
        ...(left ? { left_log: [...(s.left_log ?? []), ...left] } : {}),
        ...(right ? { right_log: [...(s.right_log ?? []), ...right] } : {}),
      }
    }) ?? prev)
  })

  // Apply a server→client WS message to local state.
  const applyMessage = useCallback((msg: ArtifactWSMessage) => {
    // setError(null) bails out (no re-render) when already null, so this stays
    // cheap even on a burst of log frames.
    setError(null)
    if (msg.type === 'log') {
      enqueueLog(`${msg.script}\0${msg.side}`, msg.line)
      return
    }
    // Any other message may replace/modify a set - apply queued log lines first
    // so they land in order on the current set before it changes.
    flushLogs()
    if (msg.type === 'snapshot') {
      setSets(msg.scripts ?? [])
    } else if (msg.type === 'set') {
      setSets((prev) => (prev ? prev.map((s) => (s.name === msg.set.name ? msg.set : s)) : [msg.set]))
    } else if (msg.type === 'progress') {
      setSets((prev) => prev?.map((s) => {
        if (s.name !== msg.script) return s
        return msg.side === 'left' ? { ...s, left_progress: msg.progress } : { ...s, right_progress: msg.progress }
      }) ?? prev)
    }
  }, [enqueueLog, flushLogs])

  // Primary path: stream updates over a WebSocket so progress/log update instantly.
  // Falls back to polling (below) if the socket fails to open or later drops.
  useEffect(() => {
    let cancelled = false
    setMode('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(artifactsWsUrl(projectId, agentId, baseRef, headRef, includeUncommitted))
    } catch {
      setMode('poll')
      return
    }
    wsRef.current = ws
    ws.onopen = () => { if (!cancelled) setMode('ws') }
    ws.onmessage = (e) => {
      if (cancelled) return
      try { applyMessage(JSON.parse(e.data) as ArtifactWSMessage) } catch { /* ignore malformed frames */ }
    }
    ws.onclose = () => {
      wsRef.current = null
      // Fall back to polling on any non-deliberate close (initial-connect failure
      // or a mid-session drop, e.g. the daemon restarting).
      if (!cancelled) setMode('poll')
    }
    return () => {
      cancelled = true
      closeWebSocket(ws)
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [projectId, agentId, baseRef, headRef, includeUncommitted, refreshKey, applyMessage])

  // Fallback path: poll the HTTP endpoint while the WS is unavailable.
  useEffect(() => {
    if (mode !== 'poll') return
    let cancelled = false
    const clear = () => { if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null } }
    const refreshScript = refreshScriptRef.current
    refreshScriptRef.current = null

    const tick = async (first: boolean) => {
      try {
        const resp = await api.default.getAgentArtifacts(projectId ?? '', agentId, baseRef, headRef, includeUncommitted, first ? refreshScript?.name : undefined, first ? refreshScript?.side : undefined)
        if (cancelled) return
        setSets(resp.scripts)
        setError(null)
        if (resp.scripts.some((s) => (s.status as string) === 'generating')) {
          pollTimerRef.current = setTimeout(() => tick(false), 2500)
        }
      } catch (e) {
        // Surface a real server error (e.g. a config that won't parse); a bare
        // network blip (no structured body) leaves the panel's state be.
        if (!cancelled && apiErrorBody(e)) setError(formatError(e))
      }
    }
    clear()
    tick(true)
    return () => { cancelled = true; clear() }
  }, [mode, projectId, agentId, baseRef, headRef, includeUncommitted, refreshKey, refreshNonce])

  const requestRefresh = useCallback((name: string, side?: ArtifactSide) => {
    // Optimistically flip the card to a fresh "generating" state so the spinner,
    // a zeroed elapsed clock and an empty log show immediately. A per-side refresh
    // only zeroes that side - the other keeps its existing log/progress so it isn't
    // visually thrown away while it stays cached.
    const both = side === undefined
    setSets((prev) => prev?.map((s) => (s.name === name
      ? {
          ...s,
          status: 'generating' as unknown as ArtifactSet['status'],
          error: both ? null : s.error,
          ...(both || side === 'left' ? { left_progress: null, left_log: [], left_log_url: null, left_error: null } : {}),
          ...(both || side === 'right' ? { right_progress: null, right_log: [], right_log_url: null, right_error: null } : {}),
          started_at: Math.floor(Date.now() / 1000),
        }
      : s)) ?? prev)
    const ws = wsRef.current
    if (mode === 'ws' && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'refresh', script: name, ...(side ? { side } : {}) }))
    } else {
      // Polling fallback: forward the name (and side) to the next poll so the
      // backend discards the cached (possibly errored) result and regenerates.
      refreshScriptRef.current = { name, side }
      setRefreshNonce((n) => n + 1)
    }
  }, [mode])

  // What to render: the live sets once they arrive, otherwise a skeleton built
  // from the cached chrome (one collapsed, "generating" card per script name) so
  // the chrome is up before the snapshot. Cards key by name, so each skeleton
  // header is reused by its live card with no remount/jump when sets land.
  const displaySets = useMemo<ArtifactSet[] | null>(() => {
    if (sets) return sets
    if (chrome && chrome.names.length > 0) {
      return chrome.names.map((name) => ({
        name,
        status: 'generating' as unknown as ArtifactSet['status'],
        changed: false,
        files: [],
      }))
    }
    return null
  }, [sets, chrome])
  const isSkeleton = sets === null && displaySets !== null

  // Every file across all sets, flattened - fed to the filter bar so it can derive
  // the offered tags/types and per-value counts itself (see ArtifactFilterBar). Run
  // through presentedFiles so a partial-failure set's surviving files count as
  // unchanged here too, matching how each card presents them (no "538 added" in the
  // changes dropdown while the card body calls the same files unchanged).
  // useStableArray: a progress/log frame replaces set objects but not their
  // files, so the flatMap would otherwise mint a new (identical) array every
  // frame and re-render the memo'd filter bar for nothing.
  const allFiles = useStableArray(useMemo(() => (displaySets ?? []).flatMap(presentedFiles), [displaySets]))
  // Tags to offer before files are present: a side's pending_tags once live, plus
  // - while anything is still generating (incl. the skeleton) - the cached chrome
  // tags, so the filter set only grows then settles to the live file tags once
  // everything is ready (a stale cached tag can't linger past settle).
  const anyGenerating = (displaySets ?? []).some((s) => (s.status as string) === 'generating')
  const pendingTags = useStableArray(useMemo(() => {
    const live = (sets ?? []).flatMap((s) => s.pending_tags ?? [])
    const cached = anyGenerating ? (chrome?.tags ?? []) : []
    return Array.from(new Set([...live, ...cached]))
  }, [sets, chrome, anyGenerating]))

  // Surface a server error only when there is nothing else to show; if cached
  // sets are on screen, keep them rather than replacing them with the error.
  if (error && (!displaySets || displaySets.length === 0)) {
    return <PanelError title="Artifacts" icon={<ImageIcon className="w-3.5 h-3.5" />} message={error} />
  }
  // Render nothing until we know there are configured scripts - either from the
  // live snapshot or the cached summary skeleton.
  if (!displaySets || displaySets.length === 0) return null

  // Generation progress (#38): how many artifact scripts have settled (ready or
  // failed) versus how many are still generating. Shown only while work is in
  // flight; WS pushes (or the poll above) keep it ticking until everything
  // settles. The skeleton has no real counts yet, so it just shows the spinner.
  const generatingCount = displaySets.filter((s) => (s.status as string) === 'generating').length
  const settledCount = displaySets.length - generatingCount

  return (
    // Publish the measured filter-bar height so card headers can dock flush beneath
    // it (the Changes-bar height arrives via --sticky-changes-h from DiffViewer).
    <div className="mb-4" style={{ '--sticky-section-h': `${filterBarH}px` } as CSSProperties}>
      {/* Reserve the filter bar's height (its segmented controls / chips are
          taller than the bare title) so the header stays the same height whether
          or not tags are present - the filter loading in must not jump the layout. */}
      {/* Sticky: dock this Artifacts header + filters flush just below the Changes
          bar (which sticks at the top) while the cards scroll under it, then release
          once the whole panel scrolls past into the file diffs. The `top` is the
          measured Changes-bar height minus the scroll container's pt-4 (which the
          Changes bar cancels with -top-4), so the two bars sit exactly edge-to-edge
          - no seam, and the bar's py-1.5 reads symmetric above/below its controls.
          z-20 sits below the Changes bar but above the cards (whose headers stick at
          z-10). Needs an opaque bg (matching the page) so cards scroll cleanly
          underneath, and -mx-1/px-1 bleeds it to the same width as the Changes bar. */}
      <div
        ref={filterBarRef}
        style={{ top: 'calc(var(--sticky-changes-h, 45px) - 16px)' }}
        className="sticky z-20 flex flex-wrap items-center gap-2 mb-2 min-h-[1.625rem] bg-gray-50 dark:bg-gray-900 -mx-1 px-1 py-1.5 border-b border-gray-200 dark:border-gray-800 shadow-sm"
      >
        <ImageIcon className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
        <h3 className="text-xs font-semibold tracking-wide text-gray-500 dark:text-gray-400">Artifacts</h3>
        {generatingCount > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] font-normal text-gray-400 dark:text-gray-500">
            <LoaderCircle className="w-3 h-3 animate-spin" />
            {isSkeleton ? 'Loading' : `Generating ${settledCount}/${displaySets.length}`}
          </span>
        )}
        <InfoTooltip title="Artifacts" width={560}>
          <p>Artifacts are visual snapshots - typically screenshots, or videos (screen recordings) - rendered from your code so you can see what a change <em>looks like</em>, side by side with the base branch.</p>
          <p>Each one is produced by a project-defined <strong>artifact script</strong>. Hydra checks out both the base ref and the head ref (or your uncommitted working tree), runs the script against each with <code className="text-blue-300">$HYDRA_ARTIFACT_OUTPUT</code>, <code className="text-blue-300">$HYDRA_ARTIFACT_SOURCE</code> and <code className="text-blue-300">$HYDRA_ARTIFACT_REF</code> set, and compares the images it writes. Results are cached per commit, so re-viewing a diff is free.</p>
          <p>Configure them in <code className="text-blue-300">.hydra/config.toml</code> with <code className="text-blue-300">[[artifacts]]</code> blocks (<code className="text-blue-300">name</code>, <code className="text-blue-300">command</code>, optional <code className="text-blue-300">timeout_sec</code>) - for example a script that builds the app and screenshots a page, so visual UI changes show up here in the diff viewer.</p>
          <p><strong>Images &amp; video.</strong> <code className="text-blue-300">.png .jpg .gif</code> are diffed pixel-by-pixel (so cosmetic re-encodes are ignored); <code className="text-blue-300">.webm</code> video is diffed frame-by-frame when <strong>ffmpeg</strong> is installed, falling back to a byte-hash comparison otherwise (shown with a <em>byte-compared</em> badge, since that verdict may be spurious). Other types - <code className="text-blue-300">.webp .avif .svg .bmp .pdf</code> - are byte-hash compared. Encode video as <strong>lossless</strong> <code className="text-blue-300">.webm</code> (e.g. <code className="text-blue-300">ffmpeg ... -c:v libvpx-vp9 -lossless 1</code>) so identical frames stay identical.</p>
          <p>A script with no visual changes - or one still generating - collapses to a single header row; click it to expand. The two sides (base and head) build in parallel, so the expanded card shows their <strong>build logs side by side</strong> (Before / After, stderr in red); once finished, reopen them any time with the <strong>build log</strong> button (the scroll icon next to refresh in the card header). The refresh button beside it re-runs a script - handy to retry a failure or re-render even when nothing visibly changed.</p>
          <p>The header shows each side's latest <code className="text-blue-300">stdout</code> line as live progress. To surface a cleaner message, print a line prefixed with <code className="text-blue-300">::hydra:progress::</code> (e.g. <code className="text-blue-300">echo "::hydra:progress:: capturing home 3/24"</code>) - Hydra strips the prefix, shows the rest as the progress line, and from then on ignores ordinary <code className="text-blue-300">stdout</code> for the header, so a noisy build can't hijack it. The full output still lands in the build log.</p>
          <p><strong>Tags &amp; filter.</strong> Alongside an image <code className="text-blue-300">home.png</code> the script can write a JSON sidecar <code className="text-blue-300">home.png.meta</code> like <code className="text-blue-300">{'{'}"tags": ["theme::dark", "viewport::phone"]{'}'}</code>. Tags show as labels on each file and as a filter on this bar. The sidecar can also carry an optional <code className="text-blue-300">dpi</code> (the device-scale factor the shot was captured at, e.g. <code className="text-blue-300">{'{'}"dpi": 2{'}'}</code>) - the grid then sizes a tile by its <em>logical</em> width (pixels / dpi), so a 2× shot lays out like a 1× one, just sharper. For a video, an optional <code className="text-blue-300">fps</code> (e.g. <code className="text-blue-300">{'{'}"fps": 60{'}'}</code>) sets the frame rate the frame-step buttons use, since HTML5 video exposes none of its own. A <code className="text-blue-300">category::value</code> tag is a <em>scoped</em> label - only one value per category is kept on a file (the last wins), and each category gets a filter button listing its values. Every value starts <em>on</em>; uncheck one to hide the files carrying it, or use <strong>all</strong> / <strong>clear</strong> (top of the menu) to toggle them in bulk. Shift-click a value to isolate it (hide everything else). Each value also shows a dimmed count on the right - how many items carry it under your current filters (ignoring this scope itself). Plain tags work the same way under a "tags" button. Handy when a script emits many shots (light/dark, phone/desktop) and you want to see just one slice. Two built-in filters are always present: a <strong>type</strong> filter (image / video, from each file's extension) and a <strong>changes</strong> filter (added / removed / modified / unchanged, from each file's diff state) - the latter always offers all four kinds even when none are present, and hides unchanged files by default, so use it to reveal them or to focus on one kind of change.</p>
        </InfoTooltip>
        {/* Right cluster: the global A/B before/after + highlight controls (only
            meaningful in A/B mode, where each tile shows one side at a time), then
            the shared filter bar. ml-auto floats the whole cluster to the right. */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {imageDiffMode === 'ab' && (
            <div className="flex items-center gap-1.5">
              <span title="Show every tile's before / after - X flips · B = Before · A = After">
                <SegmentedToggle
                  value={artifactView}
                  onChange={onArtifactViewChange}
                  options={[{ value: 'before', label: 'Before' }, { value: 'after', label: 'After' }]}
                />
              </span>
              <label
                title="Highlight changed pixels in magenta on every tile - shortcut: H"
                className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-gray-500 dark:text-gray-400 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={artifactHighlight}
                  onChange={(e) => onArtifactHighlightChange(e.target.checked)}
                  className="accent-blue-500 cursor-pointer"
                />
                Highlight
              </label>
            </div>
          )}
          {/* The shared filter bar: a search box and one dropdown per tag scope (the
              user-defined categories, the free-form "tags" group, plus the built-in
              type and changes scopes). */}
          <ArtifactFilterBar
            files={allFiles}
            pendingTags={pendingTags}
            filter={tagFilter}
            onFilterChange={updateTagFilter}
            search={search}
            onSearchChange={setSearch}
            showChangeFilter
          />
          {/* Artifact view options (were in the diff-toolbar cog): the image-diff
              mode and the global tile-size multiplier. */}
          <SettingsPopover label="Artifact options" width={208}>
            <SettingsGroupLabel className="mb-2">Image Diff</SettingsGroupLabel>
            <div className="flex flex-col gap-0.5">
              {IMAGE_DIFF_MODES.map((opt) => (
                <SettingsOptionRow key={opt.value} type="radio" name="hydra-image-diff-mode"
                  checked={imageDiffMode === opt.value} onChange={() => onImageDiffModeChange(opt.value)} label={opt.label} />
              ))}
            </div>
            {/* The grid auto-sizes each tile by aspect ratio; this scales every
                tile up or down from there (drag a tile's edge to override one). */}
            <div className="mt-3 flex items-center gap-2">
              <SettingsGroupLabel className="shrink-0">Size</SettingsGroupLabel>
              <input
                type="range" min={0.5} max={2} step={0.25} value={artifactScale}
                onChange={(e) => onArtifactScaleChange(Number(e.target.value))}
                className="flex-1 accent-blue-500 cursor-pointer"
                title="Scale every artifact tile up or down"
              />
              <span className="text-[10px] tabular-nums text-gray-400 dark:text-gray-500 w-8 text-right shrink-0">{Math.round(artifactScale * 100)}%</span>
            </div>
            <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1 leading-snug">Tiles auto-size by shape - drag a tile to resize it.</p>
          </SettingsPopover>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {/* Key by project+agent+name (not just name): switching agents reuses
            this same mounted panel, so a name-only key would let one agent's
            cards keep the previous agent's expand/collapse state (and its save
            effect would then clobber the new agent's saved prefs). Re-keying per
            agent remounts each card so it re-reads that agent's saved state. */}
        {/* Search narrows like the tag filter does - within each card, not by
            removing cards: a card with no match stays put and shows its
            "no files match" empty state when expanded (with its header count
            reflecting the narrowing), rather than vanishing from the list. */}
        <ABControlsContext.Provider value={abControls}>
          {displaySets.map((s) => <ArtifactSetCard key={`${projectId ?? '_'}-${agentId}-${s.name}`} set={s} mode={imageDiffMode} scale={artifactScale} spans={artifactSpans} onSpanChange={onArtifactSpanChange} filter={tagFilter} search={search} onRefresh={requestRefresh} projectId={projectId} agentId={agentId} />)}
        </ABControlsContext.Provider>
      </div>
    </div>
  )
}
