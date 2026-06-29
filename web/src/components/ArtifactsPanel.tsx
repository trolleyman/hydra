import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '../stores/apiClient'
import type { ArtifactSet, ArtifactFile, ArtifactLogLine } from '../api'
import { ArtifactFile as ArtifactFileNS } from '../api'
import { LoaderCircle, Image as ImageIcon, ImageOff, ChevronDown, ChevronRight, TriangleAlert, RefreshCw, ScrollText, SquarePlus, SquareMinus, SquareDot } from 'lucide-react'
import { InfoTooltip } from './InfoTooltip'
import { loadArtifactPrefs, saveArtifactPrefs, loadTagFilter, saveTagFilter, clampChangeThreshold, type ArtifactTagFilter } from '../lib/artifactPrefs'
import { computeVisibleFiles, filterIsActive, effectiveChangeType } from '../lib/artifactFilter'
import { ArtifactFilterBar, TagBadge } from './ArtifactFilterBar'
import { stripAnsi } from '../lib/ansi'
import { useIsDark } from '../lib/theme'
import {
  checkerStyle, IMG_CLASS, OVERLAY_CLASS, TAG_CLASS, makeAuxOpen,
  DIFF_COLOR, DIFF_PIXEL_THRESHOLD, DIFF_ALPHA,
} from './artifactDiffShared'
import { useImageLightbox } from '../stores/imageLightboxStore'
import type { LightboxImage } from './ImageLightbox'
import { type ArtifactSpans, BASE_ARTIFACT_COLUMNS, defaultSpanForAspect } from '../lib/artifactColumns'
import { VideoDiffView, isVideoArtifact, VIDEO_MIN_TILE_PX } from './VideoDiffView'

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

// The ways to compare a before/after image pair. Persisted in the diff viewer's
// settings; see DiffViewer's SettingsPopup. (The magenta pixel-diff isn't a mode of
// its own any more — it's a "Highlight" checkbox that overlays the changes on the
// Before/After view.)
export type ImageDiffMode = 'side-by-side' | 'ab' | 'slider' | 'onion'

export const IMAGE_DIFF_MODES: { value: ImageDiffMode; label: string }[] = [
  { value: 'ab', label: 'Before · After' },
  { value: 'slider', label: 'Before · After (slider)' },
  { value: 'side-by-side', label: 'Side by side' },
  { value: 'onion', label: 'Onion skin' },
]

// Masonry layout constants. The grid always works in BASE_ARTIFACT_COLUMNS columns
// (shared with the repository artifacts view, see lib/artifactColumns), but renders
// fewer when the container is too narrow to keep each base column at least
// BASE_MIN_COL_PX wide. MASONRY_GAP is the inter-column gutter.
const BASE_MIN_COL_PX = 140
const MASONRY_GAP = 12

// A single artifact image as a lightbox entry; size is unknown here (the diff
// viewer doesn't carry byte sizes) so it's left out of the caption.
function lightboxImage(url: string, name: string): LightboxImage {
  return { url, filename: name, size: 0 }
}

function ImageCell({ url, label, name }: { url?: string | null; label: string; name: string }) {
  const openImage = useImageLightbox()
  return (
    // flex-1 min-w-0 so the two cells split their row evenly and the width-driven
    // images (w-full) each fill their half.
    <div className="flex-1 min-w-0">
      <div className="text-[10px] font-semibold tracking-wide text-gray-400 dark:text-gray-500 mb-1">{label}</div>
      {url ? (
        // A plain click opens the image in the fullscreen lightbox. The image fills
        // the cell width (w-full) and its height follows the aspect ratio.
        <button
          type="button"
          onClick={() => openImage([lightboxImage(url, name)])}
          className="block w-full cursor-zoom-in"
        >
          <img
            src={url}
            loading="lazy"
            draggable={false}
            style={checkerStyle}
            className={IMG_CLASS}
          />
        </button>
      ) : (
        // No image on this side (the file was added or removed). Render a panel of
        // similar visual weight to the present image — same framing, a clear "No
        // image" empty state — rather than a tiny dashed box, so the added/removed
        // (none↔image) layout doesn't look lopsided next to its counterpart.
        // select-none so rapid clicking near it never highlights the label text.
        <div className="select-none flex flex-col items-center justify-center gap-1 w-full h-32 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-gray-400 dark:text-gray-500">
          <ImageOff className="w-5 h-5" />
          <span className="text-[11px] font-medium">No image</span>
        </div>
      )}
    </div>
  )
}

