import { useCallback, useRef, useState } from 'react'

// useMeasuredHeight returns a callback ref + the live offsetHeight of whatever it's
// attached to, re-measuring on resize. The diff viewer's stacked sticky bars (the
// Changes toolbar, each panel's section bar) publish their height as a CSS var so
// the sticky headers below can dock flush beneath them even when a bar wraps to two
// rows. A callback ref (not useEffect) so it re-attaches the observer whenever the
// element mounts - the artifacts/tests panels render null until their data loads.
export function useMeasuredHeight(initial: number): [(el: HTMLElement | null) => void, number] {
  const [height, setHeight] = useState(initial)
  const roRef = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLElement | null) => {
    roRef.current?.disconnect()
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight))
    ro.observe(el)
    roRef.current = ro
    setHeight(el.offsetHeight)
  }, [])
  return [ref, height]
}

// useMeasuredWidth is the same for the live clientWidth - the *content* width,
// excluding borders and any scrollbar, which is the width text inside the
// element actually wraps at. The diff viewer feeds it to diffMetrics so an
// unmounted file body can be measured at the width its rows will really have.
export function useMeasuredWidth(initial: number): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(initial)
  const roRef = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLElement | null) => {
    roRef.current?.disconnect()
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    roRef.current = ro
    setWidth(el.clientWidth)
  }, [])
  return [ref, width]
}
