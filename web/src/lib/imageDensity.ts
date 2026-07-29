import { useEffect } from 'react'
import { recallMediaSize, rememberMediaSize, useMediaSize } from './mediaSize'

// Pixel density for images shown in chat.
//
// An <img> is laid out in CSS pixels, so a screenshot captured at 1x is drawn
// into 2x the device pixels on a HiDPI display - a 2x upscale, which is why a
// crisp capture reads as slightly blurry there. The fix is the usual one: ship
// the extra pixels and tell the UI they are extra, so it lays the image out at
// its LOGICAL size (physical px / density) and the browser maps one source pixel
// onto one device pixel.
//
// Chat images have no sidecar to carry that (a Read result is a data URL; a
// markdown image is just a path), so the density rides in the filename with the
// long-standing @2x convention - `popover@2x.png` is a 2x capture. This mirrors
// how ArtifactsPanel already sizes tiles by physical px / dpi from the artifact's
// .meta sidecar; same rule, a source that needs no sidecar.

// Matches a trailing @2x / @3x / @1.5x before the extension, or at the end of a
// name with no extension.
const DENSITY_RE = /@([0-9]+(?:\.[0-9]+)?)x(?:\.[A-Za-z0-9]+)?$/

// densityFromPath reads the @Nx density hint off a file path or URL. Returns 1
// (logical == physical) for anything without one, so an un-hinted image keeps
// its current size. Absurd values are ignored rather than trusted - a filename
// is user input, and a density of 100 would shrink an image to nothing.
export function densityFromPath(path?: string | null): number {
  if (!path) return 1
  // Drop any query/hash, then take the last path segment.
  const clean = path.split(/[?#]/)[0]
  const base = clean.slice(clean.lastIndexOf('/') + 1)
  const m = DENSITY_RE.exec(base)
  if (!m) return 1
  const d = Number(m[1])
  return Number.isFinite(d) && d >= 1 && d <= 4 ? d : 1
}

// useNaturalSize decodes an image off-screen to learn its intrinsic size, so the
// visible <img> can be given an explicit width from its FIRST layout rather than
// painting at full size and then snapping smaller once React learns the density.
// The browser cache makes the visible load free. Returns null until known.
//
// The size is kept in the app-wide cache (lib/mediaSize), not one private to this
// module: it is the same question the lightbox asks about the same files, so a
// picture measured here needs no measuring when it is opened - and one the
// lightbox has already shown needs no decode here at all.
export function useNaturalSize(url: string | null): { w: number; h: number } | null {
  // Read through the shared cache rather than into local state, so the FIRST
  // decode of a file answers for every copy of it: a chat row re-mounts as the
  // transcript grows, and a message can show the same picture twice.
  const size = useMediaSize(url)
  useEffect(() => {
    if (!url || recallMediaSize(url)) return
    const img = new Image()
    img.onload = () => rememberMediaSize(url, img.naturalWidth, img.naturalHeight)
    img.src = url
  }, [url])
  return size
}

// logicalSize converts an image's physical pixel size to the size it should be
// laid out at. Rounded, and never below 1px for a tiny source.
export function logicalSize(size: { w: number; h: number }, density: number): { w: number; h: number } {
  if (density <= 1) return size
  return { w: Math.max(1, Math.round(size.w / density)), h: Math.max(1, Math.round(size.h / density)) }
}
