// Scroll helpers shared by the diff viewer. Both exist for the same reason: a
// diff's layout is not stable while you scroll through it. Cards below the
// viewport hold an ESTIMATED placeholder height until they mount their real
// rows, so any scroll that moves other cards into the lazy-mount margin also
// changes how much content sits above the thing you were aiming at. A single
// measurement is therefore always stale by the time the scroll lands - each
// helper re-measures every frame instead.

function scrollerFor(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>('[data-inspector-scroll], [data-main-scroll]')
}

// pinCardToTop keeps a just-collapsed card docked at the top of its scroll
// container while the collapse settles. A one-shot scrollIntoView is not
// enough: the upward jump brings lazy diff-card placeholders into view, which
// then mount and swap their ESTIMATED heights for measured ones - shifting
// everything below (the deeper the scroll, the more estimated content above,
// the bigger the drift). So instead of trusting one measurement, this runs a
// short rAF loop that re-corrects the scroll each frame (through the 200ms
// collapse glide and the est->real swaps) until the layout is stable.
//
// The element's scroll-margin-top is honored as the dock offset (it accounts
// for the sticky Changes/section bars). No-op when the card top is already
// visible, or when the card isn't inside a known scroll container.
export function pinCardToTop(el: HTMLElement, durationMs = 400) {
  const scroller = scrollerFor(el)
  if (!scroller) return
  if (el.getBoundingClientRect().top >= scroller.getBoundingClientRect().top) return
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0
  const start = performance.now()
  const step = () => {
    const target = scroller.getBoundingClientRect().top + margin
    const delta = el.getBoundingClientRect().top - target
    if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
    if (performance.now() - start < durationMs) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

// Jump-to-file tuning. The glide is a fixed fraction of the remaining distance
// per frame (with a floor so the tail doesn't crawl), not a fixed-duration
// tween - the destination moves, so there is no distance to tween over.
const GLIDE_FRACTION = 0.22
const GLIDE_MIN_STEP = 12
// Past this the glide gives up and jumps, so a target that keeps running away
// (very tall cards mounting above it) still gets caught.
const GLIDE_MAX_MS = 800
// How long to keep re-correcting after the card first lands, to catch bodies
// that mount a frame or two later.
const SETTLE_MS = 500
// Absolute deadline, so a target that can never be reached (the last file, too
// short to scroll to the top) doesn't leave the loop running.
const DEADLINE_MS = 2500

const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'pointerdown'] as const

let cancelActive: (() => void) | null = null

// scrollCardToTop docks a diff file card at the top of its scroll container
// (honoring its scroll-margin-top, which clears the sticky Changes/file bars)
// and keeps correcting until the layout settles.
//
// The native scrollIntoView({behavior:'smooth'}) this replaces picked its
// destination once, up front, from a layout full of estimated placeholder
// heights - and then invalidated that very estimate on the way there, by
// scrolling cards into the lazy-mount margin so they swapped estimates for real
// (taller, wrapped) rows. The further the jump, the more it undershot. Here the
// card's live position is re-read every frame, so mid-flight reflow just moves
// the target and the glide follows it.
//
// Long jumps are taken instantly rather than glided: gliding across a big diff
// would drag every card in between into the mount margin, which is both slow
// and pointless when none of it is meant to be read. Any real user scroll input
// aborts - we never fight the user for the scrollbar.
// scrollToDiffLine centres a specific diff line (identified by its gutter
// `data-diff-ln="<side>:<num>"` cell, scoped to one file's card so the same line
// number in other files can't be matched) in the scroll container, and keeps
// correcting until the layout settles - same rationale as scrollCardToTop.
//
// The card is re-acquired every frame via getCard() because the target file may
// not be mounted yet at call time (single-file view swaps the card; a collapsed
// or hidden file mounts its body only once it nears the viewport). Until the row
// exists we glide the card toward the top to force its lazy body to mount; once
// the row appears we glide it to the vertical centre. onArrive fires once, when
// the row first lands, for a transient highlight.
export function scrollToDiffLine(
  getCard: () => HTMLElement | null,
  side: 'old' | 'new',
  lineNum: number,
  onArrive?: (row: HTMLElement) => void,
) {
  cancelActive?.()
  const sel = `[data-diff-ln="${side}:${lineNum}"]`
  const start = performance.now()
  let raf = 0
  let arrivedAt = 0
  let scroller: HTMLElement | null = null
  const stop = () => {
    cancelAnimationFrame(raf)
    if (scroller) for (const ev of USER_SCROLL_EVENTS) scroller.removeEventListener(ev, stop)
    if (cancelActive === stop) cancelActive = null
  }
  const glide = (delta: number) => {
    const jump = Math.abs(delta) > 2 * scroller!.clientHeight || performance.now() - start >= GLIDE_MAX_MS
    scroller!.scrollTop += jump
      ? delta
      : Math.sign(delta) * Math.min(Math.abs(delta), Math.max(GLIDE_MIN_STEP, Math.abs(delta) * GLIDE_FRACTION))
  }
  const step = () => {
    const now = performance.now()
    const card = getCard()
    // Bind the scroller (and its user-scroll aborts) as soon as a card exists.
    if (card && !scroller) {
      scroller = scrollerFor(card)
      if (scroller) for (const ev of USER_SCROLL_EVENTS) scroller.addEventListener(ev, stop, { passive: true })
    }
    if (!card || !scroller) {
      if (now - start >= DEADLINE_MS) return stop()
      raf = requestAnimationFrame(step)
      return
    }
    const row = card.querySelector<HTMLElement>(sel)
    if (!row) {
      // Phase A: no row yet - dock the card near the top so its lazy body mounts.
      if (now - start >= DEADLINE_MS) return stop()
      const margin = parseFloat(getComputedStyle(card).scrollMarginTop) || 0
      glide(card.getBoundingClientRect().top - (scroller.getBoundingClientRect().top + margin))
      raf = requestAnimationFrame(step)
      return
    }
    // Phase B: centre the row and settle.
    const sc = scroller.getBoundingClientRect()
    const rr = row.getBoundingClientRect()
    const delta = (rr.top + rr.height / 2) - (sc.top + scroller.clientHeight / 2)
    if (Math.abs(delta) <= 1) {
      if (!arrivedAt) { arrivedAt = now; onArrive?.(row) }
      if (now - arrivedAt >= SETTLE_MS) return stop()
    } else if (now - start >= DEADLINE_MS) {
      return stop()
    } else {
      arrivedAt = 0
      glide(delta)
    }
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
}

export function scrollCardToTop(el: HTMLElement) {
  cancelActive?.()
  const scroller = scrollerFor(el)
  if (!scroller) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0
  const start = performance.now()
  let raf = 0
  let arrivedAt = 0
  const stop = () => {
    cancelAnimationFrame(raf)
    for (const ev of USER_SCROLL_EVENTS) scroller.removeEventListener(ev, stop)
    if (cancelActive === stop) cancelActive = null
  }
  const step = () => {
    const now = performance.now()
    const delta = el.getBoundingClientRect().top - (scroller.getBoundingClientRect().top + margin)
    if (Math.abs(delta) <= 0.5) {
      if (!arrivedAt) arrivedAt = now
      if (now - arrivedAt >= SETTLE_MS) return stop()
    } else if (now - start >= DEADLINE_MS) {
      return stop()
    } else {
      arrivedAt = 0
      const jump = Math.abs(delta) > 2 * scroller.clientHeight || now - start >= GLIDE_MAX_MS
      const stepPx = jump
        ? delta
        : Math.sign(delta) * Math.min(Math.abs(delta), Math.max(GLIDE_MIN_STEP, Math.abs(delta) * GLIDE_FRACTION))
      scroller.scrollTop += stepPx
    }
    raf = requestAnimationFrame(step)
  }
  for (const ev of USER_SCROLL_EVENTS) scroller.addEventListener(ev, stop, { passive: true })
  cancelActive = stop
  raf = requestAnimationFrame(step)
}
