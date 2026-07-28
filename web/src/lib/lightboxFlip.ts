// FLIP helpers for the fullscreen image lightbox.
//
// The lightbox used to simply fade in over the page, which left the eye to work out
// for itself which of the thumbnails on screen had just become the big picture. Every
// media move is a FLIP instead (First, Last, Invert, Play): measure where the picture
// is NOW (the thumbnail in the page, or the sibling peeking in at the lightbox's
// edge), let it land in its final layout position, then invert that difference as a
// transform and play it out - so the image travels from where it already was to where
// it is going. Only the darkness (and the chrome around the picture) fades.
//
// Everything here is measurement + Web Animations API, deliberately imperative: a
// FLIP has to read layout AFTER React has committed the new position, and the flight
// itself must not re-render the lightbox 60 times a second.

/** A viewport-space box (the subset of DOMRect a flight needs). */
export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** The shared flight ease - the same curve the old slide-in used. */
export const FLIP_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
/** Opening from (and closing back to) a thumbnail: the longest journey. */
export const FLIP_OPEN_MS = 300
/** Stepping to the next/previous image - a shorter hop, so a shorter flight. */
export const FLIP_NAV_MS = 250

// The lightbox's own overlay root (it sets data-lightbox-root), so an origin search
// never picks one of the lightbox's own images as a thumbnail to fly from.
const LIGHTBOX_ROOT_SELECTOR = '[data-lightbox-root]'
/** Class marking the element that hugs the shown media (the ZoomPan frame), so the
 *  lightbox can measure the picture's box rather than the wrapper it is centred in. */
export const LIGHTBOX_MEDIA_CLASS = 'lb-media'

export function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

// Whether flights are both wanted and possible: jsdom (our test environment) has no
// Element.animate, and a reduced-motion preference means no travelling images at all -
// the lightbox falls back to its plain fade in that case.
export function canFlip(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof Element.prototype.animate !== 'function') return false
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

const round = (n: number) => Math.round(n * 100) / 100

/**
 * The transform that puts an element currently occupying `current` onto `target`.
 *
 * The transform is applied around the element's own centre, so the caller may measure
 * the PICTURE and animate a wrapper it is centred inside: both boxes share a centre,
 * so the same translate + scale lands the picture exactly on `target`.
 */
export function flipTransform(current: Rect, target: Rect): string | null {
  if (!current.width || !current.height || !target.width || !target.height) return null
  // One uniform scale (the geometric mean of the two axis ratios) rather than a
  // separate scaleX/scaleY: the same picture is contain-fitted at both ends so the
  // ratios agree, and where they don't (a cropped thumbnail) a uniform scale keeps the
  // image undistorted in flight instead of stretching it on the way.
  const scale = Math.sqrt((target.width / current.width) * (target.height / current.height))
  const dx = target.left + target.width / 2 - (current.left + current.width / 2)
  const dy = target.top + target.height / 2 - (current.top + current.height / 2)
  return `translate(${round(dx)}px, ${round(dy)}px) scale(${round(scale)})`
}

/**
 * Play one flight on `el`, which is laid out at `rest` ('to' for something arriving,
 * 'from' for something leaving). Returns null when the geometry is degenerate or the
 * environment can't animate, in which case the caller should just skip the motion.
 *
 * An arrival ends at the element's real position and holds nothing; a departure keeps
 * its final transform (fill: forwards) so the picture stays where it flew to until the
 * caller unmounts it.
 */
export function playFlip(el: HTMLElement, opts: {
  from: Rect
  to: Rect
  rest: 'from' | 'to'
  duration: number
  /** Opacity at each end, when the flight also has to change it (the edge previews
   *  sit at 40%, the centred picture at 100%). Omit to leave opacity alone. */
  opacity?: [number, number]
}): Animation | null {
  if (typeof el.animate !== 'function') return null
  const arriving = opts.rest === 'to'
  const transform = arriving
    ? flipTransform(opts.to, opts.from)
    : flipTransform(opts.from, opts.to)
  if (!transform) return null
  const [a, b] = opts.opacity ?? []
  const start: Keyframe = { transform: arriving ? transform : 'none' }
  const end: Keyframe = { transform: arriving ? 'none' : transform }
  if (a != null) start.opacity = a
  if (b != null) end.opacity = b
  return el.animate([start, end], {
    duration: opts.duration,
    easing: FLIP_EASE,
    fill: arriving ? 'none' : 'forwards',
  })
}

