import { describe, it, expect } from 'vitest'
import { cropRect } from './imageCrop'

describe('cropRect', () => {
  // A point says "here", not "this region", so the crop has to supply its own
  // context - a few pixels around the pin would be an unrecognisable patch.
  it('takes a window of context around a point', () => {
    const r = cropRect({ x: 0.5, y: 0.5 }, 1000, 1000)
    expect(r.w).toBeGreaterThan(160)
    expect(r.x + r.w / 2).toBeCloseTo(500)
    expect(r.y + r.h / 2).toBeCloseTo(500)
  })

  // Otherwise a pin on a small image yields a thumbnail too small to read.
  it('does not let a point crop collapse on a small picture', () => {
    const r = cropRect({ x: 0.5, y: 0.5 }, 200, 200)
    expect(r.w).toBe(160)
    expect(r.h).toBe(160)
  })

  // Sliding beats clipping: a pin near an edge still gets a full-size crop,
  // just an off-centre one. Clipping would shrink it to a sliver.
  it('slides the window inside the picture at an edge instead of clipping it', () => {
    const r = cropRect({ x: 0, y: 0 }, 1000, 1000)
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
    expect(r.w).toBeCloseTo(220)
    const far = cropRect({ x: 1, y: 1 }, 1000, 1000)
    expect(far.x + far.w).toBeCloseTo(1000)
    expect(far.y + far.h).toBeCloseTo(1000)
  })

  it('never asks for more picture than there is', () => {
    const r = cropRect({ x: 0.5, y: 0.5 }, 100, 80)
    expect(r.w).toBe(100)
    expect(r.h).toBe(80)
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
  })

  // A box already says what it is about, so the crop only adds enough margin to
  // show it in its surroundings rather than cut out of them.
  it('pads a box rather than framing its centre as a point', () => {
    const r = cropRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1000, 1000)
    expect(r.w).toBeCloseTo(500 * 1.7)
    expect(r.x + r.w / 2).toBeCloseTo(500)
  })
})
