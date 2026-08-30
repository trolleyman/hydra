import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { ShortcutHint } from './Kbd'

type Placement = 'top' | 'bottom'

// One generous cap for every tooltip. Each box still shrink-wraps short content;
// prose only grows to this width before wrapping.
const TOOLTIP_MAX_WIDTH = 520

// How far the rotated-square arrow pokes out past the box edge: half the
// diagonal of an ARROW_SIZE square, i.e. size / 2 * sqrt(2).
const ARROW_SIZE = 10
const ARROW_REACH = (ARROW_SIZE / 2) * Math.SQRT2

// Gap between the trigger and the box. Derived from the arrow's overhang so the
// arrow can never reach back over the trigger - see the arrow comment near the
// bottom of this file for why that overlap used to break hovering.
const GAP = Math.max(8, Math.ceil(ARROW_REACH))

// Floor for the explainer height cap, so a trigger wedged against a viewport
// edge still gets a readable (scrollable) box rather than a 20px sliver.
const MIN_EXPLAINER_HEIGHT = 160
const FADE_MS = 140
const HOVER_DELAY_MS = 600

interface Position {
  top: number
  left: number
  placement: Placement
  // Horizontal offset of the arrow from the box centre. Usually '50%'; shifts
  // to keep pointing at the trigger after off-screen clamping nudges the box
  // sideways.
  arrowX: string
  // Height cap so a long tooltip can never run off-screen (0 = unset,
  // which is what the first pass uses so the natural height can be measured).
  maxHeight: number
}

const samePos = (a: Position | null, b: Position | null) =>
  !!a &&
  !!b &&
  a.top === b.top &&
  a.left === b.left &&
  a.placement === b.placement &&
  a.arrowX === b.arrowX &&
  a.maxHeight === b.maxHeight

export interface TooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  /** Force a side; otherwise auto. */
  side?: Placement
  className?: string
  /** Optional bold heading rendered above the content. */
  title?: string
  /** Extra gap (px) between the trigger and the box, on top of the base 8px -
   *  e.g. to clear a neighbouring control the box would otherwise sit against. */
  offset?: number
  /**
   * A keyboard shortcut for this control, rendered as keycaps on their own line
   * under the label and lowlit (see ShortcutHint). `note` is what the keys do
   * when that differs from the control's main action - a modifier variant, e.g.
   * Alt on the restart button.
   *
   * A prop rather than something a caller composes into `content`, so that every
   * shortcut in the UI lands in the same place, at the same size, in the same
   * component. It used to be prose in brackets - "(Alt: restart without
   * rebuilding)" - which read as part of the sentence and wrapped in the middle
   * of the label.
   */
  shortcut?: { keys: string[]; note?: string }
  /**
   * A lowlit line under everything, including the shortcut: state about the
   * control rather than part of its label (the server's uptime under the
   * restart button). Last because it is the least of the three - you come to
   * the tooltip for the label, might come for the shortcut, and read this only
   * because it is there.
   */
  footnote?: React.ReactNode
}

