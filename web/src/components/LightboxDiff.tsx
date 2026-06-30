import { useEffect, useMemo, useState } from 'react'
import { ABControlsContext, ImageDiffView, SegmentedToggle, IMAGE_DIFF_MODES, type ArtifactABControls, type ImageDiffMode } from './ArtifactImageDiff'

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
// Before/After + Highlight are owned here (not by the grid): a local ABControlsContext
// provider feeds the inner ImageDiffView, and the B / H keys flip/highlight it — scoped
// to the lightbox, so they DON'T also switch the diff grid in the background (that grid's
// identical shortcut bails while the lightbox is open; see ArtifactsPanel).
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
  // Before/After view + magenta highlight for this fullscreen comparator. Highlight
  // needs both sides to diff; with only one (added/removed file) it's disabled.
  const [view, setView] = useState<'before' | 'after'>('after')
  const [highlight, setHighlight] = useState(false)
  const canDiff = !!left && !!right

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

  // B flips Before/After, H toggles Highlight — only when not typing in a field, and
  // plain single keys (no modifiers) so they don't collide with browser chords. These
  // drive only this lightbox comparator (via the context below); the grid's matching
  // shortcut is suppressed while the lightbox is open, so the background diff stays put.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      const k = e.key.toLowerCase()
      if (k === 'b') { e.preventDefault(); setView((v) => (v === 'before' ? 'after' : 'before')) }
      else if (k === 'h') { e.preventDefault(); setHighlight((h) => !h) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Provide the before/after view + highlight to the inner ImageDiffView so its A/B
  // tile reads them (and hides its own per-tile pill) — the lightbox toolbar below is
  // the single control instead.
  const ab = useMemo<ArtifactABControls>(
    () => ({ view, highlight, toggleView: () => setView((v) => (v === 'before' ? 'after' : 'before')) }),
    [view, highlight],
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
        <div style={{ width }} className="max-w-[94vw]">
          <ImageDiffView left={left} right={right} mode={mode} name={name} disableOpen />
        </div>
        {/* Switch comparison modes — and, in A/B mode, flip Before/After or toggle the
            magenta highlight (also B / H on the keyboard) — without leaving the lightbox. */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <SegmentedToggle value={mode} onChange={setMode} options={IMAGE_DIFF_MODES} />
          {mode === 'ab' && (
            <>
              <SegmentedToggle
                value={view}
                onChange={setView}
                options={[{ value: 'before', label: 'Before' }, { value: 'after', label: 'After' }]}
              />
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
                  onChange={(e) => setHighlight(e.target.checked)}
                  className="accent-blue-500 cursor-pointer disabled:cursor-not-allowed"
                />
                Highlight
              </label>
            </>
          )}
        </div>
      </div>
    </ABControlsContext.Provider>
  )
}
