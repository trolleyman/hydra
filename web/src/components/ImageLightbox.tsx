import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronLeft, ChevronRight, SquarePlus, SquareMinus, SquareDot } from 'lucide-react'
import type { ImageDiffMode } from './ArtifactImageDiff'
import { LightboxDiff } from './LightboxDiff'
import { makeAuxOpen } from './artifactDiffShared'
import { applyABShortcut } from '../lib/abShortcuts'
import { ZoomPan } from './ZoomPan'

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
  /** How this artifact changed vs its counterpart (added/removed/modified), when
   *  known — shown as a small +/−/• glyph right after the filename in the caption,
   *  mirroring the diff grid's per-file badge. Omit for plain images with no diff
   *  context (e.g. the repository browser). */
  changeType?: 'added' | 'removed' | 'modified'
}

// A small +/−/• glyph marking whether the artifact was added, removed, or modified
// relative to its counterpart — mirrors the diff grid's ArtifactChangeIcon, but tuned
// for the lightbox's always-dark backdrop (the brighter dark-theme colors).
function ChangeTypeGlyph({ type }: { type: NonNullable<LightboxImage['changeType']> }) {
  const cls = 'w-3.5 h-3.5 shrink-0'
  switch (type) {
    case 'added':
      return <SquarePlus className={`${cls} text-green-400`} />
    case 'removed':
      return <SquareMinus className={`${cls} text-red-400`} />
    case 'modified':
      return <SquareDot className={`${cls} text-amber-400`} />
  }
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
  // Navigation has a hard start and end — it does NOT wrap around. At the first image
  // there's no previous, at the last there's no next (the arrows/previews for those
  // directions are hidden below), so a gallery reads as a finite strip rather than an
  // endless carousel.
  const hasPrev = index > 0
  const hasNext = index < count - 1
  // The direction of the last navigation (+1 next, -1 prev, 0 on open), so the new
  // image can slide in from the matching side — see the keyed wrapper below.
  const [dir, setDir] = useState(0)
  const prev = useCallback(() => { if (index > 0) { setDir(-1); onIndexChange(index - 1) } }, [index, onIndexChange])
  const next = useCallback(() => { if (index < count - 1) { setDir(1); onIndexChange(index + 1) } }, [index, count, onIndexChange])
  // Natural pixel dimensions of the current image, read once it loads. Cleared
  // on navigation so a stale size never flashes against the next image.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  // Clear the measured size the moment the shown image changes (adjust-during-
  // render rather than in an effect, so no stale size survives to the next paint).
  const [dimsIndex, setDimsIndex] = useState(index)
  if (dimsIndex !== index) { setDimsIndex(index); setDims(null) }

  // Comparison mode + before/after view + highlight for diff entries, held HERE (not in
  // LightboxDiff, which remounts per index) so they PERSIST as you navigate ←/→ between
  // images — pick a side or a mode and the next entry keeps it rather than resetting.
  // The mode seeds from whichever entry the lightbox was opened on (the grid's current
  // mode); view/highlight start fresh each opening. (Zoom still resets per image — its
  // state lives in the per-index ZoomPan remount.)
  const [diffMode, setDiffMode] = useState<ImageDiffMode>(() => images[index]?.diff?.mode ?? 'ab')
  const [abView, setAbView] = useState<'before' | 'after'>('after')
  const [highlight, setHighlight] = useState(false)

  // Steal focus while open, restore it on close. The opener can leave focus in a
  // keyboard-hungry widget — the terminal's hidden xterm textarea is the prime case
  // (e.g. opening a prompt-attachment thumbnail right after typing in the terminal):
  // every keystroke would keep feeding the shell, and the shortcut handlers below
  // would swallow nothing/act on nothing (X/B/A/H skip fields, Esc/←/→ would both
  // navigate AND type into the terminal). Focusing the (tabIndex -1) backdrop makes
  // the dialog the key target for as long as it's up, like any focused modal.
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    rootRef.current?.focus()
    // Restore on unmount; if the opener left the DOM meanwhile, focus() no-ops.
    return () => opener?.focus()
  }, [])

  // X/B/A/H — the shared comparator shortcuts (see applyABShortcut) — drive a diff
  // entry's before/after view + highlight. Held here (with the state above) so they
  // persist across navigation; non-diff (plain image) entries ignore them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!images[index]?.diff) return
      applyABShortcut(e, {
        view: abView,
        highlight,
        onViewChange: setAbView,
        onHighlightChange: setHighlight,
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, images, abView, highlight])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') prev()
      else if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, onClose])

  // Whether the current pointer press STARTED on the backdrop itself. Closing on
  // backdrop click must ignore a drag that merely ENDS there — panning a zoomed
  // image (or dragging the diff slider) and releasing past the image's edge makes
  // the browser fire the trailing click on the press/release common ancestor, i.e.
  // the backdrop. Tracked in the capture phase so a child's stopPropagation (the
  // zoomed pan handler suspends inner gestures that way) can't hide the press.
  const pressOnBackdrop = useRef(false)

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
    // Only rendered when a sibling exists in that direction (no wrap), so the index
    // is always in range.
    const i = dir === 'prev' ? index - 1 : index + 1
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
      // z-[100] keeps the lightbox BELOW the approval toasts (z-[110]): a passive
      // image viewer must not hide an incoming security-gate approval. Focused
      // modal dialogs sit above the toasts instead (z-[120]).
      className="fixed inset-0 z-[100] overflow-hidden flex items-center justify-center bg-black/70 backdrop-blur-md animate-in fade-in duration-150 outline-none"
      onPointerDownCapture={(e) => { pressOnBackdrop.current = e.target === e.currentTarget }}
      // Close only when the press and the click BOTH land on the backdrop — see
      // pressOnBackdrop above for why a click alone isn't enough.
      onClick={(e) => { if (pressOnBackdrop.current && e.target === e.currentTarget) onClose() }}
      role="dialog"
      aria-modal="true"
      // Click-focusable (not tabbable) so the focus-steal above can land here, and
      // so a click inside keeps the dialog — not the page behind it — the key target.
      tabIndex={-1}
      ref={rootRef}
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

      {/* Previous image preview (large screens only) — hidden at the start */}
      {hasPrev && sidePreview('prev')}

      {/* Previous arrow — hidden at the start (no wrap-around) */}
      {hasPrev && (
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
        {/* Keyed by index so the media remounts on each navigation and replays the
            directional slide+fade (lightbox-slide; defined in index.css). The CSS var
            sets which side it enters from — the side you're heading toward — so ←/→
            feel like moving through a strip rather than the picture blinking in place. */}
        <div
          key={index}
          className="lightbox-slide flex justify-center items-center w-full min-h-0"
          style={{ ['--lb-from' as string]: dir < 0 ? '-2rem' : dir > 0 ? '2rem' : '0rem' }}
        >
          {current.diff ? (
            // A before/after pair: render the fullscreen comparator (its own mode
            // controls live inside). The wrapper key already remounts it per entry.
            <LightboxDiff
              left={current.diff.left}
              right={current.diff.right}
              name={current.filename}
              mode={diffMode}
              onModeChange={setDiffMode}
              view={abView}
              onViewChange={setAbView}
              highlight={highlight}
              onHighlightChange={setHighlight}
              onDims={setDims}
            />
          ) : (
            // Wrapped in ZoomPan so the image can be magnified past fit (wheel),
            // panned (drag once zoomed), and navigated with the corner minimap —
            // useful when a shot is too small to read at fit. The wrapper keys off
            // the parent's index remount, so zoom resets on navigation.
            <ZoomPan minimapSrc={current.url} className="rounded-lg shadow-2xl">
              <img
                src={current.url}
                alt={current.filename}
                onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                // Middle-click opens the raw image file in a new browser tab.
                onAuxClick={makeAuxOpen(() => current.url)}
                draggable={false}
                // Checkerboard behind the image so transparent PNGs (e.g. an icon)
                // read as transparent rather than blending into the dark backdrop. The
                // <img> sizes to the image's own aspect ratio, so this sits exactly
                // behind the picture; opaque images simply cover it.
                style={{ background: CHECKER }}
                className={`max-h-[85vh] ${figureWidth} object-contain block`}
              />
            </ZoomPan>
          )}
        </div>
        <figcaption className="flex items-center gap-2 text-xs font-mono">
          {[
            <span key="name" className="flex items-center gap-1.5 text-white/70">
              {current.filename}
              {current.changeType && (
                <span title={current.changeType} className="flex items-center">
                  <ChangeTypeGlyph type={current.changeType} />
                </span>
              )}
            </span>,
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

      {/* Next arrow — hidden at the end (no wrap-around) */}
      {hasNext && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); next() }}
          aria-label="Next image"
          className="absolute right-4 lg:right-[4.5vw] p-2 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors cursor-pointer"
        >
          <ChevronRight className="w-7 h-7" />
        </button>
      )}

      {/* Next image preview (large screens only) — hidden at the end */}
      {hasNext && sidePreview('next')}
    </div>,
    document.body,
  )
}
