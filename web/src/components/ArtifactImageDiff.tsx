import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import {
  checkerStyle, IMG_CLASS, OVERLAY_CLASS, TAG_CLASS, makeAuxOpen,
  DIFF_COLOR, DIFF_PIXEL_THRESHOLD, DIFF_ALPHA,
} from './artifactDiffShared'
import { useImageLightbox } from '../stores/imageLightboxStore'
import type { LightboxImage } from './ImageLightbox'

// The ways to compare a before/after image pair. Persisted in the diff viewer's
// settings; see DiffViewer's SettingsPopup. (The magenta pixel-diff isn't a mode of
// its own any more — it's a "Highlight" checkbox that overlays the changes on the
// Before/After view.)
export type ImageDiffMode = 'side-by-side' | 'ab' | 'slider' | 'onion'

// Global A/B controls. When a provider is present (the diff viewer's artifacts
// panel), every A/B tile — image and video — reads its before/after view and
// "highlight changed pixels" flag from here and hides its own per-tile pill, so one
// control (and the B / H keyboard shortcuts) flips and highlights them all at once.
// Absent (the repository browser, which has no shared toolbar) → each tile falls
// back to its own local toggles, shown inline as before.
export type ArtifactABControls = {
  view: 'before' | 'after'
  highlight: boolean
  toggleView: () => void
}
export const ABControlsContext = createContext<ArtifactABControls | null>(null)

export const IMAGE_DIFF_MODES: { value: ImageDiffMode; label: string }[] = [
  { value: 'ab', label: 'Before · After' },
  { value: 'slider', label: 'Before · After (slider)' },
  { value: 'side-by-side', label: 'Side by side' },
  { value: 'onion', label: 'Onion skin' },
]

// A single artifact image as a lightbox entry; size is unknown here (the diff
// viewer doesn't carry byte sizes) so it's left out of the caption.
function lightboxImage(url: string, name: string): LightboxImage {
  return { url, filename: name, size: 0 }
}

type OpenLightbox = (images: LightboxImage[], index?: number) => void

// Open this tile's entry in the lightbox. When the grid threaded down its `gallery`
// (one entry per visible image file, carrying the before/after pair + mode) and this
// tile's `index`, open the whole gallery there — so ←/→ step between files and the
// lightbox shows the diff comparison. Otherwise fall back to just this one image
// (e.g. the unit tests, or any caller that doesn't supply a gallery).
function openGalleryAt(
  open: OpenLightbox,
  gallery: LightboxImage[] | undefined,
  index: number | undefined,
  fallbackUrl: string,
  name: string,
) {
  if (gallery && index != null) open(gallery, index)
  else open([lightboxImage(fallbackUrl, name)])
}

