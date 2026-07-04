import { useEffect, useMemo, useState } from 'react'
import { ImageDiffView, SegmentedToggle, type ArtifactABControls, type ImageDiffMode } from './ArtifactImageDiff'
import { ABControlsContext, IMAGE_DIFF_MODES } from './artifactDiffContext'
import { ZoomPan } from './ZoomPan'

// LightboxDiff renders a before/after artifact pair fullscreen inside the image
// lightbox: the same comparison modes as the diff grid (before/after toggle, slider,
// onion blend, side-by-side) but sized to fill the viewport, with a mode selector so
// you can switch without leaving the lightbox.
//
// It reuses the grid's (width-driven) ImageDiffView, feeding it an explicit width
// computed from the pair's aspect ratio so the overlay layers stay aligned and the
// result is also bounded by viewport height. `disableOpen` stops the inner view from
// re-opening a (nested) lightbox. The whole thing is forced to the dark theme (`dark`)
// so its controls read clearly against the lightbox's black backdrop regardless of
// the app's current theme.
//
// The comparison mode + Before/After view + Highlight are CONTROLLED by the lightbox
// (ImageLightbox), not held here, so they persist as you navigate ←/→ between entries
// - pick "Before", or onion skin, and the next image keeps it rather than resetting.
// A local ABControlsContext provider feeds the before/after view + highlight to the
// inner ImageDiffView (which hides its own per-tile pill); the keyboard (X flip, B/A
// jump, H highlight) lives in ImageLightbox for the same persistence reason.
export function LightboxDiff({ left, right, name, mode, onModeChange, view, onViewChange, highlight, onHighlightChange, onDims }: {
  left?: string | null
  right?: string | null
  name: string
  mode: ImageDiffMode
  onModeChange: (m: ImageDiffMode) => void
  view: 'before' | 'after'
  onViewChange: (v: 'before' | 'after') => void
  highlight: boolean
  onHighlightChange: (h: boolean) => void
  // Reports the representative image's natural pixel size once measured, so the
  // lightbox caption can show "W × H" for a diff entry just like a plain image.
  onDims?: (d: { w: number; h: number }) => void
}) {
  const [aspect, setAspect] = useState<number | null>(null)
  // Highlight needs both sides to diff; with only one (added/removed file) it's disabled.
  const canDiff = !!left && !!right

  // Measure the pair's aspect ratio (from whichever side exists) so the comparator can
  // be sized to the displayed image and capped to the viewport height - and report the
  // natural pixel size up for the caption.
  useEffect(() => {
    const url = right ?? left
    if (!url) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled || !img.naturalWidth || !img.naturalHeight) return
      setAspect(img.naturalWidth / img.naturalHeight)
      onDims?.({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.src = url
    return () => { cancelled = true }
  }, [left, right, onDims])

  // Provide the before/after view + highlight to the inner ImageDiffView so its A/B
  // tile reads them (and hides its own per-tile pill) - the control row above the
  // image (see below) is the single control instead.
  const ab = useMemo<ArtifactABControls>(
    () => ({ view, highlight, toggleView: () => onViewChange(view === 'before' ? 'after' : 'before') }),
    [view, highlight, onViewChange],
  )

  // Width drives the layout; folding the 78vh height cap through the aspect ratio keeps
  // a wide shot from overflowing vertically. Side-by-side shows two images in the row,
  // so it gets twice the width budget. Until the aspect loads, fall back to a plain cap.
  const wide = mode === 'side-by-side'
  const maxW = wide ? '94vw' : '84vw'
  const width = aspect != null
    ? `min(${maxW}, calc(78vh * ${aspect}${wide ? ' * 2' : ''}))`
    : maxW

  return (
    <ABControlsContext.Provider value={ab}>
      <div className="dark flex flex-col items-center gap-3">
        {/* ZoomPan magnifies the comparator past fit (wheel), pans it (drag once
            zoomed), and gives a corner minimap - at fit the inner view keeps its own
            click/slider/onion gestures; pan only takes over above 1×. The minimap
            thumbnail uses the "after" side (or whichever exists). maxWidth/maxHeight
            put it in grow mode: the frame expands into the empty lightbox space as you
            zoom (so a very vertical pair reveals its full width, not a sliver) rather
            than magnifying inside the fit-sized box. The fit `width` moves to an inner
            wrapper so the comparator stays laid out at its fit size while the frame
            around it grows (feeding it the frame width instead would reflow the diff,
            not magnify it). */}
        <ZoomPan minimapSrc={right ?? left} className="max-w-[94vw]" maxWidth="94vw" maxHeight="80vh">
          <div style={{ width }}>
            <ImageDiffView left={left} right={right} mode={mode} name={name} disableOpen />
          </div>
        </ZoomPan>
        {/* All controls sit in one row BELOW the comparator so the growing frame can't
            shuffle them around (the Before/After toggle + Highlight used to sit above
            the image, which the grow would push about). In A/B mode they render to the
            LEFT of the mode selector; other modes show just the selector. The keyboard
            still drives them (X flips, B/A jump, H highlight - see ImageLightbox). */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {mode === 'ab' && (
            <>
              <span title="X flips · B = Before · A = After">
                <SegmentedToggle
                  value={view}
                  onChange={onViewChange}
                  options={[{ value: 'before', label: 'Before' }, { value: 'after', label: 'After' }]}
                />
              </span>
              <label
                title={canDiff ? 'Highlight changed pixels in magenta (H)' : 'Needs both a before and after image'}
                className={`flex items-center gap-1 text-[10px] font-medium tracking-wide select-none ${
                  canDiff ? 'cursor-pointer text-gray-500 dark:text-gray-400' : 'opacity-40 cursor-not-allowed text-gray-400 dark:text-gray-500'
                }`}
              >
                <input
                  type="checkbox"
                  checked={highlight && canDiff}
                  disabled={!canDiff}
                  onChange={(e) => onHighlightChange(e.target.checked)}
                  className="accent-blue-500 cursor-pointer disabled:cursor-not-allowed"
                />
                Highlight
              </label>
            </>
          )}
          {/* Switch comparison modes without leaving the lightbox. */}
          <SegmentedToggle value={mode} onChange={onModeChange} options={IMAGE_DIFF_MODES} />
        </div>
      </div>
    </ABControlsContext.Provider>
  )
}
