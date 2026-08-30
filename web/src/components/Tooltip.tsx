import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { ShortcutHint } from './Kbd'

type Placement = 'top' | 'bottom'

// Default max width of the compact hint, in px. The box wraps at this width (see
// max-w below) so computePos can clamp it on-screen using a known worst case. A
// hint whose content wraps badly at this width can raise it with `width`.
const HINT_MAX_WIDTH = 320
const EXPLAINER_WIDTH = 384

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
  /** Hover delay (ms) before showing. Defaults to 600. */
  delay?: number
  /** Force a side; otherwise auto. */
  side?: Placement
  className?: string
  /** Optional bold heading rendered above the content. */
  title?: string
  /** Fixed width in px. Without one, the box sizes to its content up to 320px. */
  width?: number
  /**
   * Whether clicking the trigger latches the tooltip open. Defaults to false.
   * InfoTooltip enables this so explainers also work on touch devices.
   */
  pin?: boolean
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
  /** Override content alignment. Compact labels center and explainers left-align by default. */
  centeredText?: boolean
}

// One configurable, hover-interactive tooltip. A title or explicit width gives
// longer explainers room, while short labels size to their content. Every box
// can be entered so its text can be selected and its links can be followed.
export function Tooltip({
  content,
  children,
  delay,
  side,
  className,
  title,
  width,
  pin = false,
  offset = 0,
  shortcut,
  footnote,
  centeredText,
}: TooltipProps) {
  const roomy = title != null || width != null
  const boxWidth = width ?? (roomy ? EXPLAINER_WIDTH : HINT_MAX_WIDTH)
  const showDelay = delay ?? 600
  const textCentered = centeredText ?? !roomy

  const [visible, setVisible] = useState(false)
  // Click (or tap) can latch the tooltip open so it survives the pointer
  // leaving - the only way to read a long card on a touch device, and what makes
  // an overflowing card scrollable with the mouse.
  const [pinned, setPinned] = useState(false)
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
  // Tooltips are interactive: track where the pointer is so leaving one of
  // the two hover regions doesn't dismiss the card while it travels to the other.
  const overTooltip = useRef(false)
  const overTrigger = useRef(false)

  const computePos = useCallback((): Position | null => {
    const el = wrapperRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    // Clamp by the box's REAL width when we have it. The hint sizes to its
    // text, so clamping by its max width shoves a short tip (e.g. "Settings")
    // ~160px sideways near a screen edge - box adrift, arrow stretched to reach.
    // On the first paint the box isn't in the DOM yet, so fall back to the cap;
    // the useLayoutEffect below re-runs this with the measured width before paint.
    const clampPad = roomy ? 16 : 8
    const halfWidth = (boxRef.current?.offsetWidth ?? boxWidth) / 2

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
    const boxHeight = measured ? measured.offsetHeight : roomy ? 0 : 36
    const spaceAbove = rect.top - GAP
    const spaceBelow = window.innerHeight - rect.bottom - GAP
    let placement: Placement
    if (side) placement = side
    else if (boxHeight <= spaceAbove) placement = 'top'
    else if (boxHeight <= spaceBelow) placement = 'bottom'
    else placement = spaceBelow > spaceAbove ? 'bottom' : 'top'

    // Cap a roomy tooltip to the room on its chosen side (it scrolls past that) so a long
    // explainer can't run off the bottom of a phone screen. Only once the box
    // exists: the first pass must render at natural height so there is a real
    // height to pick a side from.
    const avail = placement === 'top' ? spaceAbove : spaceBelow
    const maxHeight =
      roomy && measured ? Math.max(MIN_EXPLAINER_HEIGHT, avail - offset - GAP) : 0

    return {
      top: placement === 'top' ? rect.top - GAP - offset : rect.bottom + GAP + offset,
      left,
      placement,
      arrowX: `calc(50% + ${arrowOffset}px)`,
      maxHeight,
    }
  }, [roomy, side, boxWidth, offset])

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
    setInDark(!!wrapperRef.current?.closest('.dark'))
    setPos(p)
    setVisible(true)
  }, [computePos])

  const hide = useCallback(() => {
    clearTimers()
    setVisible(false)
    setPinned(false)
  }, [clearTimers])

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
      if (!overTooltip.current && !overTrigger.current) setVisible(false)
    }, 100)
  }, [clearTimers])

  const handleMouseEnter = useCallback(() => {
    overTrigger.current = true
    clearTimers()
    if (visible) return
    if (showDelay > 0) showTimer.current = window.setTimeout(show, showDelay)
    else show()
  }, [clearTimers, show, showDelay, visible])

  const handleMouseLeave = useCallback(
    (e: React.MouseEvent) => {
      // A leave that lands back inside the trigger is the card's own leave
      // propagating up the React tree - the pointer never left us.
      if (inTrigger(e.relatedTarget)) return
      overTrigger.current = false
      clearTimers()
      if (!pinned) scheduleHide()
    },
    [clearTimers, pinned, scheduleHide, inTrigger],
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

  const handleClick = useCallback(() => {
    // The trigger's own click is the action (pin={false}): get out of its way.
    // Pinning here would leave the card sitting over whatever that click just
    // scrolled to or opened, with the pointer already elsewhere.
    if (!pin) {
      hide()
      return
    }
    // Tap-to-open on touch (where there is no hover), click-to-pin on desktop.
    if (visible && pinned) hide()
    else {
      setPinned(true)
      if (!visible) show()
    }
  }, [pin, visible, pinned, hide, show])

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

  // A pinned card is modal-ish: Escape and an outside click are the ways out.
  useEffect(() => {
    if (!visible || !pinned) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrapperRef.current?.contains(t) || boxRef.current?.contains(t)) return
      hide()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [visible, pinned, hide])

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
        roomy ? (
          // Outer wrapper owns the positional transform only (centre + flip) and
          // never animates, so the box snaps to its final spot instantly. The
          // enter animation lives on the inner card below - keeping it off this
          // element is what stops the "rise then settle" slide: tailwindcss-animate's
          // `enter` keyframe rebuilds `transform` from just its own offsets, so if it
          // shared this element it would interpolate away the -translate-y-full and
          // visibly drift into place.
          <div
            ref={boxRef}
            className={`fixed z-[9999] -translate-x-1/2 ${inDark ? 'dark' : ''} ${
              pos.placement === 'top' ? '-translate-y-full' : ''
            }`}
            style={{ top: pos.top, left: pos.left }}
            onMouseEnter={() => {
              clearTimers()
              overTooltip.current = true
            }}
            onMouseLeave={(e) => {
              overTooltip.current = false
              // Pointer heading back onto the trigger: no enter fires there (it
              // never left the wrapper's React subtree), so record it here.
              if (inTrigger(e.relatedTarget)) overTrigger.current = true
              if (!pinned) scheduleHide()
            }}
          >
            <div
              role="tooltip"
              className={`relative flex flex-col p-3 ${surface} border text-gray-800 dark:text-gray-100 text-2xs rounded-lg shadow-xl animate-tooltip-card-in`}
              // Cap to the viewport (minus the 16px clamp pad each side) so the
              // fixed `width` can't spill off-screen on narrow/phone viewports where
              // it exceeds the screen. computePos clamps by the box's REAL
              // offsetWidth, so the capped width also fixes the horizontal position.
              style={{
                width: boxWidth,
                maxWidth: 'calc(100vw - 2rem)',
                maxHeight: pos.maxHeight || undefined,
              }}
            >
              {title && <p className="font-bold mb-1.5 border-b border-gray-200 dark:border-gray-700 pb-1 shrink-0">{title}</p>}
              {/* Body text + code spans. Call sites tag <code> with text-blue-300,
                  which only reads on the dark surface; re-tint to a darker blue for
                  light mode here so it stays legible on white (descendant selector
                  wins on specificity, no caller changes needed). Scrolls when
                  computePos has capped the card's height against the viewport. */}
              <div className="text-gray-600 dark:text-gray-300 space-y-2 overflow-y-auto min-h-0 [&_code]:text-blue-700 dark:[&_code]:text-blue-300">
                {content}
              </div>
              {arrow(pos.placement)}
            </div>
          </div>
        ) : (
          <div
            ref={boxRef}
            role="tooltip"
            // py-2 once there is more than a label in the box: HALF the arrow
            // square (ARROW_SIZE / 2 = 5px) sits INSIDE the box, which is more
            // than a py-1's 4px, so the arrow overlapped whatever ended up
            // against that edge. Nothing did while the box held one line of
            // text - the descender space absorbed it - but a keycap has a
            // border and a drop shadow, and the arrow drew straight over it.
            className={`fixed z-[9999] -translate-x-1/2 px-2 select-text ${
              shortcut || footnote ? 'py-2' : 'py-1'
            } border ${inDark ? 'dark' : ''} ${surface} text-gray-700 dark:text-gray-200 text-2xs ${textCentered ? 'text-center' : ''} rounded shadow-lg break-words ${
              pos.placement === 'top' ? '-translate-y-full' : ''
            }`}
            // width: max-content sizes the box to its text: a fixed-position box
            // otherwise shrink-to-fits against the space to the RIGHT of `left`
            // (the -translate-x-1/2 recenters only after layout), so a trigger
            // near the right viewport edge would wrap even a short tip.
            // Capped at boxWidth (320px unless the caller raised it), but never
            // wider than the viewport (minus the 8px clamp pad each side) so it
            // can't overflow on a phone.
            style={{ top: pos.top, left: pos.left, width: 'max-content', maxWidth: `min(${boxWidth}px, calc(100vw - 1rem))` }}
            onMouseEnter={() => {
              clearTimers()
              overTooltip.current = true
            }}
            onMouseLeave={(e) => {
              overTooltip.current = false
              if (inTrigger(e.relatedTarget)) overTrigger.current = true
              if (!pinned) scheduleHide()
            }}
          >
            {content}
            {shortcut && (
              <div className="mt-1.5">
                <ShortcutHint keys={shortcut.keys} note={shortcut.note} />
              </div>
            )}
            {footnote && <div className="mt-1.5 text-3xs text-gray-500 dark:text-gray-400">{footnote}</div>}
            {arrow(pos.placement)}
          </div>
        ),
        document.body,
      )}
    </span>
  )
}