function ImageCell({ url, label, name, gallery, index, disableOpen }: {
  url?: string | null
  label: string
  name: string
  // The grid's diff gallery + this tile's index in it, so a click opens the lightbox
  // there and ←/→ walk the files. Omitted → opens just this image.
  gallery?: LightboxImage[]
  index?: number
  // Set when this view is *already* inside the lightbox, so a click shouldn't open a
  // (nested) lightbox — it just stays a static image.
  disableOpen?: boolean
}) {
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
          onClick={disableOpen ? undefined : () => openGalleryAt(openImage, gallery, index, url, name)}
          className={`block w-full ${disableOpen ? 'cursor-default' : 'cursor-zoom-in'}`}
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
function ABSwitch({ left, right, name, gallery, index, disableOpen }: {
  left?: string | null; right?: string | null; name: string
  gallery?: LightboxImage[]; index?: number; disableOpen?: boolean
}) {
  const openImage = useImageLightbox()
  const canDiff = !!left && !!right
  // Prefer the panel-wide controls (diff viewer) when present; otherwise keep this
  // tile's own local toggles (repository browser). See ABControlsContext.
  const global = useContext(ABControlsContext)
  const [localView, setLocalView] = useState<'before' | 'after'>('after')
  const [localHighlight, setLocalHighlight] = useState(false)
  const view = global ? global.view : localView
  const flip = global ? global.toggleView : () => setLocalView((v) => (v === 'before' ? 'after' : 'before'))
  const showHighlight = (global ? global.highlight : localHighlight) && canDiff
  // At least one side is present (ImageDiffView only routes here otherwise); the
  // present image is the invisible sizer that gives the stacked box its size.
  const sizer = (right ?? left) as string
  return (
    <div className="min-w-0">
      {/* Only the standalone (no global controls) tile shows its own pill — under the
          diff viewer the before/after + highlight controls live up in the panel header. */}
      {!global && (
        <div className="flex flex-wrap items-center gap-1 mb-1">
          <SegmentedToggle
            value={localView}
            onChange={setLocalView}
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
              checked={localHighlight && canDiff}
              disabled={!canDiff}
              onChange={(e) => setLocalHighlight(e.target.checked)}
              className="accent-blue-500 cursor-pointer disabled:cursor-not-allowed"
            />
            Highlight
          </label>
        </div>
      )}
      {/* select-none: flipping is a rapid click target, so without this a quick
          double-click would highlight the "No image" placeholder text. */}
      <div
        className="relative w-full cursor-pointer select-none"
        onClick={flip}
        onAuxClick={disableOpen ? undefined : makeAuxOpen(
          () => (view === 'before' ? left : right) || sizer,
          (url) => openGalleryAt(openImage, gallery, index, url, name),
        )}
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
function SliderCompare({ left, right, name, gallery, index, disableOpen }: {
  left?: string | null; right?: string | null; name: string
  gallery?: LightboxImage[]; index?: number; disableOpen?: boolean
}) {
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
      onAuxClick={disableOpen ? undefined : makeAuxOpen((e) => {
        const el = ref.current
        if (!el) return sizer
        const r = el.getBoundingClientRect()
        const x = ((e.clientX - r.left) / r.width) * 100
        return (x < pos ? left : right) || sizer
      }, (url) => openGalleryAt(openImage, gallery, index, url, name))}
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
function OnionCompare({ left, right, name, gallery, index, disableOpen }: {
  left?: string | null; right?: string | null; name: string
  gallery?: LightboxImage[]; index?: number; disableOpen?: boolean
}) {
  const openImage = useImageLightbox()
  const [opacity, setOpacity] = useState(50)
  const sizer = (right ?? left) as string
  return (
    <div className="min-w-0">
      <div
        className="relative w-full select-none"
        onAuxClick={disableOpen ? undefined : makeAuxOpen(
          () => (opacity >= 50 ? right : left) || sizer,
          (url) => openGalleryAt(openImage, gallery, index, url, name),
        )}
      >
        <img src={sizer} style={{ visibility: 'hidden' }} className={`${IMG_CLASS} block`} draggable={false} />
        <LayerNode url={left} />
        <LayerNode url={right} style={{ opacity: opacity / 100 }} />
      </div>
      {/* data-no-tile-drag: this opacity slider owns its own horizontal drag, so the
          masonry tile's drag-to-resize must not hijack it (see startBodyResize). */}
      <div data-no-tile-drag className="flex items-center gap-2 mt-1">
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
function SideBySide({ left, right, name, gallery, index, disableOpen }: {
  left?: string | null; right?: string | null; name: string
  gallery?: LightboxImage[]; index?: number; disableOpen?: boolean
}) {
  return (
    <div className="flex gap-3 w-full">
      <ImageCell url={left} label="Before" name={name} gallery={gallery} index={index} disableOpen={disableOpen} />
      <ImageCell url={right} label="After" name={name} gallery={gallery} index={index} disableOpen={disableOpen} />
    </div>
  )
}

// Render a before/after image pair in the selected comparison mode. The overlay
// modes keep their own layout even when one side is missing (added/removed file),
// substituting a "No image" placeholder; we only fall back to the side-by-side
// pair for that mode itself, or the degenerate case of no images at all.
// `gallery` is the grid's diff gallery — one entry per visible image file (in display
// order), each carrying the before/after pair + mode — and `index` is this file's
// spot in it, so opening any image lets ←/→ walk the files and the lightbox shows the
// diff comparison. Both are optional: callers that don't supply them (e.g. unit tests)
// just open the single clicked image.
export function ImageDiffView({ left, right, mode, name, gallery, index, disableOpen }: {
  left?: string | null; right?: string | null; mode: ImageDiffMode; name: string
  gallery?: LightboxImage[]; index?: number
  // Set when rendered inside the lightbox itself, so the click/middle-click "open in
  // lightbox" affordances are suppressed (you're already in it).
  disableOpen?: boolean
}) {
  if (mode === 'side-by-side' || (!left && !right)) {
    return <SideBySide left={left} right={right} name={name} gallery={gallery} index={index} disableOpen={disableOpen} />
  }
  if (mode === 'ab') return <ABSwitch left={left} right={right} name={name} gallery={gallery} index={index} disableOpen={disableOpen} />
  if (mode === 'slider') return <SliderCompare left={left} right={right} name={name} gallery={gallery} index={index} disableOpen={disableOpen} />
  return <OnionCompare left={left} right={right} name={name} gallery={gallery} index={index} disableOpen={disableOpen} />
}
