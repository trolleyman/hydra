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
  const scroller = el.closest<HTMLElement>('[data-inspector-scroll], [data-main-scroll]')
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
