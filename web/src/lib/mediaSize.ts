// Natural pixel sizes for media the app has already seen.
//
// One app-wide answer to "how big is this file, in pixels?", because two surfaces
// need it before the file has loaded and both need it for the same reason - an
// <img> given no size lays out at nothing and then shoves everything around it
// when the bytes land:
//
//   * the lightbox reserves a picture's box before it loads (the width/height
//     attributes in Lightbox), so stepping ←/→ doesn't pop each one open;
//   * a chat image is laid out at its LOGICAL size - physical px ÷ the @2x
//     density in its name - which cannot be worked out without the physical one
//     (see lib/imageDensity, whose useNaturalSize decodes off-screen to learn it).
//
// So whatever learns a size puts it here: the lightbox's picture and the sibling
// peeking in at its edge, the comparator's probe, a video's metadata, the chat's
// off-screen decode. A file measured on one surface is then free on the other -
// which is the point of sharing one cache rather than one per component.
//
// Keyed by ABSOLUTE url, so the same file written as "/uploads/x.png" in one
// place and as a full URL in another is one entry.

import { useCallback, useSyncExternalStore } from 'react'

interface Size { w: number; h: number }

// Deliberately uncapped. Entries are a url and two numbers, and evicting one is
// worse than it sounds: the chat holds a size for as long as its image is on
// screen, and dropping an entry under it would leave that image stuck at the
// wrong size (its effect only re-runs when the url changes, so nothing would
// re-measure). A transcript long enough to matter is holding far more than this.
const sizes = new Map<string, Size>()

function key(url: string | undefined | null): string | null {
  if (!url) return null
  try {
    return new URL(url, window.location.href).href
  } catch {
    return url
  }
}

// Everyone waiting to be told a size landed. This is a React external store (see
// useMediaSize), NOT a list of one-shot callbacks: a component that re-mounts
// while an answer is in flight - which a chat row does constantly as the
// transcript grows - has to end up subscribed again with no way to miss the
// notification in between. Getting that wrong is invisible in a test and shows
// up as "the size arrives and nothing uses it".
const listeners = new Set<() => void>()

/** Subscribe to size arrivals. Returns the unsubscribe. */
export function subscribeMediaSizes(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => { listeners.delete(onChange) }
}

/** Record `url`'s natural pixel size. Zero/unknown sizes are ignored - a media
 *  element that hasn't decoded yet reports 0, and remembering that would be worse
 *  than remembering nothing. */
export function rememberMediaSize(url: string | undefined | null, w: number, h: number): void {
  const k = key(url)
  if (!k || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return
  const had = sizes.get(k)
  // Re-recording the same numbers must not replace the object: recallMediaSize
  // is a React snapshot, and handing back a fresh object for an unchanged size
  // would re-render (or, in useSyncExternalStore's eyes, never settle).
  if (had && had.w === w && had.h === h) return
  sizes.set(k, { w, h })
  listeners.forEach((l) => l())
}

/** `url`'s remembered natural pixel size, or null. A plain map lookup - safe to
 *  call from a render, however often, and stable: the same url yields the same
 *  object until the size actually changes. */
export function recallMediaSize(url: string | undefined | null): Size | null {
  const k = key(url)
  return k ? (sizes.get(k) ?? null) : null
}

/** `url`'s size, re-rendering when it lands. The size cache is an external
 *  store, so subscribing is what makes this immune to the mount/unmount timing
 *  a one-shot callback gets wrong. */
export function useMediaSize(url: string | undefined | null): Size | null {
  return useSyncExternalStore(
    subscribeMediaSizes,
    useCallback(() => recallMediaSize(url), [url]),
  )
}

/** `url`'s natural pixel size without loading it: remembered, or read off a copy
 *  that is decoded somewhere in the page right now. Null when neither applies.
 *
 *  This is the one that walks the DOM, so it is for a one-off (opening a viewer),
 *  not for every render - recallMediaSize is the cheap read. */
export function discoverMediaSize(url: string | undefined | null): Size | null {
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
  listeners.forEach((l) => l())
}
