import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../stores/apiClient'
import type { ArtifactSet, ArtifactFile, ArtifactLogLine } from '../api'
import { ArtifactFile as ArtifactFileNS } from '../api'
import { LoaderCircle, Image as ImageIcon, ChevronDown, ChevronRight, TriangleAlert, RefreshCw, ScrollText, SquarePlus, SquareMinus, SquareDot } from 'lucide-react'
import { InfoTooltip } from './InfoTooltip'
import { loadArtifactPrefs, saveArtifactPrefs, loadTagFilter, saveTagFilter, clampChangeThreshold, type ArtifactTagFilter } from '../lib/artifactPrefs'
import { computeVisibleFiles, filterIsActive, effectiveChangeType } from '../lib/artifactFilter'
import { ArtifactFilterBar, TagBadge } from './ArtifactFilterBar'
import { stripAnsi } from '../lib/ansi'
import { type ArtifactSpans, BASE_ARTIFACT_COLUMNS, defaultSpanForAspect } from '../lib/artifactColumns'
import { VideoDiffView, isVideoArtifact, VIDEO_MIN_TILE_PX } from './VideoDiffView'
import { ImageDiffView, SegmentedToggle, ABControlsContext, type ImageDiffMode, type ArtifactABControls } from './ArtifactImageDiff'
import type { LightboxImage } from './ImageLightbox'
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

// Masonry layout constants. The grid always works in BASE_ARTIFACT_COLUMNS columns
// (shared with the repository artifacts view, see lib/artifactColumns), but renders
// fewer when the container is too narrow to keep each base column at least
// BASE_MIN_COL_PX wide. MASONRY_GAP is the inter-column gutter.
const BASE_MIN_COL_PX = 140
const MASONRY_GAP = 12

// Tile reflow animation. An easeOutBack curve (the >1 control point) overshoots
// slightly before settling — the gentle "boing" when a tile snaps to its new column
// span, and the cue that tiles can be moved as siblings ease out of the way. Width
// settles a touch slower than position so the snap reads as deliberate, not abrupt.
// Suppressed on the tile being actively dragged (it tracks the pointer 1:1) and for
// the first beat after mount (so the initial bulk layout doesn't animate in).
const TILE_EASE = 'cubic-bezier(0.34, 1.56, 0.64, 1)'
const TILE_TRANSITION = `left 220ms ${TILE_EASE}, top 220ms ${TILE_EASE}, width 280ms ${TILE_EASE}`

function FileRow({ file, mode, changeThreshold = 0, gallery, index }: {
  file: ArtifactFile; mode: ImageDiffMode; changeThreshold?: number
  // The grid's diff gallery + this file's index in it, so opening an image lets ←/→
  // walk the files and the lightbox shows the comparison (see ImageDiffView). Images only.
  gallery?: LightboxImage[]; index?: number
}) {
  // The badge reflects the *effective* change type, so a modified file gated below
  // the "% changed" threshold shows as unchanged (no badge) — matching how it's
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
            title="Compared by byte hash only — install ffmpeg for frame-accurate video diffs. This “modified” result may be spurious (e.g. only container metadata changed)."
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
        {isVideoArtifact(file.name) ? (
          <VideoDiffView left={file.left_url} right={file.right_url} mode={mode} fps={file.fps} />
        ) : (
          <ImageDiffView left={file.left_url} right={file.right_url} mode={mode} name={file.name} gallery={gallery} index={index} />
        )}
      </div>
    </div>
  )
}

// An artifact's measured intrinsic dimensions: its aspect ratio (width / height)
// drives the default column span, and its natural pixel width lets the grid avoid
// upscaling a low-resolution shot past 1:1 on a high-DPI/large screen (see spanOf).
// dpi is the media's capture density (device-scale factor); pxWidth / dpi is its
// logical width, which is what the grid caps a tile to (see spanOf). 1 when unknown
// (measured client-side, or a server entry without a dpi sidecar) — logical == physical.
export type ArtifactDim = { aspect: number; pxWidth: number; dpi: number }

