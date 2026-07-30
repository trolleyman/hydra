// Which part of a picture a pin's close-up shows.
//
// A pin's whole value is being able to go back and look at what it points at, so
// a card has to show that spot rather than the whole screenshot the pin is one
// dot in. The picture itself is still the source - the artifact cache entry a
// comment anchors to is PINNED against pruning (artifacts.Pin), so it stays
// retrievable - and this is only the arithmetic that frames it.
//
// Nothing is stored, and nothing is resized here. An earlier version froze a PNG
// of the region at pin time, which meant a write path, a blob route, PNG
// validation and a decompression-bomb check, all to keep a derived copy of
// something the cache was about to delete. Keeping the ORIGINAL instead is both
// less code and more useful: the full picture is still there to open, not just a
// thumbnail of it. The card frames it with percentage background sizing, so how
// BIG the close-up is drawn is the card's business, not this module's.

/** For a POINT pin, how much of the picture to take around it. A point says
 *  "here", not "this region", so the crop has to supply its own context - too
 *  tight and it is an unrecognisable patch of pixels. */
const POINT_FRACTION = 0.22
/** The smallest a point crop may be in source pixels, so a pin on a small image
 *  does not produce a 30px thumbnail. */
const MIN_POINT_PX = 160
/** Padding around a BOX pin, as a fraction of the box, so the region is shown in
 *  its surroundings rather than cut out of them. */
const BOX_PAD = 0.35

export interface CropPin {
  x: number
  y: number
  w?: number
  h?: number
}

/** The source-pixel rectangle a pin's crop should cover. Exported for testing:
 *  the framing rules are the interesting part, and they are pure arithmetic. */
export function cropRect(pin: CropPin, naturalW: number, naturalH: number): { x: number; y: number; w: number; h: number } {
  const isBox = !!(pin.w && pin.h)
  let w: number
  let h: number
  let cx: number
  let cy: number
  if (isBox) {
    w = pin.w! * naturalW * (1 + BOX_PAD * 2)
    h = pin.h! * naturalH * (1 + BOX_PAD * 2)
    cx = (pin.x + pin.w! / 2) * naturalW
    cy = (pin.y + pin.h! / 2) * naturalH
  } else {
    w = Math.max(naturalW * POINT_FRACTION, MIN_POINT_PX)
    h = Math.max(naturalH * POINT_FRACTION, MIN_POINT_PX)
    cx = pin.x * naturalW
    cy = pin.y * naturalH
  }
  // Never ask for more than there is, or the crop is mostly blank canvas.
  w = Math.min(w, naturalW)
  h = Math.min(h, naturalH)
  // Slide the window back inside the picture rather than clipping it, so a pin
  // near an edge still gets a full-size crop - just an off-centre one.
  const x = clamp(cx - w / 2, 0, naturalW - w)
  const y = clamp(cy - h / 2, 0, naturalH - h)
  return { x, y, w, h }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi))
}
