import { describe, it, expect } from 'vitest'
import { placeMenu } from './anchorMenu'

describe('placeMenu', () => {
  const vw = 1600

  it('opens rightward from the trigger when the panel fits', () => {
    // The agent header's "check out locally" popover: a 340px panel on a
    // trigger sitting well left of centre.
    expect(placeMenu({ triggerLeft: 405, triggerRight: 445, width: 340, viewportWidth: vw }))
      .toEqual({ left: 405, width: 340, side: 'left' })
  })

  it('flips to opening leftward for a trigger at the right edge', () => {
    // A section-header cog: no room to its right, so its right edge meets the
    // trigger's, exactly as the old right-anchored behaviour did.
    expect(placeMenu({ triggerLeft: 1560, triggerRight: 1588, width: 208, viewportWidth: vw, minWidth: 168 }))
      .toEqual({ left: 1380, width: 208, side: 'right' })
  })

  it('shrinks to the room on its side only when minWidth allows it', () => {
    const opts = { triggerLeft: 150, triggerRight: 178, width: 340, viewportWidth: 300 } as const
    // roomRight (300 - 150 - 8 = 142) < roomLeft (170), so it opens leftward
    // and shrinks to 170 - the floor lets it give up width rather than slide.
    expect(placeMenu({ ...opts, minWidth: 168 })).toEqual({ left: 8, width: 170, side: 'right' })
    // Without a floor it keeps its width and is clamped into the viewport.
    expect(placeMenu(opts)).toEqual({ left: 8, width: 284, side: 'right' })
  })

  it('honours an explicit align, and still clamps into the viewport', () => {
    expect(placeMenu({ triggerLeft: 1500, triggerRight: 1560, width: 340, viewportWidth: vw, align: 'left' }))
      .toEqual({ left: 1252, width: 340, side: 'left' })
    expect(placeMenu({ triggerLeft: 20, triggerRight: 48, width: 208, viewportWidth: vw, align: 'right' }))
      .toEqual({ left: 8, width: 208, side: 'right' })
  })

  it('never exceeds the viewport width', () => {
    const p = placeMenu({ triggerLeft: 10, triggerRight: 40, width: 340, viewportWidth: 200 })
    expect(p.width).toBe(184)
    expect(p.left).toBe(8)
  })
})
