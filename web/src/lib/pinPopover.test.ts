import { describe, it, expect } from 'vitest'
import { placePinPopover } from './pinPopover'

const size = { w: 320, h: 200 }
const viewport = { w: 1000, h: 800 }

describe('placePinPopover', () => {
  it('rests at the bottom-right of the pin when there is room', () => {
    const p = placePinPopover({ anchor: { x: 100, y: 100 }, size, viewport })
    expect(p.corner).toBe('bottom-right')
    expect(p.left).toBe(112)
    expect(p.top).toBe(112)
  })

  // Each axis flips on its own, which is what produces the other three corners
  // without any of them being a special case.
  it('flips to the left when the box would run off the right edge', () => {
    const p = placePinPopover({ anchor: { x: 900, y: 100 }, size, viewport })
    expect(p.corner).toBe('bottom-left')
    expect(p.left).toBe(900 - 12 - 320)
  })

  it('flips upward when the box would run off the bottom edge', () => {
    const p = placePinPopover({ anchor: { x: 100, y: 750 }, size, viewport })
    expect(p.corner).toBe('top-right')
    expect(p.top).toBe(750 - 12 - 200)
  })

  it('flips both ways in the bottom-right corner of the screen', () => {
    const p = placePinPopover({ anchor: { x: 950, y: 780 }, size, viewport })
    expect(p.corner).toBe('top-left')
    expect(p.left).toBe(950 - 12 - 320)
    expect(p.top).toBe(780 - 12 - 200)
  })

  // A composer half off screen cannot be typed into, so when neither side fits
  // the box is pulled back inside rather than left aligned to its pin.
  it('clamps into the viewport when no flip fits', () => {
    const tall = { w: 320, h: 700 }
    const p = placePinPopover({ anchor: { x: 10, y: 400 }, size: tall, viewport })
    expect(p.top).toBeGreaterThanOrEqual(8)
    expect(p.top + tall.h).toBeLessThanOrEqual(viewport.h - 8)
    expect(p.left).toBeGreaterThanOrEqual(8)
  })

  // Clamping must not produce a negative offset on a viewport smaller than the
  // box itself - that would push it off the top/left instead of the bottom/right.
  it('never places the box outside the viewport origin', () => {
    const huge = { w: 2000, h: 2000 }
    const p = placePinPopover({ anchor: { x: 500, y: 400 }, size: huge, viewport })
    expect(p.left).toBe(8)
    expect(p.top).toBe(8)
  })
})
