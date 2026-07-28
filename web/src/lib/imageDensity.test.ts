import { describe, it, expect } from 'vitest'
import { densityFromPath, logicalSize } from './imageDensity'

describe('densityFromPath', () => {
  it('reads an @Nx suffix', () => {
    expect(densityFromPath('/tmp/shot@2x.png')).toBe(2)
    expect(densityFromPath('shot@3x.jpeg')).toBe(3)
    expect(densityFromPath('/a/b/shot@1.5x.png')).toBe(1.5)
    expect(densityFromPath('/tmp/shot@2x')).toBe(2)
  })

  it('ignores a query string or hash', () => {
    expect(densityFromPath('/blob?path=%2Ftmp%2Fshot@2x.png')).toBe(1) // encoded - not a real suffix
    expect(densityFromPath('/tmp/shot@2x.png?v=3')).toBe(2)
    expect(densityFromPath('/tmp/shot@2x.png#frag')).toBe(2)
  })

  it('defaults to 1 for anything unhinted', () => {
    for (const p of ['', null, undefined, '/tmp/shot.png', 'shot@x.png', 'a@2xb.png', '/tmp/2x.png']) {
      expect(densityFromPath(p)).toBe(1)
    }
  })

  it('ignores an out-of-range density rather than trusting the filename', () => {
    expect(densityFromPath('/tmp/shot@100x.png')).toBe(1)
    expect(densityFromPath('/tmp/shot@0.5x.png')).toBe(1)
  })

  it('only matches the last path segment', () => {
    expect(densityFromPath('/tmp/@2x/shot.png')).toBe(1)
  })
})

describe('logicalSize', () => {
  it('divides by the density', () => {
    expect(logicalSize({ w: 840, h: 400 }, 2)).toEqual({ w: 420, h: 200 })
    expect(logicalSize({ w: 420, h: 200 }, 1)).toEqual({ w: 420, h: 200 })
  })

  it('never rounds a tiny image away to nothing', () => {
    expect(logicalSize({ w: 1, h: 1 }, 3)).toEqual({ w: 1, h: 1 })
  })
})
