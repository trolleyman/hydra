// The close-up of what a pin points at, frozen when the pin is placed.
//
// This is the image analogue of the fenced ```diff block a line comment already
// stores. A comment that keeps only coordinates is readable exactly as long as
// the picture behind it survives unchanged - and an artifact is regenerated on
// every commit, so that is not long. A crop makes the remark self-describing
// forever: it can be shown in a chat row, in a list, or next to the reply two
// rounds later, without loading a whole screenshot to display a dot in it.
//
// It is taken in the BROWSER rather than on the server, and that is the decision
// that makes it work at all. The server would have to decode every format an
// artifact can be - including SVG, which Go cannot render, and a frame of a
// .webm, which needs ffmpeg. The browser has already decoded and painted the
// thing; drawing it to a canvas is free and format-blind. The blobs are
// same-origin, so the canvas is never tainted.

/** How wide the stored crop is, at most. Big enough to read a control in a
 *  screenshot, small enough that a comment costs a few KB rather than a few MB. */
const MAX_W = 400
/** And how tall, so a crop of a very vertical region stays a thumbnail. */
const MAX_H = 300
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

export interface CropSource {
  /** The painted element. A <video> must be at the frame being pinned. */
  el: CanvasImageSource & { readonly width?: number; readonly height?: number }
  /** The media's natural pixel size - what the crop rectangle is computed in. */
  naturalW: number
  naturalH: number
}

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

/** How big the stored crop should be for a source rectangle - scaled down to fit
 *  the caps, never up (blowing a 40px region up to 400 only stores blur). */
export function cropOutputSize(w: number, h: number): { w: number; h: number } {
  const scale = Math.min(1, MAX_W / w, MAX_H / h)
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) }
}

/**
 * Draws the crop and returns it as a PNG data URL, or null when it cannot be
 * taken (no 2D context, a zero-sized source, a tainted canvas).
 *
 * Null is a normal outcome, not a failure to report: the comment is still worth
 * storing without its picture, and the anchor still says where to look. Losing
 * the remark because the thumbnail could not be drawn would be much worse.
 */
export function captureCrop(source: CropSource, pin: CropPin): string | null {
  const { el, naturalW, naturalH } = source
  if (!(naturalW > 0) || !(naturalH > 0)) return null
  const r = cropRect(pin, naturalW, naturalH)
  const out = cropOutputSize(r.w, r.h)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = out.w
    canvas.height = out.h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(el, r.x, r.y, r.w, r.h, 0, 0, out.w, out.h)
    return canvas.toDataURL('image/png')
  } catch {
    // Chiefly a SecurityError from a cross-origin source. Same-origin is the
    // norm here, so this is a guard rather than an expected path.
    return null
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi))
}
