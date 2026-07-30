// Where to put the box that opens ON a pin.
//
// A remark about a spot in a picture should be written next to that spot, not in
// a panel somewhere else - the whole point of pinning is that the position is
// part of the sentence. So the composer hangs off the pin, and the only question
// is which way, because a pin near an edge would push it off screen.
//
// It is a pure function, and separate from the component, because the interesting
// part is entirely arithmetic: the four corners, the order they are preferred in,
// and what happens when none of them fit. That is worth testing directly rather
// than through a browser.

export type PopoverCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

export interface PopoverPlacement {
  left: number
  top: number
  corner: PopoverCorner
}

/** How far the box sits from the pin, so the marker stays visible beside it. */
const GAP = 12
/** How close to the viewport edge the box may come before it is pulled back. */
const MARGIN = 8

/**
 * Places a box of `size` against a pin at `anchor` (both in client pixels).
 *
 * Bottom-right is the resting choice: it reads as "this belongs to the thing
 * up-left of it", and it is where a right-handed pointer has just left the
 * cursor. Each axis then flips INDEPENDENTLY when the box would not fit, which
 * is what yields the other three corners - so a pin at the bottom-right of a
 * picture opens its composer up and to the left, and one at the top-left opens
 * down and to the right, without either being a special case.
 *
 * Flipping can still fail on a small viewport (a box taller than the space above
 * OR below the pin). The result is then clamped rather than left hanging off the
 * edge: a composer half off screen cannot be typed into, and being slightly
 * misaligned with its pin is much the lesser problem.
 */
export function placePinPopover(opts: {
  anchor: { x: number; y: number }
  size: { w: number; h: number }
  viewport: { w: number; h: number }
}): PopoverPlacement {
  const { anchor, size, viewport } = opts
  // Fits to the right of the pin? Otherwise put it to the left.
  const right = anchor.x + GAP + size.w <= viewport.w - MARGIN
  // Fits below? Otherwise above.
  const below = anchor.y + GAP + size.h <= viewport.h - MARGIN
  const left = right ? anchor.x + GAP : anchor.x - GAP - size.w
  const top = below ? anchor.y + GAP : anchor.y - GAP - size.h
  const corner: PopoverCorner = below
    ? (right ? 'bottom-right' : 'bottom-left')
    : (right ? 'top-right' : 'top-left')
  return {
    left: clamp(left, MARGIN, Math.max(MARGIN, viewport.w - size.w - MARGIN)),
    top: clamp(top, MARGIN, Math.max(MARGIN, viewport.h - size.h - MARGIN)),
    corner,
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
