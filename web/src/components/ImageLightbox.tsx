import { Fragment, useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import type { ImageDiffMode } from './ArtifactImageDiff'
import { LightboxDiff } from './LightboxDiff'

export interface LightboxImage {
  url: string
  filename: string
  /** File size in bytes, shown in the caption. Omit/0 when unknown (e.g. an
   *  image referenced only by path), in which case the size is left out. */
  size: number
  /** When set, the lightbox renders a fullscreen before/after comparator (with mode
   *  controls — toggle, slider, onion) for this entry instead of a single image. The
   *  diff viewer supplies this; `url` is still used for the edge previews and caption. */
  diff?: { left?: string | null; right?: string | null; mode: ImageDiffMode }
  /** Pixel density (device-scale factor) the media was captured at, surfaced in the
   *  caption next to the dimensions (e.g. "780 × 1688 @2×"). Omit/1 → not shown. */
  dpi?: number
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Checkerboard behind images so transparent PNGs read as transparent rather than
// blending into the dark backdrop. Shared by the main image and the side previews.
const CHECKER = 'repeating-conic-gradient(#bfbfbf 0% 25%, #f5f5f5 0% 50%) 0 0 / 20px 20px'

// A Slack-style fullscreen image viewer: a blurred dark backdrop with the image
// centered, optional prev/next arrows when there's more than one image, and
// keyboard support (Esc closes, ←/→ navigate). Clicking the backdrop closes it.
export function ImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: LightboxImage[]
  index: number
  onIndexChange: (i: number) => void
  onClose: () => void
}) {
  const count = images.length
  const prev = useCallback(() => onIndexChange((index - 1 + count) % count), [index, count, onIndexChange])
  const next = useCallback(() => onIndexChange((index + 1) % count), [index, count, onIndexChange])
  // Natural pixel dimensions of the current image, read once it loads. Cleared
  // on navigation so a stale size never flashes against the next image.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => { setDims(null) }, [index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') prev()
      else if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, onClose])

  const current = images[index]
  if (!current) return null

  // On large screens, when there's more than one image, the prev/next images sit
  // mostly off-screen at the edges with only a sliver (~12%) peeking in — a
  // Lightroom-style filmstrip hint of what ←/→ will bring up. Hovering slides the
  // peeked image a little further in. The main image is narrowed slightly so the
  // arrows have gutter room beside the peek (both dropped below `lg`).
  const hasSiblings = count > 1
  const figureWidth = hasSiblings ? 'max-w-[90vw] lg:max-w-[80vw]' : 'max-w-[90vw]'
  const sidePreview = (dir: 'prev' | 'next') => {
    const i = dir === 'prev' ? (index - 1 + count) % count : (index + 1) % count
    const onClick = dir === 'prev' ? prev : next
    // Translate the whole button (not just the image) so its click area travels
    // off-screen with it — only the visible sliver stays clickable, rather than a
    // full-width hit zone covering the gutter.
    const slide = dir === 'prev'
      ? '-translate-x-[88%] hover:-translate-x-[78%]'
      : 'translate-x-[88%] hover:translate-x-[78%]'
    return (
      <button
        type="button"
        // The chevron buttons and ←/→ keys are the primary controls; the preview is
        // a redundant click target, so keep it out of the tab order.
        tabIndex={-1}
        onClick={(e) => { e.stopPropagation(); onClick() }}
        aria-hidden="true"
        className={`group hidden lg:block absolute top-1/2 -translate-y-1/2 ${dir === 'prev' ? 'left-0' : 'right-0'} ${slide} transition-transform duration-200 cursor-pointer`}
      >
        <img
          src={images[i].url}
          alt=""
          style={{ background: CHECKER }}
          className={`max-h-[70vh] max-w-[22vw] object-contain ${dir === 'prev' ? 'rounded-r-2xl' : 'rounded-l-2xl'} opacity-40 group-hover:opacity-80 transition-opacity duration-200 shadow-2xl`}
        />
      </button>
    )
  }

  // Portal to <body> so the fixed overlay is positioned against the viewport, not
  // a transformed ancestor — the sidebar's slide animation (translate-x) makes it
  // a containing block for fixed descendants, which would otherwise clip/shrink
  // the lightbox when it's opened from the compact (in-sidebar) spawn form.
  return createPortal(
    <div
      className="fixed inset-0 z-[110] overflow-hidden flex items-center justify-center bg-black/70 backdrop-blur-md animate-in fade-in duration-150"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* Close button */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors cursor-pointer"
      >
        <X className="w-5 h-5" />
      </button>

      {/* Previous image preview (large screens only) */}
      {hasSiblings && sidePreview('prev')}

      {/* Previous arrow */}
      {count > 1 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); prev() }}
          aria-label="Previous image"
          // Sits at the edge on small screens; on `lg` it moves inward to clear the
          // peeking preview, landing in the gutter beside it.
          className="absolute left-4 lg:left-[4.5vw] p-2 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors cursor-pointer"
        >
          <ChevronLeft className="w-7 h-7" />
        </button>
      )}

      {/* Image (or diff comparator) + caption (clicks here don't close) */}
      <figure
        className={`flex flex-col items-center gap-3 ${current.diff ? 'max-w-[94vw]' : figureWidth} max-h-[90vh] animate-in zoom-in-95 duration-150`}
        onClick={(e) => e.stopPropagation()}
      >
        {current.diff ? (
          // A before/after pair: render the fullscreen comparator (its own mode
          // controls live inside) keyed on the entry so switching files resets it.
          <LightboxDiff
            key={current.url}
            left={current.diff.left}
            right={current.diff.right}
            name={current.filename}
            initialMode={current.diff.mode}
            onDims={setDims}
          />
        ) : (
          <img
            src={current.url}
            alt={current.filename}
            onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            // Checkerboard behind the image so transparent PNGs (e.g. an icon)
            // read as transparent rather than blending into the dark backdrop. The
            // <img> sizes to the image's own aspect ratio, so this sits exactly
            // behind the picture; opaque images simply cover it.
            style={{ background: CHECKER }}
            className={`max-h-[85vh] ${figureWidth} object-contain rounded-lg shadow-2xl`}
          />
        )}
        <figcaption className="flex items-center gap-2 text-xs font-mono">
          {[
            <span key="name" className="text-white/70">{current.filename}</span>,
            dims && <span key="dims" className="text-white/40">{dims.w} × {dims.h}{current.dpi && current.dpi > 1 ? ` @${current.dpi}×` : ''}</span>,
            current.size > 0 && <span key="size" className="text-white/40">{formatBytes(current.size)}</span>,
            count > 1 && <span key="count" className="text-white/40">{index + 1} / {count}</span>,
          ]
            .filter(Boolean)
            .map((part, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="text-white/30">·</span>}
                {part}
              </Fragment>
            ))}
        </figcaption>
      </figure>

      {/* Next arrow */}
      {count > 1 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); next() }}
          aria-label="Next image"
          className="absolute right-4 lg:right-[4.5vw] p-2 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors cursor-pointer"
        >
          <ChevronRight className="w-7 h-7" />
        </button>
      )}

      {/* Next image preview (large screens only) */}
      {hasSiblings && sidePreview('next')}
    </div>,
    document.body,
  )
}
