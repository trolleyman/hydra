import { Children, Fragment, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

// SeparatedRow lays out its children on a wrapping flex row with an interpunct
// "·" between each pair — but hides any separator that lands at the start or end
// of a wrapped row, so a leading/trailing "·" never dangles (e.g.
// "claude · running ·⏎ base · created" loses that orphaned middle dot).
//
// Pure CSS can't do this: the usual overflow:hidden + absolute-pseudo trick would
// clip descendant popovers (the base-branch BranchSelector opens downward and
// isn't portaled), so instead we measure the laid-out rows and toggle each
// separator's display. Row membership is detected by the horizontal position
// resetting leftward (robust to items of differing heights, unlike offsetTop).
// We re-measure on every render (content like "created Xs ago" ticks) and on
// width changes (which is the only thing that changes wrapping).
export function SeparatedRow({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const items = Children.toArray(children) // drops null/undefined/false (the conditional children)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const boxes = Array.from(el.children) as HTMLElement[]
    // Reveal every separator first so the geometry reflects the full row.
    for (const b of boxes) if (b.dataset.sep != null) b.style.display = ''
    // Group boxes into visual rows: within a row offsetLeft strictly increases;
    // a wrap resets it back toward the left edge.
    const rows: HTMLElement[][] = []
    let cur: HTMLElement[] = []
    let prevLeft = Infinity
    for (const b of boxes) {
      if (cur.length && b.offsetLeft <= prevLeft) {
        rows.push(cur)
        cur = []
      }
      cur.push(b)
      prevLeft = b.offsetLeft
    }
    if (cur.length) rows.push(cur)
    // A separator first or last on its row is dangling — hide it.
    for (const row of rows) {
      const first = row[0]
      const last = row[row.length - 1]
      if (first?.dataset.sep != null) first.style.display = 'none'
      if (last !== first && last?.dataset.sep != null) last.style.display = 'none'
    }
  }, [])

  // After each render (content may have changed width without a resize event).
  useLayoutEffect(() => {
    measure()
  })

  // On width changes — the only thing that alters wrapping. Guard on width so the
  // display toggles above (which change height, not width) can't re-trigger us.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let lastWidth = el.clientWidth
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width
      if (w === lastWidth) return
      lastWidth = w
      measure()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  return (
    <div ref={ref} className={className}>
      {items.map((child, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span data-sep aria-hidden="true" className="text-gray-300 dark:text-gray-600 select-none">
              ·
            </span>
          )}
          {child}
        </Fragment>
      ))}
    </div>
  )
}