// One delayed, hover-interactive tooltip. Every box shrink-wraps short content,
// shares one generous maximum width, and can be entered so its text can be
// selected and its links followed.
export function Tooltip({
  content,
  children,
  side,
  className,
  title,
  offset = 0,
  shortcut,
  footnote,
}: TooltipProps) {
  const [visible, setVisible] = useState(false)
  // Keep the portal mounted briefly after dismissal so both compact hints and
  // longer explainers can fade out instead of disappearing between frames.
  const [opaque, setOpaque] = useState(false)
  const [pos, setPos] = useState<Position | null>(null)
  // Dark mode is class-scoped (`@custom-variant dark (&:where(.dark, .dark *))`),
  // so a subtree can force it locally - the image lightbox renders itself dark
  // inside an otherwise light app. The box portals to document.body and would
  // escape that, coming out light-on-dark, so mirror the trigger's theme context
  // onto the portal root. Redundant but harmless when the whole app is dark.
  const [inDark, setInDark] = useState(false)
  const wrapperRef = useRef<HTMLSpanElement>(null)
  // The rendered tooltip box, so computePos can measure its real height and flip
  // sides when it wouldn't fit, instead of guessing a fixed height.
  const boxRef = useRef<HTMLDivElement>(null)
  const showTimer = useRef<number | null>(null)
  const hideTimer = useRef<number | null>(null)
  const fadeTimer = useRef<number | null>(null)
  const fadeFrame = useRef<number | null>(null)
  // Tooltips are interactive: track where the pointer is so leaving one of
  // the two hover regions doesn't dismiss the card while it travels to the other.
  const overTooltip = useRef(false)
  const overTrigger = useRef(false)
  const selectingTooltip = useRef(false)

  const computePos = useCallback((): Position | null => {
    const el = wrapperRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    // Clamp by the box's REAL width when we have it. The hint sizes to its
    // text, so clamping by its max width shoves a short tip (e.g. "Settings")
    // ~160px sideways near a screen edge - box adrift, arrow stretched to reach.
    // On the first paint the box isn't in the DOM yet, so fall back to the cap;
    // the useLayoutEffect below re-runs this with the measured width before paint.
    const clampPad = 8
    const halfWidth = (boxRef.current?.offsetWidth ?? TOOLTIP_MAX_WIDTH) / 2

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
    const measured = boxRef.current
    const boxHeight = measured ? measured.offsetHeight : 36
    const spaceAbove = rect.top - GAP
    const spaceBelow = window.innerHeight - rect.bottom - GAP
    let placement: Placement
    if (side) placement = side
    else if (boxHeight <= spaceAbove) placement = 'top'
    else if (boxHeight <= spaceBelow) placement = 'bottom'
    else placement = spaceBelow > spaceAbove ? 'bottom' : 'top'

    // Cap a tooltip to the room on its chosen side (it scrolls past that) so long
    // prose can't run off the bottom of a phone screen. Only once the box
    // exists: the first pass must render at natural height so there is a real
    // height to pick a side from.
    const avail = placement === 'top' ? spaceAbove : spaceBelow
    const maxHeight =
      measured ? Math.max(MIN_EXPLAINER_HEIGHT, avail - offset - GAP) : 0

    return {
      top: placement === 'top' ? rect.top - GAP - offset : rect.bottom + GAP + offset,
      left,
      placement,
      arrowX: `calc(50% + ${arrowOffset}px)`,
      maxHeight,
    }
  }, [side, offset])

  const clearTimers = useCallback(() => {
    if (showTimer.current !== null) {
      window.clearTimeout(showTimer.current)
      showTimer.current = null
    }
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
    if (fadeTimer.current !== null) {
      window.clearTimeout(fadeTimer.current)
      fadeTimer.current = null
    }
    if (fadeFrame.current !== null) {
      window.cancelAnimationFrame(fadeFrame.current)
      fadeFrame.current = null
    }
  }, [])

  const show = useCallback(() => {
    const p = computePos()
    if (!p) return
    setInDark(!!wrapperRef.current?.closest('.dark'))
    setPos(p)
    setVisible(true)
    setOpaque(false)
    fadeFrame.current = window.requestAnimationFrame(() => {
      fadeFrame.current = null
      setOpaque(true)
    })
  }, [computePos])

  const beginHide = useCallback(() => {
    setOpaque(false)
    fadeTimer.current = window.setTimeout(() => {
      fadeTimer.current = null
      setVisible(false)
    }, FADE_MS)
  }, [])

  const hide = useCallback(() => {
    clearTimers()
    beginHide()
  }, [beginHide, clearTimers])

  // Is the pointer's destination inside the trigger? The portalled card is a
  // React CHILD of the wrapper span, so React propagates the card's own
  // mouseleave up to the wrapper as well - the two are indistinguishable by
  // which handler ran. `relatedTarget` (the element being entered) is what tells
  // them apart, and it is also how we spot the pointer coming back from the card
  // onto the trigger, which fires a leave with no matching enter to answer it.
  const inTrigger = useCallback(
    (n: EventTarget | null) => n instanceof Node && !!wrapperRef.current?.contains(n),
    [],
  )

  // Dismiss unless the pointer has landed in one of the two hover
  // regions (the trigger, or the card itself).
  const scheduleHide = useCallback(() => {
    clearTimers()
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null
      if (!overTooltip.current && !overTrigger.current && !selectingTooltip.current) beginHide()
    }, 100)
  }, [beginHide, clearTimers])

  const handleMouseEnter = useCallback(() => {
    overTrigger.current = true
    clearTimers()
    if (visible) {
      setOpaque(true)
      return
    }
    showTimer.current = window.setTimeout(show, HOVER_DELAY_MS)
  }, [clearTimers, show, visible])

  const handleMouseLeave = useCallback(
    (e: React.MouseEvent) => {
      // A leave that lands back inside the trigger is the card's own leave
      // propagating up the React tree - the pointer never left us.
      if (inTrigger(e.relatedTarget)) return
      overTrigger.current = false
      clearTimers()
      scheduleHide()
    },
    [clearTimers, scheduleHide, inTrigger],
  )

  // Keyboard parity: help text should be reachable without a mouse.
  // Only for focus-visible, so clicking the trigger with a mouse doesn't latch
  // the card open via the focus it leaves behind.
  const handleFocus = useCallback(
    (e: React.FocusEvent) => {
      if (e.target instanceof Element && !e.target.matches(':focus-visible')) return
      clearTimers()
      show()
    },
    [clearTimers, show],
  )

  const handleBlur = useCallback(() => {
    if (!overTooltip.current && !overTrigger.current) hide()
  }, [hide])

  const handleClick = useCallback((e: React.MouseEvent) => {
    // A trigger click performs the control's action and dismisses its hint.
    // Clicks inside the portalled box must remain usable for links and text
    // selection even though React bubbles them through this wrapper.
    if (e.target instanceof Node && boxRef.current?.contains(e.target)) return
    hide()
  }, [hide])

  // Selection is allowed to drag outside the box. A normal mouseleave during
  // that drag must not start dismantling the selection's own DOM underneath it.
  useEffect(() => {
    if (!visible) return
    const onUp = () => {
      if (!selectingTooltip.current) return
      selectingTooltip.current = false
      if (!overTooltip.current && !overTrigger.current) scheduleHide()
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [visible, scheduleHide])

  // show()'s computePos runs before the box is in the DOM, so it can't measure
  // the real height to pick a side. Re-run once now that it's rendered (synchronous
  // before paint, so no flicker), and keep it fresh on scroll/resize. The
  // ResizeObserver also settles the two-pass height cap: pass one measures the
  // natural height and picks a side, pass two applies the cap, which resizes the
  // box and lands us back here to reposition against the new height.
  useLayoutEffect(() => {
    if (!visible) return
    const update = () => {
      const p = computePos()
      if (p) setPos((prev) => (samePos(prev, p) ? prev : p))
    }
    update()
    // Guarded: jsdom has no ResizeObserver, and without it the box simply keeps
    // the position the update() above computed (fine - only the height-cap
    // settling pass needs it).
    const ro =
      boxRef.current && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    if (ro && boxRef.current) ro.observe(boxRef.current)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      ro?.disconnect()
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [visible, computePos])

  useEffect(() => () => clearTimers(), [clearTimers])

  // Shared surface. Light in light mode, dark in dark mode -
  // the old hint was black in both, which made it look like a different widget
  // from the card it sits next to.
  const surface =
    'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700'

  // The arrow is a rotated square rather than a CSS-triangle: a triangle has no
  // border, so it punched a borderless wedge through the box's outline. Two of
  // the square's edges carry the border and continue the outline; the box paints
  // over the other two. It is also pointer-events-none - it overhangs toward the
  // trigger, and when it was hit-testable it stole the trigger's :hover (icon
  // colour and cursor flicking back and forth) as well as toggling the card.
  // rotate-45 puts a corner at each compass point: the top-left corner points up
  // and the bottom-right one points down, so the two edges meeting at that
  // corner are the ones that need the border. Declared as `border-b border-r`
  // rather than `border` plus transparent overrides - `dark:border-gray-700`
  // sets border-color for all four sides and cascades after the per-side
  // utilities, which silently re-coloured the hidden edges in dark mode.
  const arrow = (placement: Placement) => (
    <div
      aria-hidden
      className={`absolute -translate-x-1/2 rotate-45 pointer-events-none ${surface} ${
        placement === 'top' ? 'border-b border-r' : 'border-t border-l'
      }`}
      style={{
        width: ARROW_SIZE,
        height: ARROW_SIZE,
        left: pos?.arrowX,
        // Centre the square on the box edge, so exactly ARROW_REACH of it pokes
        // out and the rest covers (and so erases) the border line behind it.
        bottom: placement === 'top' ? -ARROW_SIZE / 2 : undefined,
        top: placement === 'bottom' ? -ARROW_SIZE / 2 : undefined,
      }}
    />
  )

  return (
    <span
      ref={wrapperRef}
      className={`inline-flex ${className ?? ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onClick={handleClick}
    >
      {children}
      {visible && pos && content && createPortal(
        <div
          ref={boxRef}
          role="tooltip"
          className={`fixed z-[9999] inline-flex -translate-x-1/2 flex-col items-stretch select-text break-words rounded-lg border p-2 text-left text-2xs text-gray-700 shadow-lg transition-opacity duration-150 ease-out motion-reduce:transition-none dark:text-gray-200 ${surface} ${opaque ? 'opacity-100' : 'pointer-events-none opacity-0'} ${inDark ? 'dark' : ''} ${pos.placement === 'top' ? '-translate-y-full' : ''}`}
          style={{
            top: pos.top,
            left: pos.left,
            width: 'max-content',
            maxWidth: `min(${TOOLTIP_MAX_WIDTH}px, calc(100vw - 1rem))`,
            maxHeight: pos.maxHeight || undefined,
          }}
          onMouseDown={(e) => {
            if (e.button !== 0) return
            selectingTooltip.current = true
            clearTimers()
          }}
          onMouseEnter={() => {
            clearTimers()
            overTooltip.current = true
          }}
          onMouseLeave={(e) => {
            overTooltip.current = false
            if (inTrigger(e.relatedTarget)) overTrigger.current = true
            scheduleHide()
          }}
        >
          {title && <p className="mb-1.5 shrink-0 border-b border-gray-200 pb-1 font-bold dark:border-gray-700">{title}</p>}
          <div className="min-h-0 space-y-2 overflow-y-auto text-gray-600 [&_code]:text-blue-700 dark:text-gray-300 dark:[&_code]:text-blue-300">
            {content}
          </div>
          {shortcut && (
            <div className="mt-1.5">
              <ShortcutHint keys={shortcut.keys} note={shortcut.note} />
            </div>
          )}
          {footnote && <div className="mt-1.5 text-3xs text-gray-500 dark:text-gray-400">{footnote}</div>}
          {arrow(pos.placement)}
        </div>,
        document.body,
      )}
    </span>
  )
}