/**
 * The box of the picture inside `wrapper`: the media frame when there is one (the
 * ZoomPan frame hugs the image, and the comparator, exactly), else the first image,
 * else the wrapper itself. Null while it is still zero-sized - which is how the
 * caller knows the media has not been laid out (or decoded) yet.
 */
export function mediaRectOf(wrapper: Element): Rect | null {
  const el = wrapper.querySelector(`.${LIGHTBOX_MEDIA_CLASS}`) ?? wrapper.querySelector('img') ?? wrapper
  const r = rectOf(el)
  return r.width > 0 && r.height > 0 ? r : null
}

/**
 * Call `cb` with the media's box once it has SETTLED on one, or with null if it still
 * hasn't after `maxFrames` (a broken image, say). Returns a cancel function.
 *
 * Settled means two consecutive frames agree. A freshly mounted frame measures itself
 * with a ResizeObserver, so for the first frame or two it reports zero and then a
 * value that is still a few pixels out - and the flight's whole job is to land the
 * picture exactly where it will rest, so flying to a box that then moves under it
 * shows up as a visible jump at the end.
 */
export function whenMediaLaidOut(
  wrapper: HTMLElement,
  cb: (rect: Rect | null) => void,
  maxFrames = 12,
): () => void {
  let raf = 0
  let frames = 0
  let cancelled = false
  let last: Rect | null = null
  const same = (a: Rect | null, b: Rect | null) =>
    !!a && !!b && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5
      && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5
  const tick = () => {
    if (cancelled) return
    const rect = mediaRectOf(wrapper)
    if (rect && same(rect, last)) return cb(rect)
    last = rect
    if (++frames > maxFrames) return cb(rect)
    raf = requestAnimationFrame(tick)
  }
  tick()
  return () => { cancelled = true; cancelAnimationFrame(raf) }
}

/**
 * The thumbnail this lightbox entry should fly from / back to.
 *
 * `preferred` is the element the lightbox was opened from - always the right answer
 * for the image it was opened on, even when the click landed on a different side of a
 * before/after pair than the entry's own url. Once you have navigated away (or on a
 * gallery whose opener is gone) it falls back to hunting the page for a visible image
 * with the same src, which is what makes closing on image 5 fly back to image 5's
 * thumbnail rather than the one you opened.
 */
export function findLightboxOrigin(
  url: string,
  preferred?: Element | null,
): { el: HTMLElement; rect: Rect } | null {
  if (preferred?.isConnected) {
    const el = preferred instanceof HTMLImageElement ? preferred : preferred.querySelector('img') ?? preferred
    const rect = visibleRect(el)
    if (rect) return { el: el as HTMLElement, rect }
  }
  const href = absolute(url)
  if (!href) return null
  let best: { el: HTMLElement; rect: Rect } | null = null
  for (const img of Array.from(document.images)) {
    if ((img.currentSrc || img.src) !== href) continue
    if (img.closest(LIGHTBOX_ROOT_SELECTOR)) continue
    const rect = visibleRect(img)
    // The largest visible copy: a file can appear both as a small grid tile and as a
    // bigger one, and the big one is the copy the eye is on.
    if (rect && (!best || rect.width * rect.height > best.rect.width * best.rect.height)) {
      best = { el: img, rect }
    }
  }
  return best
}

// On screen and big enough to fly from: a thumbnail scrolled out of the viewport (or
// collapsed to nothing) would have the picture come from somewhere the user cannot
// see, which reads worse than no animation at all.
function visibleRect(el: Element): Rect | null {
  const r = rectOf(el)
  if (r.width < 8 || r.height < 8) return null
  const offScreen = r.top + r.height <= 0 || r.top >= window.innerHeight
    || r.left + r.width <= 0 || r.left >= window.innerWidth
  return offScreen ? null : r
}

function absolute(url: string): string | null {
  try {
    return new URL(url, window.location.href).href
  } catch {
    return null
  }
}
