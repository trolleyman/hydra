import { useLayoutEffect, useRef, useState } from 'react'
import { fitPath } from '../lib/pathDisplay'

// Shared off-screen canvas for text measurement (cheap; never attached).
let measureCtx: CanvasRenderingContext2D | null = null
function textWidth(text: string, font: string): number {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d')
    if (!measureCtx) return 0
  }
  measureCtx.font = font
  return measureCtx.measureText(text).width
}

// The sidebar's Repository label: the project's display path fitted to the
// space the row gives it (see lib/pathDisplay.ts for the elision stages).
// Candidates are measured with canvas measureText using the label's computed
// font, and the fit is redone whenever the label resizes (sidebar drag) or the
// path changes.
export function ProjectPathLabel({ path, title }: { path: string; title?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [text, setText] = useState(path)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const refit = () => {
      const width = el.clientWidth
      // Hidden or mid-collapse (0 width): keep the last fit rather than
      // degrading to "...".
      if (width <= 0) return
      const cs = getComputedStyle(el)
      const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      setText(fitPath(path, (candidate) => textWidth(candidate, font) <= width))
    }
    refit()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(refit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [path])

  return (
    // overflow-hidden as a sub-pixel safety net; the fit itself keeps the text
    // within the span's width.
    <span ref={ref} title={title ?? path} className="flex-1 min-w-0 whitespace-nowrap overflow-hidden optical-center">
      {text}
    </span>
  )
}
