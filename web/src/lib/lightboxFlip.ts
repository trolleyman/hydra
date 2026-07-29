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

const round = (n: number, dp = 2) => {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

// How far the two ends' aspect ratios may differ before the flight stops trying to
// land exactly. Below it the boxes are the same picture measured through different
// framing (a border here, a rounded-off layout box there) and the mismatch is a
// fraction of a percent; above it they genuinely differ - a square `object-cover`
// chip against a wide screenshot - and no landing can be exact anyway.
const ASPECT_TOLERANCE = 0.05

/**
 * The transform that puts an element currently occupying `current` onto `target`.
 *
 * The transform is applied around the element's own centre, so the caller may measure
 * the PICTURE and animate a wrapper it is centred inside: both boxes share a centre,
 * so the same translate + scale lands the picture exactly on `target`.
 */
export function flipTransform(current: Rect, target: Rect): string | null {
  if (!current.width || !current.height || !target.width || !target.height) return null
  const sx = target.width / current.width
  const sy = target.height / current.height
  // Land EXACTLY (scaleX/scaleY) when the two boxes agree on their aspect ratio to
  // within a whisker - which is the normal case, and the difference between a flight
  // that settles into its thumbnail and one that arrives a pixel or two out and jumps.
  // (A geometric-mean uniform scale splits that error between the two axes, so the
  // picture lands slightly too wide AND slightly too short.) When the ratios really do
  // differ, a uniform scale keeps the picture undistorted in flight instead of
  // stretching it into a shape it never has.
  // Scales are kept to six decimals rather than the two the pixel offsets use: a scale
  // multiplies a box that can be a thousand pixels long, so rounding it as coarsely
  // would put the landing back off by a fraction of a pixel.
  const uniform = Math.abs(sx / sy - 1) > ASPECT_TOLERANCE
  const scale = uniform ? `scale(${round(Math.sqrt(sx * sy))})` : `scale(${round(sx, 6)}, ${round(sy, 6)})`
  const dx = target.left + target.width / 2 - (current.left + current.width / 2)
  const dy = target.top + target.height / 2 - (current.top + current.height / 2)
  return `translate(${round(dx)}px, ${round(dy)}px) ${scale}`
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
/**
 * Whether the user (or the harness) asked for reduced motion. Read per call
 * rather than cached: the OS setting can change while the app is open, and this
 * runs once per flight rather than per frame.
 */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

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
  // The CSS half of this UI already drops its animations under reduced motion
  // (see the @media blocks in index.css); this is the JS half, and a picture
  // flying across the screen is exactly what that setting is asking us not to
  // do. Returning null lands the element at its resting position with no
  // flight - the callers already treat a null flight as "no animation
  // available", which is how a browser without element.animate is handled.
  if (prefersReducedMotion()) return null
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
 * The box of the picture inside `wrapper`: the comparator's own media box if it
 * declares one, else the media frame (the ZoomPan frame hugs a plain image, and a
 * comparator, exactly), else the first image, else the wrapper itself. Null while it
 * is still zero-sized - which is how the caller knows the media has not been laid out
 * (or decoded) yet.
 *
 * data-lb-picture is what a comparator that carries controls of its own (the onion
 * blend's opacity slider sits below the picture, inside the zoom frame) uses to say
 * which part is the picture. The tiles in the page mark the same box, so both ends of
 * a flight measure like for like and it can land exactly.
 */
export function mediaRectOf(wrapper: Element): Rect | null {
  const el = wrapper.querySelector('[data-lb-picture]')
    ?? wrapper.querySelector(`.${LIGHTBOX_MEDIA_CLASS}`)
    ?? wrapper.querySelector('img')
    ?? wrapper
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
    const el = mediaElementIn(preferred)
    const rect = visibleRect(el)
    if (rect) return { el: el as HTMLElement, rect }
  }
  const href = absolute(url)
  if (!href) return null
  let best: { el: HTMLElement; rect: Rect } | null = null
  for (const img of Array.from(document.images)) {
    if ((img.currentSrc || img.src) !== href) continue
    if (img.closest(LIGHTBOX_ROOT_SELECTOR)) continue
    const el = framedBox(img)
    const rect = visibleRect(el)
    // The largest visible copy: a file can appear both as a small grid tile and as a
    // bigger one, and the big one is the copy the eye is on.
    if (rect && (!best || rect.width * rect.height > best.rect.width * best.rect.height)) {
      best = { el: el as HTMLElement, rect }
    }
  }
  return best
}

// The media box inside an opener. An opener is usually the framed media box itself (a
// tile, a button wrapped tightly round an image), and THAT is the box to fly to: it's
// the outer edge, matching what the lightbox measures at the other end, so the two
// boxes agree on their aspect ratio and the flight can land exactly. Only when the
// opener is bigger than the picture inside it - an attachment chip is mostly filename -
// does the inner <img> become the honest answer.
function mediaElementIn(opener: Element): Element {
  if (opener instanceof HTMLImageElement) return framedBox(opener)
  const img = opener.querySelector('img')
  if (!img) return opener
  const o = rectOf(opener)
  const i = rectOf(img)
  const hugs = o.width - i.width <= 8 && o.height - i.height <= 8
  return hugs ? opener : framedBox(img)
}

// A picture's framed box: the media box it is stacked inside when it declares one
// (data-lb-picture - the diff tiles, whose frame is a border on the box rather than on
// the image), else the picture itself. This is the box the lightbox measures at its
// end, so promoting to it is what lets a flight land on the tile exactly rather than a
// pixel inside it.
function framedBox(img: Element): Element {
  return img.closest('[data-lb-picture]') ?? img
}

// Whether the picture is actually there to fly from: on screen, big enough, not
// scrolled out of the pane it lives in, and not buried under something else. A flight
// to a box the user can't see reads worse than no animation at all - the picture
// shoots off to a corner and vanishes - so a thumbnail that fails any of these gives
// up its flight and the lightbox falls back to a plain fade.
function visibleRect(el: Element): Rect | null {
  const r = rectOf(el)
  if (r.width < 8 || r.height < 8) return null
  // Clipped by the viewport and by every scrolling/clipping ancestor (the artifacts
  // pane, a scrollable chat transcript): if most of the box has been cut away, the
  // thumbnail is off the edge of its container rather than on screen.
  let clip: Rect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
    clip = intersect(clip, rectOf(p))
  }
  const shown = intersect(clip, r)
  if (shown.width * shown.height < r.width * r.height * 0.6) return null
  // Buried: whatever is painted at the middle of the box must be the thumbnail itself
  // (or something inside it). The lightbox's own overlay is skipped - on close it
  // covers the whole page, and it is precisely what we are flying back out from under.
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const stack = document.elementsFromPoint(cx, cy).filter((e) => !e.closest(LIGHTBOX_ROOT_SELECTOR))
  const hit = stack[0]
  if (hit && !(hit === el || el.contains(hit) || hit.contains(el))) return null
  return r
}

function intersect(a: Rect, b: Rect): Rect {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.left + a.width, b.left + b.width)
  const bottom = Math.min(a.top + a.height, b.top + b.height)
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

function absolute(url: string): string | null {
  try {
    return new URL(url, window.location.href).href
  } catch {
    return null
  }
}
