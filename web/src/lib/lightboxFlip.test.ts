import { describe, it, expect } from 'vitest'
import { flipTransform, type Rect } from './lightboxFlip'

// The lightbox's flights are pure geometry: the transform that puts the element's
// CURRENT box onto a target box. Getting the sign or the origin wrong is the
// difference between a picture flying out of its thumbnail and one flying out of the
// far corner of the screen, and neither is observable in jsdom (no layout, no
// Element.animate) - so the maths is pinned here instead.
const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height })

// Apply a `translate(...) scale(...)` string to a box the way the browser does:
// scale about the box's own centre, then translate.
function apply(box: Rect, transform: string): Rect {
  const m = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)(?:, ([\d.]+))?\)$/.exec(transform)
  if (!m) throw new Error(`unexpected transform: ${transform}`)
  const [dx, dy, sx] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const sy = m[4] === undefined ? sx : Number(m[4])
  const cx = box.left + box.width / 2 + dx
  const cy = box.top + box.height / 2 + dy
  return { left: cx - (box.width * sx) / 2, top: cy - (box.height * sy) / 2, width: box.width * sx, height: box.height * sy }
}

describe('flipTransform', () => {
  it('lands the current box exactly on the target', () => {
    const current = rect(400, 100, 800, 600) // the picture in the lightbox
    const target = rect(20, 640, 200, 150) // a thumbnail down the page
    const out = apply(current, flipTransform(current, target)!)
    expect(out.left).toBeCloseTo(target.left)
    expect(out.top).toBeCloseTo(target.top)
    expect(out.width).toBeCloseTo(target.width)
    expect(out.height).toBeCloseTo(target.height)
  })

  it('is an identity for a box that is already where it is going', () => {
    const box = rect(10, 20, 300, 200)
    expect(flipTransform(box, box)).toBe('translate(0px, 0px) scale(1, 1)')
  })

  it('lands exactly even when the two boxes disagree slightly on aspect', () => {
    // Both ends measure the same picture, but through different framing (a 1px border
    // on one of them), so the ratios differ in the third decimal. A single averaged
    // scale would land a pixel or two out and jump; per-axis lands on the nose.
    const current = rect(605, 79, 390, 776)
    const target = rect(854, 196, 329, 656)
    const out = apply(current, flipTransform(current, target)!)
    expect(out.left).toBeCloseTo(target.left)
    expect(out.top).toBeCloseTo(target.top)
    expect(out.width).toBeCloseTo(target.width)
    expect(out.height).toBeCloseTo(target.height)
  })

  it('scales uniformly (no stretch) when the two boxes really disagree on aspect', () => {
    // A cover-cropped thumbnail: the flight must keep the picture undistorted rather
    // than squashing it into a shape it never has, so one scale is used for both axes.
    const t = flipTransform(rect(0, 0, 400, 400), rect(0, 0, 200, 100))!
    expect(t).toMatch(/scale\(0\.35\)$/) // sqrt(0.5 * 0.25) ~ 0.3536
  })

  it('refuses a degenerate box, so the caller can skip the flight', () => {
    expect(flipTransform(rect(0, 0, 0, 0), rect(0, 0, 10, 10))).toBeNull()
    expect(flipTransform(rect(0, 0, 10, 10), rect(0, 0, 10, 0))).toBeNull()
  })
})
