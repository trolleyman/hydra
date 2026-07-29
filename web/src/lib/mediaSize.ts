// Natural pixel sizes for media the app has already seen.
//
// The lightbox reserves a picture's box BEFORE the file loads (the width/height
// attributes in Lightbox), which is what stops it popping in - and shoving the
// caption, the zoom frame and the flight it is meant to be landing on - every
// time you step to the next file with ←/→. That only works if the size is known
// up front. Artifact entries carry it in their metadata, but a markdown image or
// a prompt attachment carries none, so this module is the second source: every
// copy of a file the app decodes (the lightbox's own picture, the sibling peeking
// in at the edge, a thumbnail still on the page behind it) reports its natural
// size here, and the next viewer to open that url gets it for nothing.
//
// Keyed by ABSOLUTE url, so the same file written as "/uploads/x.png" in one
// place and as a full URL in another is one entry.

interface Size { w: number; h: number }

// Plenty for any session's worth of galleries; the cap only exists so a very long
// chat full of images can't grow the map without bound. Oldest-first eviction
// (Map preserves insertion order) - the thing you looked at least recently is the
// one whose size is least likely to be wanted again.
const MAX_ENTRIES = 1000

const sizes = new Map<string, Size>()

function key(url: string | undefined | null): string | null {
  if (!url) return null
  try {
    return new URL(url, window.location.href).href
  } catch {
    return url
  }
}

/** Record `url`'s natural pixel size. Zero/unknown sizes are ignored - a media
 *  element that hasn't decoded yet reports 0, and remembering that would be worse
 *  than remembering nothing. */
export function rememberMediaSize(url: string | undefined | null, w: number, h: number): void {
  const k = key(url)
  if (!k || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return
  // Re-insert so a size that keeps being used stays at the young end of the map.
  sizes.delete(k)
  sizes.set(k, { w, h })
  if (sizes.size > MAX_ENTRIES) {
    const oldest = sizes.keys().next()
    if (!oldest.done) sizes.delete(oldest.value)
  }
}

/** `url`'s natural pixel size, if it can be known without loading the file: from
 *  a previous load, or from a copy that is decoded somewhere in the page right
 *  now. Null when neither applies. */
export function recallMediaSize(url: string | undefined | null): Size | null {
  const k = key(url)
  if (!k) return null
  const hit = sizes.get(k)
  if (hit) return hit
  // Nothing remembered - but a copy may be on screen this moment (the thumbnail
  // that was clicked, the sibling peeking in at the lightbox's edge). naturalWidth
  // is the FILE's size whatever box the copy is drawn in, so a 24px chip answers
  // for a 4K screenshot.
  for (const img of Array.from(document.images)) {
    if ((img.currentSrc || img.src) !== k) continue
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) continue
    const found = { w: img.naturalWidth, h: img.naturalHeight }
    sizes.set(k, found)
    return found
  }
  return null
}

/** Forget everything - tests only, so one case's sizes can't leak into the next. */
export function clearMediaSizes(): void {
  sizes.clear()
}