// useArtifactDims measures each artifact's intrinsic aspect ratio and natural pixel
// width by loading the media off-screen, so the masonry can pick a sensible default
// span (wide → more columns, tall → one) and cap it so the shot is never blown up
// past its own resolution — all without the backend reporting dimensions. Images read
// naturalWidth/Height; videos read videoWidth/Height off a metadata preload. The
// browser caches the fetch, so the visible <img>/<video> doesn't load it twice.
// Returns a key→dims map that fills in as media loads.
export function useArtifactDims(sources: { key: string; url: string | null; video: boolean }[]): Record<string, ArtifactDim> {
  const [dims, setDims] = useState<Record<string, ArtifactDim>>({})
  // A stable signature of the (key,url) set so the effect only re-runs when the
  // media actually changes, not on every render's fresh array.
  const sig = sources.map((s) => `${s.key} ${s.url ?? ''}`).join('|')
  const ref = useRef(sources)
  ref.current = sources
  useEffect(() => {
    let cancelled = false
    const set = (key: string, w: number, h: number) => {
      if (cancelled || !w || !h) return
      // Client-measured bytes carry no density, so dpi is 1 (logical == physical).
      setDims((a) => (a[key] != null ? a : { ...a, [key]: { aspect: w / h, pxWidth: w, dpi: 1 } }))
    }
    for (const s of ref.current) {
      if (!s.url) continue
      if (s.video) {
        const v = document.createElement('video')
        v.preload = 'metadata'
        v.onloadedmetadata = () => set(s.key, v.videoWidth, v.videoHeight)
        v.src = s.url
      } else {
        const img = new Image()
        img.onload = () => set(s.key, img.naturalWidth, img.naturalHeight)
        img.src = s.url
      }
    }
    return () => { cancelled = true }
  }, [sig])
  return dims
}

// useMediaDims resolves each artifact's dimensions, preferring the server-provided
// width/height (already carried in the artifact response — measured once at
// generation time and cached in meta.json, so no download) and falling back to
// measuring the bytes for any file the server didn't size: videos when ffprobe
// wasn't available, or entries cached before the server learned to record sizes.
// Files that already have server dims are excluded from the off-screen measurement,
// so for those the visible <img>'s loading="lazy" survives — a large diff no longer
// eagerly fetches every image up front just to lay out the grid.
export function useMediaDims(
  sources: { key: string; url: string | null; video: boolean; width?: number | null; height?: number | null; dpi?: number | null }[],
): Record<string, ArtifactDim> {
  const serverDims = useMemo(() => {
    const m: Record<string, ArtifactDim> = {}
    for (const s of sources) {
      if (s.width && s.height) m[s.key] = { aspect: s.width / s.height, pxWidth: s.width, dpi: s.dpi && s.dpi > 0 ? s.dpi : 1 }
    }
    return m
  }, [sources])
  const measureSources = useMemo(() => sources.filter((s) => !serverDims[s.key]), [sources, serverDims])
  const measured = useArtifactDims(measureSources)
  return useMemo(() => ({ ...measured, ...serverDims }), [measured, serverDims])
}

