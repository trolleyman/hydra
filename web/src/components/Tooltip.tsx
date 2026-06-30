import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

type Placement = 'top' | 'bottom'

// Max width of the compact dark hint, in px. The box wraps at this width (see
// max-w below) so computePos can clamp it on-screen using a known worst case.
const DARK_MAX_WIDTH = 320

interface Position {
  top: number
  left: number
  placement: Placement
  // Horizontal offset of the arrow from the box centre. Always '50%' for the
  // dark variant; the card variant shifts it to keep pointing at the trigger
  // after off-screen clamping nudges the box sideways.
  arrowX: string
}

export interface TooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  /** Hover delay (ms) before showing. Defaults: 600 (dark), 0 (card). */
  delay?: number
  /** Force a side; otherwise auto (dark) or always 'top' (card). */
  side?: Placement
  className?: string
  /**
   * Visual + interaction style:
   *  - 'dark' (default): compact dark hint, non-interactive, auto top/bottom.
   *  - 'card': light info card, hover-interactive, off-screen-clamped, top only.
   */
  variant?: 'dark' | 'card'
  /** Card only: bold heading rendered above the content. */
  title?: string
  /** Card only: fixed width in px (drives both the box and the clamp math). */
  width?: number
}

// One configurable tooltip. The shared core — a portalled, fixed-position box
// anchored to its trigger via getBoundingClientRect — backs both the compact
// hover hints (`variant="dark"`) and the interactive `InfoTooltip` info cards
// (`variant="card"`, see InfoTooltip.tsx).
export function Tooltip({
  content,
  children,
  delay,
  side,
  className,
  variant = 'dark',
  title,
  width = 384,
}: TooltipProps) {
  const card = variant === 'card'
  const showDelay = delay ?? (card ? 0 : 600)

  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState<Position | null>(null)
  const wrapperRef = useRef<HTMLSpanElement>(null)
  // The rendered tooltip box, so computePos can measure its real height and flip
  // sides when it wouldn't fit, instead of guessing a fixed height.
  const boxRef = useRef<HTMLDivElement>(null)
  const showTimer = useRef<number | null>(null)
  const hideTimer = useRef<number | null>(null)
  // Card tooltips are interactive: track whether the pointer is over the box so
  // leaving the trigger doesn't dismiss it while the cursor travels into it.
  const overTooltip = useRef(false)

  const computePos = useCallback((): Position | null => {
    const el = wrapperRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const padding = 8
    // Clamp by the box's REAL width when we have it. The dark hint sizes to its
    // text, so clamping by the 320px cap shoves a short tip (e.g. "Settings")
    // ~160px sideways near a screen edge — box adrift, arrow stretched to reach.
    // On the first paint the box isn't in the DOM yet, so fall back to the cap;
    // the useLayoutEffect below re-runs this with the measured width before paint.
    const maxWidth = card ? width : DARK_MAX_WIDTH
    const clampPad = card ? 16 : 8
    const halfWidth = (boxRef.current?.offsetWidth ?? maxWidth) / 2

    // Clamp horizontally so the box never spills off-screen, then shift the arrow
    // back by the same offset so it still points at the trigger.
    const centerX = rect.left + rect.width / 2
    let left = centerX
    if (left - halfWidth < clampPad) left = halfWidth + clampPad
    else if (left + halfWidth > window.innerWidth - clampPad)
      left = window.innerWidth - halfWidth - clampPad

    // Keep the arrow within the bubble so it can't detach in extreme corners.
    const arrowOffset = Math.max(-(halfWidth - 10), Math.min(halfWidth - 10, centerX - left))

    // Choose a vertical side. Measure the rendered box (falls back to a guess on
    // the first paint, before it exists) and open on whichever side has room,
    // preferring above. This is what stops a box near the top of the viewport
    // from opening upward and getting clipped off-screen.
    const boxHeight = boxRef.current?.offsetHeight ?? (card ? 0 : 36)
    const spaceAbove = rect.top - padding
    const spaceBelow = window.innerHeight - rect.bottom - padding
    let placement: Placement
    if (side) placement = side
    else if (boxHeight <= spaceAbove) placement = 'top'
    else if (boxHeight <= spaceBelow) placement = 'bottom'
    else placement = spaceBelow > spaceAbove ? 'bottom' : 'top'

    return {
      top: placement === 'top' ? rect.top - padding : rect.bottom + padding,
      left,
      placement,
      arrowX: `calc(50% + ${arrowOffset}px)`,
    }
  }, [card, side, width])

  const clearTimers = useCallback(() => {
    if (showTimer.current !== null) {
      window.clearTimeout(showTimer.current)
      showTimer.current = null
    }
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }, [])

  const show = useCallback(() => {
    const p = computePos()
    if (!p) return
    setPos(p)
    setVisible(true)
  }, [computePos])

  const handleMouseEnter = useCallback(() => {
    clearTimers()
    if (showDelay > 0) showTimer.current = window.setTimeout(show, showDelay)
    else show()
  }, [clearTimers, show, showDelay])

  const handleMouseLeave = useCallback(() => {
    clearTimers()
    if (card) {
      // Grace period so the pointer can travel from the trigger into the
      // interactive card without it vanishing underneath.
      hideTimer.current = window.setTimeout(() => {
        if (!overTooltip.current) setVisible(false)
      }, 100)
    } else {
      setVisible(false)
    }
  }, [clearTimers, card])

  // show()'s computePos runs before the box is in the DOM, so it can't measure
  // the real height to pick a side. Re-run once now that it's rendered (synchronous
  // before paint, so no flicker), and keep it fresh on scroll/resize.
  useLayoutEffect(() => {
    if (!visible) return
    const update = () => {
      const p = computePos()
      if (p) setPos(p)
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [visible, computePos])

  useEffect(() => () => clearTimers(), [clearTimers])

  return (
    <span
      ref={wrapperRef}
      className={`inline-flex ${className ?? ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {visible && pos && content && createPortal(
        card ? (
          // Outer wrapper owns the positional transform only (centre + flip) and
          // never animates, so the box snaps to its final spot instantly. The
          // enter animation lives on the inner card below — keeping it off this
          // element is what stops the "rise then settle" slide: tailwindcss-animate's
          // `enter` keyframe rebuilds `transform` from just its own offsets, so if it
          // shared this element it would interpolate away the -translate-y-full and
          // visibly drift into place.
          <div
            ref={boxRef}
            className={`fixed z-[9999] -translate-x-1/2 ${
              pos.placement === 'top' ? '-translate-y-full' : ''
            }`}
            style={{ top: pos.top, left: pos.left }}
            onMouseEnter={() => {
              clearTimers()
              overTooltip.current = true
            }}
            onMouseLeave={() => {
              overTooltip.current = false
              setVisible(false)
            }}
          >
            <div
              className="relative p-3 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 text-[11px] rounded-lg shadow-xl animate-in fade-in zoom-in-95 duration-100 border border-gray-200 dark:border-gray-700"
              style={{ width }}
            >
              {title && <p className="font-bold mb-1.5 border-b border-gray-200 dark:border-gray-700 pb-1">{title}</p>}
              {/* Body text + code spans. Callers tag <code> with text-blue-300 (sized
                  for a dark tooltip); re-tint to a darker blue in light mode here so it
                  stays readable on the white surface (descendant selector wins on
                  specificity, no caller changes needed). */}
              <div className="text-gray-600 dark:text-gray-300 space-y-2 [&_code]:text-blue-700 dark:[&_code]:text-blue-300">
                {content}
              </div>
              {/* Arrow — points down at the trigger when the card is above it, up
                  when the card sits below it. */}
              <div
                className={`absolute -translate-x-1/2 border-8 border-transparent ${
                  pos.placement === 'top'
                    ? 'top-full border-t-white dark:border-t-gray-800'
                    : 'bottom-full border-b-white dark:border-b-gray-800'
                }`}
                style={{ left: pos.arrowX }}
              />
            </div>
          </div>
        ) : (
          <div
            ref={boxRef}
            className={`fixed z-[9999] -translate-x-1/2 pointer-events-none px-2 py-1 bg-gray-900 dark:bg-gray-700 text-white text-[11px] rounded shadow-lg max-w-[320px] break-words border border-gray-700 dark:border-gray-600 ${
              pos.placement === 'top' ? '-translate-y-full' : ''
            }`}
            style={{ top: pos.top, left: pos.left }}
          >
            {content}
            <div
              className={`absolute -translate-x-1/2 border-4 border-transparent ${
                pos.placement === 'top'
                  ? 'top-full border-t-gray-900 dark:border-t-gray-700'
                  : 'bottom-full border-b-gray-900 dark:border-b-gray-700'
              }`}
              style={{ left: pos.arrowX }}
            />
          </div>
        ),
        document.body,
      )}
    </span>
  )
}