// A stacked layer for the overlay comparison modes: the image when present, or a
// "No image" placeholder filling the same box when this side is absent (an
// added/removed file). Keeping a placeholder layer — rather than dropping to a
// side-by-side pair — lets the overlay modes preserve their own layout (the A/B
// buttons, the slider handle, the opacity blend) when only one side exists.
function LayerNode({ url, style }: { url?: string | null; style?: React.CSSProperties }) {
  if (url) {
    return <img src={url} style={{ ...checkerStyle, ...style }} className={OVERLAY_CLASS} draggable={false} />
  }
  return (
    <div style={style} className={`${OVERLAY_CLASS} select-none flex flex-col items-center justify-center gap-1 bg-gray-50 dark:bg-gray-800/50 text-gray-400 dark:text-gray-500`}>
      <ImageOff className="w-5 h-5" />
      <span className="text-[11px] font-medium">No image</span>
    </div>
  )
}

// SegmentedToggle is the small grouped "pill" selector (e.g. Before / After) — the
// compact twin of the settings page's theme/agent segmented controls: a padded track
// with the active option raised as a white pill. Shared with VideoDiffView.
export function SegmentedToggle<T extends string>({ value, onChange, options }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="inline-flex rounded-md border border-gray-200 dark:border-gray-700 p-0.5 bg-gray-50 dark:bg-gray-900/40">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`px-2 py-0.5 rounded text-[10px] font-medium tracking-wide transition-colors cursor-pointer ${
            value === o.value
              ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// A/B switch: Before / After, with a Highlight checkbox. Before & After stay
// mounted and stacked, so the toggle flips which is shown for an instant,
// flicker-free hard switch. Clicking the image (or the buttons) flips Before↔After.
// Ticking Highlight overlays the pixel-diff (every changed pixel tinted semi-
// transparent magenta, see DiffCanvas) on top of whichever side is shown, so the
// changes stay marked — yet still readable underneath — as you flip Before↔After. Highlight is disabled when only one side
// exists (an added/removed file — there's nothing to diff). A missing side shows
// the "No image" placeholder; middle-click opens the currently-shown image in the
// fullscreen lightbox.
function ABSwitch({ left, right, name }: { left?: string | null; right?: string | null; name: string }) {
  const openImage = useImageLightbox()
  const canDiff = !!left && !!right
  const [view, setView] = useState<'before' | 'after'>('after')
  const [highlight, setHighlight] = useState(false)
  const showHighlight = highlight && canDiff
  // At least one side is present (ImageDiffView only routes here otherwise); the
  // present image is the invisible sizer that gives the stacked box its size.
  const sizer = (right ?? left) as string
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1 mb-1">
        <SegmentedToggle
          value={view}
          onChange={setView}
          options={[{ value: 'before', label: 'Before' }, { value: 'after', label: 'After' }]}
        />
        <label
          title={canDiff ? 'Highlight changed pixels in magenta' : 'Needs both a before and after image'}
          className={`ml-auto flex items-center gap-1 text-[10px] font-medium tracking-wide select-none ${
            canDiff ? 'cursor-pointer text-gray-500 dark:text-gray-400' : 'opacity-40 cursor-not-allowed text-gray-400 dark:text-gray-500'
          }`}
        >
          <input
            type="checkbox"
            checked={showHighlight}
            disabled={!canDiff}
            onChange={(e) => setHighlight(e.target.checked)}
            className="accent-blue-500 cursor-pointer disabled:cursor-not-allowed"
          />
          Highlight
        </label>
      </div>
      {/* select-none: flipping is a rapid click target, so without this a quick
          double-click would highlight the "No image" placeholder text. */}
      <div
        className="relative w-full cursor-pointer select-none"
        onClick={() => setView((v) => (v === 'before' ? 'after' : 'before'))}
        onAuxClick={makeAuxOpen(() => (view === 'before' ? left : right) || sizer, (url) => openImage([lightboxImage(url, name)]))}
      >
        <img src={sizer} style={{ visibility: 'hidden' }} className={`${IMG_CLASS} block`} draggable={false} />
        <LayerNode url={right} style={{ visibility: view === 'before' ? 'hidden' : 'visible' }} />
        <LayerNode url={left} style={{ visibility: view === 'before' ? 'visible' : 'hidden' }} />
        {showHighlight && <DiffCanvas left={left as string} right={right as string} />}
      </div>
    </div>
  )
}

// Before/after slider: "after" is the base layer; "before" sits on top, clipped to
// the region left of the draggable handle, giving a sharp (hard-cut) boundary. A
// missing side shows the "No image" placeholder in its slot. Middle-click opens
// whichever side is currently visible under the cursor in the fullscreen lightbox.
function SliderCompare({ left, right, name }: { left?: string | null; right?: string | null; name: string }) {
  const openImage = useImageLightbox()
  const [pos, setPos] = useState(50)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const sizer = (right ?? left) as string

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
      className="relative w-full select-none touch-none cursor-ew-resize"
      onPointerDown={(e) => {
        if (e.button !== 0) return // leave middle/right for the new-tab handler
        setDragging(true)
        update(e.clientX)
      }}
      onAuxClick={makeAuxOpen((e) => {
        const el = ref.current
        if (!el) return sizer
        const r = el.getBoundingClientRect()
        const x = ((e.clientX - r.left) / r.width) * 100
        return (x < pos ? left : right) || sizer
      }, (url) => openImage([lightboxImage(url, name)]))}
    >
      <span className={`${TAG_CLASS} left-1`}>Before</span>
      <span className={`${TAG_CLASS} right-1`}>After</span>
      <img src={sizer} style={{ visibility: 'hidden' }} className={`${IMG_CLASS} block`} draggable={false} />
      <LayerNode url={right} />
      <LayerNode url={left} style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
      <div className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)] pointer-events-none" style={{ left: `${pos}%` }}>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white shadow ring-1 ring-black/30" />
      </div>
    </div>
  )
}

// Onion skin: "before" is the base layer with "after" blended over it; the range
// slider controls the opacity of the "after" image (0 = before, 1 = after). A
// missing side shows the "No image" placeholder in its slot. Middle-click opens
// the side currently weighted by the blend in the fullscreen lightbox.
function OnionCompare({ left, right, name }: { left?: string | null; right?: string | null; name: string }) {
  const openImage = useImageLightbox()
  const [opacity, setOpacity] = useState(50)
  const sizer = (right ?? left) as string
  return (
    <div className="min-w-0">
      <div
        className="relative w-full select-none"
        onAuxClick={makeAuxOpen(() => (opacity >= 50 ? right : left) || sizer, (url) => openImage([lightboxImage(url, name)]))}
      >
        <img src={sizer} style={{ visibility: 'hidden' }} className={`${IMG_CLASS} block`} draggable={false} />
        <LayerNode url={left} />
        <LayerNode url={right} style={{ opacity: opacity / 100 }} />
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[10px] font-semibold tracking-wide text-gray-400 dark:text-gray-500">Before</span>
        <input
          type="range" min={0} max={100} value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          className="flex-1 accent-blue-500 cursor-pointer"
        />
        <span className="text-[10px] font-semibold tracking-wide text-gray-400 dark:text-gray-500">After</span>
      </div>
    </div>
  )
}

// loadImage resolves to a decoded <img> for a same-origin artifact URL, so the
// difference view can read its pixels off a canvas without tainting it.
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`failed to load ${url}`))
    img.src = url
  })
}

// DiffCanvas paints a transparent overlay in which every pixel that differs
// between the before/after images is bright magenta and unchanged pixels are left
// clear, so it can sit on top of whichever side (Before or After) is currently
// shown and mark the changes without hiding the underlying image. The two are
// aligned at the top-left and compared over the union of their bounds, so a size
// change (or pixels present on only one side) reads as a difference too. It only
// runs with both sides present; the caller handles the single-side case.
// Same-origin artifact URLs keep the scratch canvases untainted so getImageData
// works. The overlay is pointer-events-none so the click-to-flip gesture on the
// wrapper still works through it.
function DiffCanvas({ left, right }: { left: string; right: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    Promise.all([loadImage(left), loadImage(right)])
      .then(([la, ra]) => {
        if (cancelled) return
        const canvas = ref.current
        if (!canvas) return
        const w = Math.max(la.naturalWidth, ra.naturalWidth)
        const h = Math.max(la.naturalHeight, ra.naturalHeight)
        if (w === 0 || h === 0) { setState('error'); return }
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) { setState('error'); return }

        // Read each image's pixels off its own scratch canvas, then build a
        // transparent overlay where only the differing pixels are painted magenta.
        const read = (img: HTMLImageElement): Uint8ClampedArray | null => {
          const s = document.createElement('canvas')
          s.width = w
          s.height = h
          const sctx = s.getContext('2d', { willReadFrequently: true })
          if (!sctx) return null
          sctx.drawImage(img, 0, 0)
          return sctx.getImageData(0, 0, w, h).data
        }
        const before = read(la)
        const after = read(ra)
        if (!before || !after) { setState('error'); return }

        const overlay = ctx.createImageData(w, h)
        const out = overlay.data
        for (let i = 0; i < out.length; i += 4) {
          const d =
            Math.abs(after[i] - before[i]) +
            Math.abs(after[i + 1] - before[i + 1]) +
            Math.abs(after[i + 2] - before[i + 2]) +
            Math.abs(after[i + 3] - before[i + 3])
          if (d > DIFF_PIXEL_THRESHOLD) {
            out[i] = DIFF_COLOR[0]
            out[i + 1] = DIFF_COLOR[1]
            out[i + 2] = DIFF_COLOR[2]
            out[i + 3] = DIFF_ALPHA
          }
        }
        ctx.putImageData(overlay, 0, 0)
        setState('ready')
      })
      .catch(() => { if (!cancelled) setState('error') })
    return () => { cancelled = true }
  }, [left, right])

  return (
    <>
      <canvas
        ref={ref}
        className={`${OVERLAY_CLASS} pointer-events-none ${state === 'ready' ? '' : 'opacity-0'}`}
      />
      {state !== 'ready' && (
        <span className={`${TAG_CLASS} right-1`}>{state === 'error' ? 'Diff failed' : 'Diffing…'}</span>
      )}
    </>
  )
}

// The side-by-side pair: before and after fill half the tile width each (the cards
// span two masonry columns in this mode, so there's room — see FileGrid).
function SideBySide({ left, right, name }: { left?: string | null; right?: string | null; name: string }) {
  return (
    <div className="flex gap-3 w-full">
      <ImageCell url={left} label="Before" name={name} />
      <ImageCell url={right} label="After" name={name} />
    </div>
  )
}

// Render a before/after image pair in the selected comparison mode. The overlay
// modes keep their own layout even when one side is missing (added/removed file),
// substituting a "No image" placeholder; we only fall back to the side-by-side
// pair for that mode itself, or the degenerate case of no images at all.
export function ImageDiffView({ left, right, mode, name }: { left?: string | null; right?: string | null; mode: ImageDiffMode; name: string }) {
  if (mode === 'side-by-side' || (!left && !right)) {
    return <SideBySide left={left} right={right} name={name} />
  }
  if (mode === 'ab') return <ABSwitch left={left} right={right} name={name} />
  if (mode === 'slider') return <SliderCompare left={left} right={right} name={name} />
  return <OnionCompare left={left} right={right} name={name} />
}

function FileRow({ file, mode, changeThreshold = 0 }: { file: ArtifactFile; mode: ImageDiffMode; changeThreshold?: number }) {
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
          <ImageDiffView left={file.left_url} right={file.right_url} mode={mode} name={file.name} />
        )}
      </div>
    </div>
  )
}

// An artifact's measured intrinsic dimensions: its aspect ratio (width / height)
// drives the default column span, and its natural pixel width lets the grid avoid
// upscaling a low-resolution shot past 1:1 on a high-DPI/large screen (see spanOf).
export type ArtifactDim = { aspect: number; pxWidth: number }

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
      setDims((a) => (a[key] != null ? a : { ...a, [key]: { aspect: w / h, pxWidth: w } }))
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
  sources: { key: string; url: string | null; video: boolean; width?: number | null; height?: number | null }[],
): Record<string, ArtifactDim> {
  const serverDims = useMemo(() => {
    const m: Record<string, ArtifactDim> = {}
    for (const s of sources) {
      if (s.width && s.height) m[s.key] = { aspect: s.width / s.height, pxWidth: s.width }
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
export function MasonryGrid({ items, spanScale = 1, spans, onSpanChange, scope }: {
  // bodyResizable defaults to true; set false for tiles whose media owns horizontal
  // drag (the before/after slider, video scrubbing) — those resize via the edge
  // handle only, so the two gestures don't fight.
  items: { key: string; node: React.ReactNode; aspect?: number; pxWidth?: number; minWidthPx?: number; bodyResizable?: boolean }[]
  spanScale?: number
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
  // aspect-ratio default scaled for side-by-side, then capped so we never blow a
  // shot up past its own resolution. Clamped to the rendered columns.
  //
  // The cap is the DPI fix: a tile's media fills its column run (w-full), so a
  // low-resolution shot stretched across a wide run on a large/high-DPI screen gets
  // upscaled and looks blurry. We cap the auto span to the widest run whose CSS width
  // stays within the image's own CSS width (natural px ÷ devicePixelRatio) — i.e. the
  // most columns it can cover at ≤1:1 device pixels. In side-by-side the run holds the
  // before+after pair so each image only gets ~half of it, hence the spanScale budget.
  // Explicit drag overrides bypass the cap: enlarging past native is then deliberate.
  const spanOf = useCallback((it: { key: string; aspect?: number; pxWidth?: number; minWidthPx?: number }): number => {
    let req = spans[spanKey(it.key)]
    if (req == null) {
      req = defaultSpanForAspect(it.aspect) * spanScale
      const unit = layout.colW + layout.gap
      if (it.pxWidth && layout.colW > 0) {
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
        const budgetCss = (it.pxWidth / dpr) * spanScale
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
  }, [spans, spanScale, layout.cols, layout.colW, layout.gap, spanKey])

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

  // Resize a tile to `next` columns, clamped to what's available. `key` is the tile's
  // file name; the override is persisted under its scoped key (see spanKey).
  const applySpan = (key: string, startSpan: number, deltaPx: number) => {
    const unit = layout.colW + layout.gap
    if (unit <= 0 || !onSpanChange) return
    const delta = Math.round(deltaPx / unit)
    onSpanChange(spanKey(key), Math.max(1, Math.min(layout.cols, startSpan + delta)))
  }

  // Edge-handle resize: drag the thin handle in the right gutter to grow/shrink the
  // span one column at a time. stopPropagation so it doesn't also trigger the body
  // drag below; double-click clears the override (back to the aspect-ratio default).
  const startEdgeResize = (key: string, startSpan: number) => (e: React.PointerEvent) => {
    if (e.button !== 0 || !onSpanChange) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const onMove = (ev: PointerEvent) => applySpan(key, startSpan, ev.clientX - startX)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
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
    draggedKeyRef.current = null // reset any stale value from a drag that produced no click
    const startX = e.clientX
    const startY = e.clientY
    let active = false
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!active) {
        // Require a decisive horizontal move so taps and vertical scrolls pass through.
        if (Math.abs(dx) < 6 || Math.abs(dx) <= Math.abs(ev.clientY - startY)) return
        active = true
        draggedKeyRef.current = key
      }
      ev.preventDefault()
      applySpan(key, startSpan, dx)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
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
        return (
          <div
            key={it.key}
            ref={observeTile}
            data-mkey={it.key}
            className={`absolute group/tile ${bodyResize ? 'touch-pan-y' : ''}`}
            style={{ left: p.left, top: p.top, width: p.width }}
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
function FileGrid({ files, mode, spans, onSpanChange, scope, changeThreshold = 0 }: {
  files: ArtifactFile[]
  mode: ImageDiffMode
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
    })),
    [files],
  )
  const dims = useMediaDims(sources)
  const items = useMemo(
    () => files.map((f) => ({
      key: f.name,
      node: <FileRow file={f} mode={mode} changeThreshold={changeThreshold} />,
      aspect: dims[f.name]?.aspect,
      pxWidth: dims[f.name]?.pxWidth,
      // Videos need a minimum tile width for their transport controls (see
      // VIDEO_MIN_TILE_PX); images have no such chrome.
      minWidthPx: isVideoArtifact(f.name) ? VIDEO_MIN_TILE_PX : undefined,
      // The slider mode and video both use horizontal drag on the media for their own
      // gesture, so let those resize via the edge handle only — see MasonryGrid's
      // bodyResizable. Other images resize by dragging the media (data-tile-drag).
      bodyResizable: mode !== 'slider' && !isVideoArtifact(f.name),
    })),
    [files, mode, dims, changeThreshold],
  )
  // pt-3 so the gap above the first row matches the card body's px-3 left inset.
  return (
    <div className="pt-3">
      <MasonryGrid items={items} spanScale={spanScale} spans={spans} onSpanChange={onSpanChange} scope={scope} />
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
export function LogView({ log, emptyText = 'Waiting for output…', failed = false }: { log: ArtifactLogLine[]; emptyText?: string; failed?: boolean }) {
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
  // failure detail, so no separate error box is needed beside it.
  return (
    <div className={`relative h-64 max-h-64 rounded-md border p-2 ${
      failed
        ? 'border-red-300 dark:border-red-800/80 bg-red-50/40 dark:bg-red-950/20'
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
// bare "Loading log…" line. `failed` marks a side whose build itself errored.
function SideLogPane({ label, url, log, loading, error, failed }: {
  label: string
  url?: string | null
  log: ArtifactLogLine[] | null
  loading: boolean
  error: string | null
  failed?: boolean
}) {
  if (!url) {
    return <LogColumnFrame label={label}><NoLog /></LogColumnFrame>
  }
  const emptyText = error ? `Failed to load log: ${error}` : loading ? 'Loading…' : 'No output'
  return (
    <LogColumnFrame label={label}>
      <LogView log={log ?? []} emptyText={emptyText} failed={failed || !!error} />
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
function LiveLogPanes({ set }: { set: ArtifactSet }) {
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
function PersistedLogView({ leftUrl, rightUrl, open, leftFailed, rightFailed }: { leftUrl?: string | null; rightUrl?: string | null; open: boolean; leftFailed?: boolean; rightFailed?: boolean }) {
  const [logs, setLogs] = useState<{ left: ArtifactLogLine[] | null; right: ArtifactLogLine[] | null } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Lazily fetch each side's log the first time the view is open — driven by an
  // effect (not the click handler) so a restored-open state also loads the log.
  // Keyed by url-pair via a ref so the fetch runs once per pair (and refetches if
  // a regenerate swaps the urls), without `logs`/`loading` in the deps — which
  // would re-fire the effect mid-flight and cancel the request.
  const fetchedKey = useRef<string | null>(null)
  useEffect(() => {
    if (!open || (!leftUrl && !rightUrl)) return
    const key = `${leftUrl ?? ''}|${rightUrl ?? ''}`
    if (fetchedKey.current === key) return
    fetchedKey.current = key
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
        if (!cancelled) { setErr(e instanceof Error ? e.message : String(e)); fetchedKey.current = null }
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
        <SideLogPane label="Before" url={leftUrl} log={logs?.left ?? null} loading={loading} error={err} failed={leftFailed} />
        <SideLogPane label="After" url={rightUrl} log={logs?.right ?? null} loading={loading} error={err} failed={rightFailed} />
      </div>
    </div>
  )
}

// The card header's action buttons (build log + regenerate) "melt" into the
// header at rest — just a faint icon — and resolve into proper bordered buttons
// only when the header cluster is hovered (the parent carries `group`). That
// keeps them discoverable without shouting over the card's own content. MELT_BTN
// is the shared resting+hover skin; per-button classes add the rounding/border
// sides on top.
const MELT_BTN = 'border border-transparent text-gray-400 dark:text-gray-500 group-hover:border-gray-200 dark:group-hover:border-gray-600 group-hover:bg-white dark:group-hover:bg-gray-700 group-hover:text-gray-500 dark:group-hover:text-gray-300 transition-colors cursor-pointer'

function ArtifactSetCard({ set, mode, spans, onSpanChange, filter, search, onRefresh, projectId, agentId }: { set: ArtifactSet; mode: ImageDiffMode; spans: ArtifactSpans; onSpanChange: (key: string, span: number | null) => void; filter: ArtifactTagFilter; search: string; onRefresh: (name: string, side?: ArtifactSide) => void; projectId: string | null; agentId: string }) {
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

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 overflow-hidden">
      {/* Give the header a resting tint that's distinct from the card body
          (bg-white / dark:bg-gray-800) on its own, not only on hover — a 60%
          gray-800 over a gray-800 body was indistinguishable at rest. */}
      <div className="flex items-stretch bg-gray-100 dark:bg-gray-700/40">
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
        {/* Proper bordered buttons (matching the rest of the app's icon buttons),
            vertically centred in the stretch-height header. */}
        <div className="group shrink-0 flex items-center gap-1.5 pl-1 pr-2">
          {/* Show/hide the build log. Opening it also expands the card (the log
              renders in the body). Only for settled cards with a log. The open
              state stays tinted blue even at rest so "log is showing" is legible;
              the resting affordance otherwise melts away (see MELT_BTN). */}
          {hasBuildLog && (
            <button
              onClick={toggleBuildLog}
              title={buildLogOpen ? 'Hide build log' : 'Show build log'}
              aria-label={buildLogOpen ? 'Hide build log' : 'Show build log'}
              className={`h-7 px-2 inline-flex items-center justify-center rounded-md transition-colors cursor-pointer ${
                buildLogOpen
                  ? 'border border-transparent text-blue-500 dark:text-blue-400 group-hover:border-blue-300 dark:group-hover:border-blue-700 group-hover:bg-blue-50 dark:group-hover:bg-blue-900/30'
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
              className={`h-7 pl-2 pr-1.5 inline-flex items-center rounded-l-md border-r-0 ${MELT_BTN}`}
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
              <PersistedLogView leftUrl={set.left_log_url} rightUrl={set.right_log_url} open={buildLogOpen} leftFailed={leftFailed} rightFailed={rightFailed} />
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
              <PersistedLogView leftUrl={set.left_log_url} rightUrl={set.right_log_url} open={buildLogOpen} leftFailed={leftFailed} rightFailed={rightFailed} />
              {failedSide && !hasBuildLog && (
                // One side died and left no log to show: fall back to a one-line note
                // so the partial result is still explained.
                <div className="my-2 flex items-center gap-1.5 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs font-medium text-amber-700 dark:text-amber-300">
                  <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                  The {failedSide === 'left' ? 'before (left)' : 'after (right)'} side failed to render — showing the {failedSide === 'left' ? 'after' : 'before'} side only.
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
                <FileGrid files={visibleFiles} mode={mode} spans={spans} onSpanChange={onSpanChange} scope={`${agentId}/${set.name}`} changeThreshold={changeThreshold} />
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

export function ArtifactsPanel({ projectId, agentId, baseRef, headRef, includeUncommitted, refreshKey, imageDiffMode, artifactSpans, onArtifactSpanChange }: {
  projectId: string | null
  agentId: string
  baseRef?: string
  headRef?: string
  includeUncommitted?: boolean
  refreshKey: number
  imageDiffMode: ImageDiffMode
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
      <div className="flex flex-wrap items-center gap-2 mb-2 min-h-[1.625rem]">
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
          <p><strong>Tags &amp; filter.</strong> Alongside an image <code className="text-blue-300">home.png</code> the script can write a JSON sidecar <code className="text-blue-300">home.png.meta</code> like <code className="text-blue-300">{'{'}"tags": ["theme::dark", "viewport::phone"]{'}'}</code>. Tags show as labels on each file and as a filter on this bar. A <code className="text-blue-300">category::value</code> tag is a <em>scoped</em> label — only one value per category is kept on a file (the last wins), and each category gets a filter button listing its values. Every value starts <em>on</em>; uncheck one to hide the files carrying it, or use <strong>all</strong> / <strong>clear</strong> (top of the menu) to toggle them in bulk. Shift-click a value to isolate it (hide everything else). Each value also shows a dimmed count on the right — how many items carry it under your current filters (ignoring this scope itself). Plain tags work the same way under a "tags" button. Handy when a script emits many shots (light/dark, phone/desktop) and you want to see just one slice. Two built-in filters are always present: a <strong>type</strong> filter (image / video, from each file's extension) and a <strong>changes</strong> filter (added / removed / modified / unchanged, from each file's diff state) — the latter always offers all four kinds even when none are present, and hides unchanged files by default, so use it to reveal them or to focus on one kind of change.</p>
        </InfoTooltip>
        {/* The shared filter bar: a search box and one dropdown per tag scope
            (the user-defined categories, the free-form "tags" group, plus the
            built-in type and changes scopes). ml-auto floats it to the right. */}
        <ArtifactFilterBar
          files={allFiles}
          pendingTags={pendingTags}
          filter={tagFilter}
          onFilterChange={updateTagFilter}
          search={search}
          onSearchChange={setSearch}
          showChangeFilter
          className="ml-auto"
        />
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
        {sets.map((s) => <ArtifactSetCard key={`${projectId ?? '_'}-${agentId}-${s.name}`} set={s} mode={imageDiffMode} spans={artifactSpans} onSpanChange={onArtifactSpanChange} filter={tagFilter} search={search} onRefresh={requestRefresh} projectId={projectId} agentId={agentId} />)}
      </div>
    </div>
  )
}
