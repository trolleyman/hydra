// Presentational helpers shared by the artifact diff viewers — the still-image
// modes in ArtifactsPanel and the video (.webm) modes in VideoDiffView. Kept in
// their own module so both have one source of truth for sizing, the checkerboard
// backdrop, the new-tab affordance and the pixel-diff constants, and so
// VideoDiffView doesn't have to import back from ArtifactsPanel (which renders it
// — that would be a circular import).

// A subtle checkerboard so transparent screenshots/frames read clearly in both themes.
export const checkerStyle: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, rgba(0,0,0,0.06) 25%, transparent 25%), linear-gradient(-45deg, rgba(0,0,0,0.06) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(0,0,0,0.06) 75%), linear-gradient(-45deg, transparent 75%, rgba(0,0,0,0.06) 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
}

// IMG_CLASS sizes the base media (image or video frame); OVERLAY_CLASS stretches an
// overlay to fill the same box so the two align pixel-for-pixel; TAG_CLASS is the
// small "Before"/"After"/"Highlight" corner label.
//
// Sizing is WIDTH-driven: the media fills the width of its masonry tile (w-full)
// and its height follows the natural aspect ratio (h-auto). The tile's width — how
// many columns it spans, chosen automatically from its aspect ratio or overridden by
// dragging its edge (see MasonryGrid) — is the single sizing knob, so a short-but-
// wide screenshot no longer balloons to a large width just because the height was
// the constraint.
export const IMG_CLASS = 'block w-full h-auto rounded-md border border-gray-200 dark:border-gray-700'
export const OVERLAY_CLASS = 'absolute inset-0 w-full h-full object-contain rounded-md border border-gray-200 dark:border-gray-700'
export const TAG_CLASS = 'absolute top-1 z-10 text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded bg-black/55 text-white pointer-events-none'

// Open media in a new tab. In side-by-side mode the media is a target=_blank link,
// so left-click already does this; the overlay modes bind left-click to comparison
// gestures, so they route the new-tab affordance to the middle button.
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

// Bright magenta (#FF00FF) — the colour every changed pixel is painted in the
// "Highlight" view, chosen to stand out against typical UI screenshots.
export const DIFF_COLOR: [number, number, number] = [255, 0, 255]
// Alpha (0–255) the magenta is painted at. Deliberately semi-transparent (~50%)
// so the underlying image still shows through the marked regions — otherwise the
// changed pixels, which are exactly the ones painted, would be fully masked and
// flipping Before↔After would look like it did nothing.
export const DIFF_ALPHA = 128
// A small per-pixel tolerance (sum of the absolute R/G/B/A channel deltas) below
// which two pixels count as equal, so JPEG/codec/anti-aliasing speckle doesn't
// paint a confetti of magenta over otherwise-identical regions. 0 would be exact.
export const DIFF_PIXEL_THRESHOLD = 32