// Balanced (shortest-column) masonry. Each tile is absolutely positioned: we
// measure every tile's rendered height with a ResizeObserver, then place tiles one
// by one into whichever run of columns is currently shortest — so they pack tightly
// with minimal trailing gap while keeping a rough left-to-right, top-to-bottom
// reading order (unlike CSS columns, which fill one column top-to-bottom first).
//
// Everything is WIDTH-driven: a tile's width is its (equal-width) column run, and
// the media inside fills that width with its height following the aspect ratio. The
// grid always works in BASE_ARTIFACT_COLUMNS columns (fewer only when the container
// is too narrow). Each tile's span comes from its `aspect` via defaultSpanForAspect
// (scaled by `spanScale` — 2 for side-by-side, whose before/after pair needs the
// room), unless the user has dragged its edge to set an explicit span in `spans`.
export function MasonryGrid({ items, spanScale = 1, scale = 1, spans, onSpanChange, scope }: {
  // bodyResizable defaults to true; set false for tiles whose media owns horizontal
  // drag (the before/after slider, video scrubbing) — those resize via the edge
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
  // a NUL — which can't appear in a file name, agent id or set name, so the
  // composite never collides with a different (scope, name) pair even when either
  // contains slashes or spaces. No scope → the bare file name (legacy global key).
  const spanKey = useCallback((itemKey: string) => (scope ? `${scope} ${itemKey}` : itemKey), [scope])
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  // Measured tile heights, keyed by item key. Updated by the ResizeObserver below.
  const [heights, setHeights] = useState<Record<string, number>>({})
  // The tile currently being edge/body-dragged: its live (continuous, pixel) width
  // so it tracks the pointer instead of jumping column-by-column. The column span is
  // only committed (and siblings only reflow) on release — see startResize.
  const [drag, setDrag] = useState<{ key: string; width: number } | null>(null)
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
  // data-mkey attribute so the observer callback knows which height changed — no
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
  // densely the shot was captured or what display you're viewing on — a 2x capture
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
      // Floor for media whose chrome needs a minimum width — a video's transport
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
  const placement = useMemo(() => {
    const { cols, gap, colW } = layout
    const FALLBACK_H = 240 // assumed height before a tile is first measured
    const bottoms = new Array(cols).fill(0)
    const pos: Record<string, { left: number; top: number; width: number; span: number }> = {}
    for (const it of items) {
      const h = heights[it.key] ?? FALLBACK_H
      const s = spanOf(it)
      // Best start column: minimise the tallest of the columns this tile would cover.
      let bestC = 0
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
  }, [items, heights, layout, spanOf])

  // Set while a body drag (below) is resizing a tile, so the trailing click can be
  // swallowed before the media reacts to it. Holds the key of the tile being dragged.
  const draggedKeyRef = useRef<string | null>(null)

  // Start a live resize from `startSpan`, anchored at pointer `startX`. The tile's
  // width follows the pointer continuously (so it grows *before* it would tip into
  // the next column — it overlaps its neighbours, lifted above them); the span is
  // only quantised and committed on release, when the persisted override updates and
  // the siblings reflow + ease out of the way. Returns move/finish, or null if the
  // grid can't resize right now. `key` is the tile's file name; the override persists
  // under its scoped key (see spanKey).
  const startResize = (key: string, startSpan: number, startX: number) => {
    const unit = layout.colW + layout.gap
    if (unit <= 0 || !onSpanChange) return null
    const startWidth = startSpan * layout.colW + (startSpan - 1) * layout.gap
    const minW = layout.colW
    const maxW = layout.cols * layout.colW + (layout.cols - 1) * layout.gap
    let finalSpan = startSpan
    const move = (clientX: number) => {
      const w = Math.max(minW, Math.min(maxW, startWidth + (clientX - startX)))
      finalSpan = Math.max(1, Math.min(layout.cols, Math.round((w + layout.gap) / unit)))
      setDrag({ key, width: w })
    }
    const finish = () => {
      setDrag(null)
      onSpanChange(spanKey(key), finalSpan)
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
    const onMove = (ev: PointerEvent) => ctl.move(ev.clientX)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      ctl.finish()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Body resize: drag horizontally on a tile's media (the region the node marks with
  // data-tile-drag) to grow or shrink its span. Starting on the card chrome — the file
  // name, badges, padding — does nothing, so click-dragging to select the name no
  // longer enlarges the tile. A plain click/tap on the media falls through to its own
  // gesture (flip, open) — we only take over once the pointer moves decisively
  // horizontally past a small threshold, then swallow the trailing click so the media
  // doesn't also react. Touch keeps vertical panning (touch-action: pan-y) so the page
  // scrolls.
  const startBodyResize = (key: string, startSpan: number) => (e: React.PointerEvent) => {
    if (e.button !== 0 || !onSpanChange) return
    // Only the media drags; the card header/padding is left alone (text-selectable).
    if (!(e.target instanceof Element) || !e.target.closest('[data-tile-drag]')) return
    // …but never hijack an interactive control that owns its own horizontal drag — the
    // onion-skin opacity slider (an <input type="range">) lives inside the media region,
    // and dragging it must move the slider, not resize the tile. `data-no-tile-drag` is
    // the general escape hatch for any such control.
    if (e.target.closest('input, [data-no-tile-drag]')) return
    draggedKeyRef.current = null // reset any stale value from a drag that produced no click
    const startX = e.clientX
    const startY = e.clientY
    let ctl: ReturnType<typeof startResize> = null
    const onMove = (ev: PointerEvent) => {
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
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      ctl?.finish()
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
  }

  // After a body drag, eat the click it would otherwise turn into (capture phase, so
  // it never reaches the media's own onClick / link navigation).
  const swallowDragClick = (key: string) => (e: React.MouseEvent) => {
    if (draggedKeyRef.current !== key) return
    e.preventDefault()
    e.stopPropagation()
    draggedKeyRef.current = null
  }

  const canResize = !!onSpanChange && layout.cols > 1
  return (
    <div ref={containerRef} className="relative w-full" style={{ height: placement.height }}>
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
              // While dragging this tile, render its live pointer-tracked width and
              // lift it above its neighbours (it overflows its column run); otherwise
              // its placed span width. The transition eases the snap-back + sibling
              // reflow once released — off during the drag so it tracks the pointer.
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
function FileGrid({ files, mode, scale = 1, spans, onSpanChange, scope, changeThreshold = 0 }: {
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
    () => files.map((f) => ({
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
  // and the current comparison mode — so opening any image lets ←/→ walk the files and
  // the lightbox shows the same comparison. A file with no image at all is skipped, so
  // it has no index and falls back to opening the single clicked image. `url` is the
  // representative side, used for the lightbox's edge previews.
  const imageFiles = useMemo(
    () => files.filter((f) => !isVideoArtifact(f.name) && (f.left_url || f.right_url)),
    [files],
  )
  const diffGallery = useMemo<LightboxImage[]>(
    () => imageFiles.map((f) => ({
      url: (f.right_url ?? f.left_url) as string,
      filename: f.name,
      size: 0,
      diff: { left: f.left_url, right: f.right_url, mode },
      dpi: f.dpi ?? undefined,
    })),
    [imageFiles, mode],
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
      aspect: dims[f.name]?.aspect,
      pxWidth: dims[f.name]?.pxWidth,
      dpi: dims[f.name]?.dpi,
      // Videos need a minimum tile width for their transport controls (see
      // VIDEO_MIN_TILE_PX); images have no such chrome.
      minWidthPx: isVideoArtifact(f.name) ? VIDEO_MIN_TILE_PX : undefined,
      // The slider mode and video both use horizontal drag on the media for their own
      // gesture, so let those resize via the edge handle only — see MasonryGrid's
      // bodyResizable. Other images resize by dragging the media (data-tile-drag).
      bodyResizable: mode !== 'slider' && !isVideoArtifact(f.name),
    })),
    [files, mode, dims, changeThreshold, diffGallery, galleryIndex],
  )
  // pt-3 so the gap above the first row matches the card body's px-3 left inset.
  return (
    <div className="pt-3">
      <MasonryGrid items={items} spanScale={spanScale} scale={scale} spans={spans} onSpanChange={onSpanChange} scope={scope} />
    </div>
  )
}

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

// The card header's action buttons (build log + regenerate) sit as faint icons at
// rest and brighten ONLY the icon the pointer is actually over — a per-button
// `hover:` (not a shared `group-hover:`), with no border or background. So hovering
// one button no longer lights up its neighbour or boxes the whole cluster; it just
// darkens that one icon. MELT_BTN is the shared resting+hover skin; per-button
// classes add the rounding/layout on top.
const MELT_BTN = 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 transition-colors cursor-pointer'

function ArtifactSetCard({ set, mode, scale, spans, onSpanChange, filter, search, onRefresh, projectId, agentId }: { set: ArtifactSet; mode: ImageDiffMode; scale: number; spans: ArtifactSpans; onSpanChange: (key: string, span: number | null) => void; filter: ArtifactTagFilter; search: string; onRefresh: (name: string, side?: ArtifactSide) => void; projectId: string | null; agentId: string }) {
  const status = set.status as string
  // Apply the (shared) tag filter and the search query to this card's files. The
  // grid shows only matches — ranked by search score when searching; the header
  // still reports the true diff size so "x/y changed" makes it obvious some are
  // hidden.
  const isFiltered = filterIsActive(filter)
  const searching = search.trim().length > 0
  const narrowed = isFiltered || searching
  const changeThreshold = clampChangeThreshold(filter.changeThreshold)

  // Which side(s) failed. A whole-set "error" status means both sides failed (or
  // the set couldn't be loaded at all); a "ready" set with a single side_error is
  // a partial failure — the other side rendered. Either way the failing side's
  // build log is the error surface (its stderr is the detail), so we mark it and
  // show its red-bordered terminal rather than a separate error box.
  const leftFailed = status === 'error' || !!set.left_error
  const rightFailed = status === 'error' || !!set.right_error
  // The mirror of *Failed: a side that settled cleanly (it produced a build log and
  // didn't error) gets a green-bordered terminal, matching the red one for failures.
  const leftSucceeded = !leftFailed && !!set.left_log_url
  const rightSucceeded = !rightFailed && !!set.right_log_url
  // One side failed while the other rendered (status stays "ready").
  const failedSide: 'left' | 'right' | null = status !== 'error' && set.left_error ? 'left' : status !== 'error' && set.right_error ? 'right' : null

  // When one side failed, the surviving side's files would each surface as
  // added/removed (the failed side contributes none), exploding the card into a
  // pile of one-sided "changes" for a comparison we never actually made. Present
  // them as unchanged instead, so the default change filter hides them and the
  // card stays calm — the failure is already surfaced by the red-bordered
  // build-log terminal and the header chip, not a flood of fake diffs.
  const cardFiles = useMemo(
    () => (failedSide ? set.files.map((f) => ({ ...f, change_type: ArtifactFileNS.change_type.UNCHANGED })) : set.files),
    [set.files, failedSide],
  )

  const visibleFiles = computeVisibleFiles(cardFiles, filter, search)
  // "changed" counts honour the change-type threshold, so a sub-threshold tweak
  // doesn't inflate the "x/y changed" header (see effectiveChangeType).
  const changedFiles = visibleFiles.filter((f) => effectiveChangeType(f, changeThreshold) !== 'unchanged')
  const totalChanged = cardFiles.filter((f) => effectiveChangeType(f, changeThreshold) !== 'unchanged').length
  const changedLabel = narrowed && changedFiles.length !== totalChanged ? `${changedFiles.length}/${totalChanged} changed` : `${totalChanged} changed`
  // A partial failure isn't a "visual change" — the surviving side's files are
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
  // hitting refresh after a failure) and the refresh button is always reachable —
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
  // ALWAYS shows it (its red-bordered stderr is the failure detail) — the user can't
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

  // No overflow-hidden on the card root: a clipping ancestor would break the
  // sticky header below (it'd be trapped in the card instead of pinning to the
  // page). The header carries its own overflow-hidden + rounding so the corners
  // still read as one rounded card; the body's corners are the root's own rounded bg.
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800">
      {/* Give the header a resting tint that's distinct from the card body
          (bg-white / dark:bg-gray-800) on its own, not only on hover. Solid (not a
          translucent gray-700/40) so it stays opaque when stuck — the card's images
          scroll underneath it. Sticky: pin this header just below the Artifacts
          filter bar while the card's grid scrolls, releasing when the card ends.
          top-15 tucks a few px behind the filter bar's bottom edge (its z-20 covers
          the overlap) so the bars read as flush with no content peeking between.
          z-10 sits below the filter bar (z-20). rounded-b-lg only while collapsed,
          when the header IS the whole (rounded) card. */}
      <div className={`sticky top-15 z-10 flex items-stretch overflow-hidden bg-gray-100 dark:bg-gray-700 rounded-t-lg ${collapsed ? 'rounded-b-lg' : ''}`}>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer text-left"
        >
          {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
          <ImageIcon className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400 shrink-0" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate shrink-0">{set.name}</span>
          {status === 'generating' && (
            // Live header: spinner, the latest stdout line as progress (truncated so
            // it can't push the refresh button off the row), then how long the job
            // has been running, separated by a "·". Expand the card for the full log.
            <span className="flex items-center gap-1.5 min-w-0 text-xs text-gray-400 dark:text-gray-500">
              <LoaderCircle className="w-3 h-3 shrink-0 animate-spin" />
              <span className="truncate">{progressText || 'generating…'}</span>
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
        </button>
        {/* Faint icon buttons, vertically centred in the stretch-height header.
            Each brightens only on its own hover (see MELT_BTN) — no shared group
            hover, so they don't light up together. */}
        <div className="shrink-0 flex items-center gap-1.5 pl-1 pr-2">
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
        </div>
      </div>

      {!collapsed && (
        <div className="px-3 pb-2">
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
            // unchanged by default — see the header "changes" dropdown) laid out in
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
                  The {failedSide === 'left' ? 'before' : 'after'} side failed to render — showing the {failedSide === 'left' ? 'after' : 'before'} side only.
                </div>
              )}
              {cardFiles.length === 0 ? (
                <div className="my-2 text-xs text-gray-400 dark:text-gray-500">No artifacts produced.</div>
              ) : visibleFiles.length === 0 ? (
                <div className="my-2 text-xs text-gray-400 dark:text-gray-500">
                  {failedSide
                    ? `Only the ${failedSide === 'left' ? 'after' : 'before'} side rendered — its ${cardFiles.length} file${cardFiles.length === 1 ? '' : 's'} ${cardFiles.length === 1 ? 'is' : 'are'} hidden as unchanged (nothing to compare). Show "unchanged" in the changes filter to view ${cardFiles.length === 1 ? 'it' : 'them'}.`
                    : `No files match ${searching ? 'your search' : 'the current filters'}.`}
                </div>
              ) : (
                <FileGrid files={visibleFiles} mode={mode} scale={scale} spans={spans} onSpanChange={onSpanChange} scope={`${agentId}/${set.name}`} changeThreshold={changeThreshold} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
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

export function ArtifactsPanel({ projectId, agentId, baseRef, headRef, includeUncommitted, refreshKey, imageDiffMode, artifactScale, artifactView, onArtifactViewChange, artifactHighlight, onArtifactHighlightChange, artifactSpans, onArtifactSpanChange }: {
  projectId: string | null
  agentId: string
  baseRef?: string
  headRef?: string
  includeUncommitted?: boolean
  refreshKey: number
  imageDiffMode: ImageDiffMode
  // Global tile-size multiplier (diff settings size slider), forwarded to every card.
  artifactScale: number
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

  // Tag filter, shared across every card for this agent. Reload it when the
  // project/agent changes; persist it only on an explicit user change (a save
  // effect would race the reload and clobber the new key with the old value).
  const [tagFilter, setTagFilter] = useState<ArtifactTagFilter>(() => loadTagFilter(projectId, agentId))
  useEffect(() => { setTagFilter(loadTagFilter(projectId, agentId)) }, [projectId, agentId])

  // Free-text search over filenames + tags (split-word fuzzy match + rank). Kept
  // ephemeral — it narrows/ranks the view without persisting — and cleared when the
  // project/agent changes since this panel is reused across agents.
  const [search, setSearch] = useState('')
  useEffect(() => { setSearch('') }, [projectId, agentId])
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

  // Keyboard: B flips before/after, H toggles highlight — only in A/B mode, and never
  // while typing in a field. Plain single keys (no modifiers) so they don't collide
  // with browser chords like Ctrl+H.
  useEffect(() => {
    if (imageDiffMode !== 'ab') return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      const k = e.key.toLowerCase()
      if (k === 'b') { e.preventDefault(); onArtifactViewChange(artifactView === 'before' ? 'after' : 'before') }
      else if (k === 'h') { e.preventDefault(); onArtifactHighlightChange(!artifactHighlight) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [imageDiffMode, artifactView, artifactHighlight, onArtifactViewChange, onArtifactHighlightChange])

  // Apply a server→client WS message to local state.
  const applyMessage = useCallback((msg: ArtifactWSMessage) => {
    setError(null)
    if (msg.type === 'snapshot') {
      setSets(msg.scripts ?? [])
    } else if (msg.type === 'set') {
      setSets((prev) => (prev ? prev.map((s) => (s.name === msg.set.name ? msg.set : s)) : [msg.set]))
    } else if (msg.type === 'log') {
      setSets((prev) => prev?.map((s) => {
        if (s.name !== msg.script) return s
        return msg.side === 'left'
          ? { ...s, left_log: [...(s.left_log ?? []), msg.line] }
          : { ...s, right_log: [...(s.right_log ?? []), msg.line] }
      }) ?? prev)
    } else if (msg.type === 'progress') {
      setSets((prev) => prev?.map((s) => {
        if (s.name !== msg.script) return s
        return msg.side === 'left' ? { ...s, left_progress: msg.progress } : { ...s, right_progress: msg.progress }
      }) ?? prev)
    }
  }, [])

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
      ws.onclose = null
      ws.close()
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
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    clear()
    tick(true)
    return () => { cancelled = true; clear() }
  }, [mode, projectId, agentId, baseRef, headRef, includeUncommitted, refreshKey, refreshNonce])

  const requestRefresh = useCallback((name: string, side?: ArtifactSide) => {
    // Optimistically flip the card to a fresh "generating" state so the spinner,
    // a zeroed elapsed clock and an empty log show immediately. A per-side refresh
    // only zeroes that side — the other keeps its existing log/progress so it isn't
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

  // Every file across all sets, flattened — fed to the filter bar so it can derive
  // the offered tags/types and per-value counts itself (see ArtifactFilterBar).
  const allFiles = useMemo(() => (sets ?? []).flatMap((s) => s.files), [sets])
  // Tags a side exposes before its set finishes (pending_tags), so the filter
  // appears as soon as we know what tags there are likely to be.
  const pendingTags = useMemo(() => (sets ?? []).flatMap((s) => s.pending_tags ?? []), [sets])

  if (error) {
    return (
      <div className="mb-4 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400">
        Failed to load artifacts: {error}
      </div>
    )
  }
  // Render nothing until we know there are configured scripts.
  if (!sets || sets.length === 0) return null

  // Generation progress (#38): how many artifact scripts have settled (ready or
  // failed) versus how many are still generating. Shown only while work is in
  // flight; WS pushes (or the poll above) keep it ticking until everything settles.
  const generatingCount = sets.filter((s) => (s.status as string) === 'generating').length
  const settledCount = sets.length - generatingCount

  return (
    <div className="mb-4">
      {/* Reserve the filter bar's height (its segmented controls / chips are
          taller than the bare title) so the header stays the same height whether
          or not tags are present — the filter loading in must not jump the layout. */}
      {/* Sticky: dock this Artifacts header + filters just below the Changes bar
          (which sticks at the top) while the cards scroll under it, then release
          once the whole panel scrolls past into the file diffs. top-6 sits a few px
          under the stuck Changes bar's bottom edge — slightly tucked behind it (the
          Changes bar's z-30 covers the overlap) so there's no seam of scrolling
          content peeking between the two bars. z-20 sits below the Changes bar but
          above the cards (whose headers stick at z-10). Needs an opaque bg (matching
          the page) so cards scroll cleanly underneath, and -mx-1/px-1 bleeds it to
          the same width as the Changes bar. */}
      <div className="sticky top-6 z-20 flex flex-wrap items-center gap-2 mb-2 min-h-[1.625rem] bg-gray-50 dark:bg-gray-900 -mx-1 px-1 py-1.5 border-b border-gray-200 dark:border-gray-800 shadow-sm">
        <ImageIcon className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
        <h3 className="text-xs font-semibold tracking-wide text-gray-500 dark:text-gray-400">Artifacts</h3>
        {generatingCount > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] font-normal text-gray-400 dark:text-gray-500">
            <LoaderCircle className="w-3 h-3 animate-spin" />
            Generating {settledCount}/{sets.length}
          </span>
        )}
        <InfoTooltip title="Artifacts" width={560}>
          <p>Artifacts are visual snapshots — typically screenshots, or videos (screen recordings) — rendered from your code so you can see what a change <em>looks like</em>, side by side with the base branch.</p>
          <p>Each one is produced by a project-defined <strong>artifact script</strong>. Hydra checks out both the base ref and the head ref (or your uncommitted working tree), runs the script against each with <code className="text-blue-300">$HYDRA_ARTIFACT_OUTPUT</code>, <code className="text-blue-300">$HYDRA_ARTIFACT_SOURCE</code> and <code className="text-blue-300">$HYDRA_ARTIFACT_REF</code> set, and compares the images it writes. Results are cached per commit, so re-viewing a diff is free.</p>
          <p>Configure them in <code className="text-blue-300">.hydra/config.toml</code> with <code className="text-blue-300">[[artifacts]]</code> blocks (<code className="text-blue-300">name</code>, <code className="text-blue-300">command</code>, optional <code className="text-blue-300">timeout_sec</code>) — for example a script that builds the app and screenshots a page, so visual UI changes show up here in the diff viewer.</p>
          <p><strong>Images &amp; video.</strong> <code className="text-blue-300">.png .jpg .gif</code> are diffed pixel-by-pixel (so cosmetic re-encodes are ignored); <code className="text-blue-300">.webm</code> video is diffed frame-by-frame when <strong>ffmpeg</strong> is installed, falling back to a byte-hash comparison otherwise (shown with a <em>byte-compared</em> badge, since that verdict may be spurious). Other types — <code className="text-blue-300">.webp .avif .svg .bmp .pdf</code> — are byte-hash compared. Encode video as <strong>lossless</strong> <code className="text-blue-300">.webm</code> (e.g. <code className="text-blue-300">ffmpeg … -c:v libvpx-vp9 -lossless 1</code>) so identical frames stay identical.</p>
          <p>A script with no visual changes — or one still generating — collapses to a single header row; click it to expand. The two sides (base and head) build in parallel, so the expanded card shows their <strong>build logs side by side</strong> (Before / After, stderr in red); once finished, reopen them any time with the <strong>build log</strong> button (the scroll icon next to refresh in the card header). The refresh button beside it re-runs a script — handy to retry a failure or re-render even when nothing visibly changed.</p>
          <p>The header shows each side's latest <code className="text-blue-300">stdout</code> line as live progress. To surface a cleaner message, print a line prefixed with <code className="text-blue-300">::hydra:progress::</code> (e.g. <code className="text-blue-300">echo "::hydra:progress:: capturing home 3/24"</code>) — Hydra strips the prefix, shows the rest as the progress line, and from then on ignores ordinary <code className="text-blue-300">stdout</code> for the header, so a noisy build can't hijack it. The full output still lands in the build log.</p>
          <p><strong>Tags &amp; filter.</strong> Alongside an image <code className="text-blue-300">home.png</code> the script can write a JSON sidecar <code className="text-blue-300">home.png.meta</code> like <code className="text-blue-300">{'{'}"tags": ["theme::dark", "viewport::phone"]{'}'}</code>. Tags show as labels on each file and as a filter on this bar. The sidecar can also carry an optional <code className="text-blue-300">dpi</code> (the device-scale factor the shot was captured at, e.g. <code className="text-blue-300">{'{'}"dpi": 2{'}'}</code>) — the grid then sizes a tile by its <em>logical</em> width (pixels / dpi), so a 2× shot lays out like a 1× one, just sharper. For a video, an optional <code className="text-blue-300">fps</code> (e.g. <code className="text-blue-300">{'{'}"fps": 60{'}'}</code>) sets the frame rate the frame-step buttons use, since HTML5 video exposes none of its own. A <code className="text-blue-300">category::value</code> tag is a <em>scoped</em> label — only one value per category is kept on a file (the last wins), and each category gets a filter button listing its values. Every value starts <em>on</em>; uncheck one to hide the files carrying it, or use <strong>all</strong> / <strong>clear</strong> (top of the menu) to toggle them in bulk. Shift-click a value to isolate it (hide everything else). Each value also shows a dimmed count on the right — how many items carry it under your current filters (ignoring this scope itself). Plain tags work the same way under a "tags" button. Handy when a script emits many shots (light/dark, phone/desktop) and you want to see just one slice. Two built-in filters are always present: a <strong>type</strong> filter (image / video, from each file's extension) and a <strong>changes</strong> filter (added / removed / modified / unchanged, from each file's diff state) — the latter always offers all four kinds even when none are present, and hides unchanged files by default, so use it to reveal them or to focus on one kind of change.</p>
        </InfoTooltip>
        {/* Right cluster: the global A/B before/after + highlight controls (only
            meaningful in A/B mode, where each tile shows one side at a time), then
            the shared filter bar. ml-auto floats the whole cluster to the right. */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {imageDiffMode === 'ab' && (
            <div className="flex items-center gap-1.5">
              <span title="Show every tile's before / after — shortcut: B">
                <SegmentedToggle
                  value={artifactView}
                  onChange={onArtifactViewChange}
                  options={[{ value: 'before', label: 'Before' }, { value: 'after', label: 'After' }]}
                />
              </span>
              <label
                title="Highlight changed pixels in magenta on every tile — shortcut: H"
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
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {/* Key by project+agent+name (not just name): switching agents reuses
            this same mounted panel, so a name-only key would let one agent's
            cards keep the previous agent's expand/collapse state (and its save
            effect would then clobber the new agent's saved prefs). Re-keying per
            agent remounts each card so it re-reads that agent's saved state. */}
        {/* Search narrows like the tag filter does — within each card, not by
            removing cards: a card with no match stays put and shows its
            "no files match" empty state when expanded (with its header count
            reflecting the narrowing), rather than vanishing from the list. */}
        <ABControlsContext.Provider value={abControls}>
          {sets.map((s) => <ArtifactSetCard key={`${projectId ?? '_'}-${agentId}-${s.name}`} set={s} mode={imageDiffMode} scale={artifactScale} spans={artifactSpans} onSpanChange={onArtifactSpanChange} filter={tagFilter} search={search} onRefresh={requestRefresh} projectId={projectId} agentId={agentId} />)}
        </ABControlsContext.Provider>
      </div>
    </div>
  )
}
