// Self-declared reflows: layout the CHAT did to itself, which must not be read
// as the reader scrolling away.
//
// The chat pane follows the bottom of a live turn while "pinned", and drops the
// pin when the reader scrolls up. It tells the two apart geometrically: a
// scrollTop that fell on its own is a shrink (the content got shorter and the
// browser clamped the offset), not a scroll-up. That test works when the shrink
// is the only thing that happened between two scroll events - and a scroll event
// is only dispatched once per frame, so it often isn't. A step folding away as
// the next one arrives, or an image finishing its load right after the text it
// replaced went away, both land as ONE event where the height is unchanged (or
// even larger) and only scrollTop moved: read as a scroll-up, which unpinned the
// view and stopped the chat following the turn.
//
// So the code that causes such a reflow declares it for the length of it, and
// the scroll handler trusts that over the geometry.
let selfReflowUntil = 0

// markSelfReflow claims the next `ms` of layout as the chat's own doing.
export function markSelfReflow(ms = 400): void {
  selfReflowUntil = Math.max(selfReflowUntil, Date.now() + ms)
}

export function inSelfReflow(): boolean {
  return Date.now() < selfReflowUntil
}

// How long a chat image's arrival counts as a self-reflow. Shorter than a fold's
// 400ms (which has to cover a 0.22s animation): an image resizes in a single
// layout, so this only has to outlast the scroll event that reports it - but
// long enough to cover the decode, the size landing and the glide that follows.
// Every ms of it is a ms in which a genuine scroll-up is ignored, so it is kept
// near the floor of human reaction time rather than padded for comfort.
export const IMAGE_REFLOW_MS = 250
