import type { PointerEvent, RefObject } from 'react'

// ResizeHandle is the same bottom-centered "grippy" grab bar the spawn box uses
// (a small rounded pill) instead of the browser's native textarea corner grip.
// Dragging it sets the target element's height directly. Callers suppress the
// native grip on their textarea (`resize-none`) and render this below it.
export function ResizeHandle({
  targetRef,
  minHeight = 60,
  className = 'mt-0.5',
}: {
  // The element whose height the drag adjusts (e.g. the textarea or its box).
  targetRef: RefObject<HTMLElement | null>
  minHeight?: number
  className?: string
}) {
  // Pointer events (not mouse) so the drag works with touch + pen too.
  // `touch-none` on the handle keeps the browser from hijacking the gesture for
  // scrolling.
  function handleResizeStart(e: PointerEvent) {
    e.preventDefault()
    const el = targetRef.current
    if (!el) return
    const startY = e.clientY
    const startHeight = el.offsetHeight
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    // A CSS transition covering `height` (e.g. a `transition-all` on the target
    // for its focus ring) would animate every step of the drag, so the box lags
    // the pointer and then catches up in a jump. Pin transitions off for the
    // duration of the drag and restore whatever the element had after.
    const prevTransition = el.style.transition
    el.style.transition = 'none'
    const onMove = (ev: globalThis.PointerEvent) => {
      el.style.height = `${Math.max(minHeight, startHeight + ev.clientY - startY)}px`
    }
    const onUp = () => {
      el.style.transition = prevTransition
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  return (
    <div
      onPointerDown={handleResizeStart}
      className={`group shrink-0 h-2 flex items-center justify-center cursor-ns-resize touch-none ${className}`}
      title="Drag to resize"
    >
      <div className="h-0.5 w-10 rounded-full bg-gray-200 dark:bg-gray-600 group-hover:bg-blue-400/70 group-active:bg-blue-500 transition-colors" />
    </div>
  )
}
