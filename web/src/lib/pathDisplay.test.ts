import { describe, it, expect } from 'vitest'
import { fitPath } from './pathDisplay'

// All cases use a character budget as the fit predicate, so each expectation
// can be audited by counting characters. maxChars(n) accepts candidates of at
// most n characters.
const maxChars = (n: number) => (s: string) => s.length <= n

describe('fitPath', () => {
  const path = '~/code/hydra/deep/dir' // 21 chars

  it('returns the path untouched when it fits', () => {
    expect(fitPath(path, maxChars(21))).toBe(path)
    expect(fitPath(path, maxChars(100))).toBe(path)
  })

  it('elides middle components one at a time, keeping the anchor and the tail', () => {
    // '~/../hydra/deep/dir' = 19 chars (dropped 'code')
    expect(fitPath(path, maxChars(20))).toBe('~/../hydra/deep/dir')
    // '~/../deep/dir' = 13 chars (dropped 'code/hydra')
    expect(fitPath(path, maxChars(18))).toBe('~/../deep/dir')
    // '~/../dir' = 8 chars (only the last component left)
    expect(fitPath(path, maxChars(12))).toBe('~/../dir')
  })

  it('drops the ~/ anchor once even the last component alone does not fit with it', () => {
    // '../dir' = 6 chars
    expect(fitPath(path, maxChars(7))).toBe('../dir')
  })

  it('clips the end with ... as the last resort', () => {
    // '../di' + '...' would be 8; budget 5 fits '..' + '...' = '.....'? No -
    // clipping shortens '../dir': the longest prefix whose length+3 <= budget.
    expect(fitPath(path, maxChars(5))).toBe('.....') // '..' + '...'
    expect(fitPath(path, maxChars(4))).toBe('....') // '.' + '...'
  })

  it('returns the bare ... marker when nothing at all fits', () => {
    expect(fitPath(path, maxChars(1))).toBe('...')
    expect(fitPath(path, () => false)).toBe('...')
  })

  it('handles root-anchored paths the same way', () => {
    const abs = '/srv/repos/hydra' // outside HOME: no ~
    expect(fitPath(abs, maxChars(16))).toBe(abs)
    // '/../repos/hydra' = 15 chars
    expect(fitPath(abs, maxChars(15))).toBe('/../repos/hydra')
    // '/../hydra' = 9 chars
    expect(fitPath(abs, maxChars(11))).toBe('/../hydra')
    // '../hydra' = 8 chars
    expect(fitPath(abs, maxChars(8))).toBe('../hydra')
  })

  it('goes straight to end-clipping for single-component and bare paths', () => {
    expect(fitPath('~', maxChars(1))).toBe('~')
    expect(fitPath('/', maxChars(1))).toBe('/')
    // '/very-long-name' clipped: '/very-lo' + '...' = 11 chars
    expect(fitPath('/very-long-name', maxChars(11))).toBe('/very-lo...')
  })

  it('ignores a trailing slash', () => {
    expect(fitPath('~/code/hydra/', maxChars(12))).toBe('~/code/hydra')
  })
})
