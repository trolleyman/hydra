// Presentational helpers shared by the artifact diff viewers — the still-image
// modes in ArtifactsPanel and the video (.webm) modes in VideoDiffView. Kept in
// their own module so both have one source of truth for sizing, the checkerboard
// backdrop, the new-tab affordance, the drag-to-resize grip and the pixel-diff
// constants, and so VideoDiffView doesn't have to import back from ArtifactsPanel
// (which renders it — that would be a circular import).
import { useState, useRef, useCallback } from 'react'
import { Maximize2 } from 'lucide-react'

// A subtle checkerboard so transparent screenshots/frames read clearly in both themes.
export const checkerStyle: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, rgba(0,0,0,0.06) 25%, transparent 25%), linear-gradient(-45deg, rgba(0,0,0,0.06) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(0,0,0,0.06) 75%), linear-gradient(-45deg, transparent 75%, rgba(0,0,0,0.06) 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
}

// IMG_CLASS sizes the base media (image or video frame); OVERLAY_CLASS stretches an
// overlay to fill the same box so the two align pixel-for-pixel; TAG_CLASS is the
// small "Before"/"After"/"Diff" corner label.
export const IMG_CLASS = 'max-w-full max-h-[480px] rounded-md border border-gray-200 dark:border-gray-700 object-contain'
export const OVERLAY_CLASS = 'absolute inset-0 w-full h-full object-contain rounded-md border border-gray-200 dark:border-gray-700'
export const TAG_CLASS = 'absolute top-1 z-10 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-black/55 text-white pointer-events-none'

// Open media in a new tab. In side-by-side mode the media is a target=_blank link,
// so left-click already does this; the overlay modes bind left-click/drag to
// comparison gestures, so they route the new-tab affordance to the middle button.
export function openInNewTab(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

// makeAuxOpen builds an onAuxClick handler that opens `pick()` in a new tab on a
// middle click. `pick` is a function so the chosen url can depend on state (e.g.
// which side is currently shown) or the cursor position at click time.
export function makeAuxOpen(pick: (e: React.MouseEvent) => string) {
  return (e: React.MouseEvent) => {
    if (e.button !== 1) return
    e.preventDefault()
    openInNewTab(pick(e))
  }
}

// Default/bounds for the draggable media height (see useMediaResize). The base
// matches IMG_CLASS's max-h-[480px] so a card opens at the same size as before.
export const DEFAULT_IMG_MAX_H = 480
export const MIN_IMG_MAX_H = 160
export const MAX_IMG_MAX_H = 1600
// Pointer travel (px) past which a press-and-move counts as a resize drag rather
// than a click — so a drag on the A/B media resizes without also flipping sides.
const DRAG_THRESHOLD = 4

// Bright magenta (#FF00FF) — the colour every changed pixel is painted in the
// difference view, chosen to stand out against typical UI screenshots.
export const DIFF_COLOR: [number, number, number] = [255, 0, 255]
// A small per-pixel tolerance (sum of the absolute R/G/B/A channel deltas) below
// which two pixels count as equal, so JPEG/codec/anti-aliasing speckle doesn't
// paint a confetti of magenta over otherwise-identical regions. 0 would be exact.
export const DIFF_PIXEL_THRESHOLD = 32

// Shared drag-to-resize for a before/after pair: dragging the grip on EITHER side
// adjusts a single max-height that's applied to BOTH, so they always grow by the
// same amount even though only one was dragged. The pointermove listener lives on
// the window so the drag keeps tracking outside the grip.
export function useMediaResize() {
  const [maxHeight, setMaxHeight] = useState(DEFAULT_IMG_MAX_H)
  // Hold the latest value so a drag can read its start height without re-creating
  // the (stable) onResizeStart callback on every resize tick.
  const current = useRef(maxHeight)
  current.current = maxHeight
  // True once the in-flight press has moved past DRAG_THRESHOLD, i.e. it's a
  // resize drag and not a click. Read (and cleared) by consumeDrag so a click
  // handler on the same element can skip its action when a drag just happened.
  const dragged = useRef(false)
  const onResizeStart = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    // Suppress the click/drag from selecting text or following the media's <a> link.
    e.preventDefault()
    e.stopPropagation()
    dragged.current = false
    const startX = e.clientX
    const startY = e.clientY
    const startH = current.current
    const onMove = (ev: PointerEvent) => {
      // The grip is a bottom-right (nwse) corner handle, so down-AND-right grows
      // the media. Sum the horizontal and vertical deltas so a purely horizontal
      // drag to the right enlarges it just as a downward drag does.
      const delta = (ev.clientX - startX) + (ev.clientY - startY)
      if (Math.abs(delta) > DRAG_THRESHOLD) dragged.current = true
      setMaxHeight(Math.max(MIN_IMG_MAX_H, Math.min(MAX_IMG_MAX_H, startH + delta)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])
  // Whether the gesture that just ended was a drag (resets the flag). A click
  // handler calls this to decide whether to run — letting a drag-to-resize on a
  // clickable element avoid also triggering the click (e.g. the A/B flip).
  const consumeDrag = useCallback(() => {
    const d = dragged.current
    dragged.current = false
    return d
  }, [])
  return { maxHeight, onResizeStart, consumeDrag }
}

// A corner grip (revealed on hover) that the user drags to resize the media. Sits
// as a sibling of the media/link so a normal click still opens it in a new tab;
// only the grip starts a resize.
export function ResizeGrip({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      // Swallow the click so a tap on the grip doesn't reach a parent that treats
      // a click as a gesture (e.g. the A/B view flips on click of the box).
      onClick={(e) => e.stopPropagation()}
      title="Drag to resize"
      className="absolute bottom-1 right-1 z-10 flex items-center justify-center w-5 h-5 rounded bg-black/45 text-white/90 opacity-0 group-hover:opacity-100 transition-opacity cursor-nwse-resize touch-none select-none"
    >
      <Maximize2 className="w-3 h-3" />
    </div>
  )
}
