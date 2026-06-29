import { useEffect, useState } from 'react'
import { ImageDiffView, SegmentedToggle, IMAGE_DIFF_MODES, type ImageDiffMode } from './ArtifactImageDiff'

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
export function LightboxDiff({ left, right, name, initialMode, onDims }: {
  left?: string | null
  right?: string | null
  name: string
  initialMode: ImageDiffMode
  // Reports the representative image's natural pixel size once measured, so the
  // lightbox caption can show "W × H" for a diff entry just like a plain image.
  onDims?: (d: { w: number; h: number }) => void
}) {
  const [mode, setMode] = useState<ImageDiffMode>(initialMode)
  const [aspect, setAspect] = useState<number | null>(null)

  // Measure the pair's aspect ratio (from whichever side exists) so the comparator can
  // be sized to the displayed image and capped to the viewport height — and report the
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

  // Width drives the layout; folding the 78vh height cap through the aspect ratio keeps
  // a wide shot from overflowing vertically. Side-by-side shows two images in the row,
  // so it gets twice the width budget. Until the aspect loads, fall back to a plain cap.
  const wide = mode === 'side-by-side'
  const maxW = wide ? '94vw' : '84vw'
  const width = aspect != null
    ? `min(${maxW}, calc(78vh * ${aspect}${wide ? ' * 2' : ''}))`
    : maxW

  return (
    <div className="dark flex flex-col items-center gap-3">
      <div style={{ width }} className="max-w-[94vw]">
        <ImageDiffView left={left} right={right} mode={mode} name={name} disableOpen />
      </div>
      {/* Switch comparison modes without leaving the lightbox. */}
      <SegmentedToggle value={mode} onChange={setMode} options={IMAGE_DIFF_MODES} />
    </div>
  )
}
