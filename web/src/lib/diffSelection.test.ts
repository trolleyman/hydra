import { describe, it, expect } from 'vitest'
import { rowSelected, selectRow, formatLineParam, parseLineParam } from './diffSelection'

describe('rowSelected', () => {
  it('lights a row by EITHER of its numbers, so both gutters read the same', () => {
    const sel = { side: 'new' as const, start: 10, end: 12 }
    // A context row: old 4, new 11. Selected via its new number, but the old
    // gutter must light too - it is one row.
    expect(rowSelected(sel, 4, 11)).toBe(true)
    expect(rowSelected(sel, 11, null)).toBe(false) // an old-side 11 is a different line
  })
})

describe('selectRow', () => {
  it('addresses a row by its new number, falling back to the old one', () => {
    expect(selectRow(null, null, 4, 11, false)?.sel).toEqual({ side: 'new', start: 11, end: 11 })
    expect(selectRow(null, null, 4, null, false)?.sel).toEqual({ side: 'old', start: 4, end: 4 })
    expect(selectRow(null, null, null, null, false)).toBeNull()
  })

  it('extends along the anchor side from either gutter', () => {
    const anchor = { side: 'new' as const, line: 10 }
    const prev = { side: 'new' as const, start: 10, end: 10 }
    // Shift+click the OLD gutter of a context row: it has a new number too, so
    // the range extends rather than starting over.
    expect(selectRow(prev, anchor, 6, 14, true)?.sel).toEqual({ side: 'new', start: 10, end: 14 })
    // Backwards from the anchor.
    expect(selectRow(prev, anchor, 2, 7, true)?.sel).toEqual({ side: 'new', start: 7, end: 10 })
  })

  it('starts fresh when the row has nothing on the anchor side', () => {
    const prev = { side: 'new' as const, start: 10, end: 10 }
    // A pure deletion: no new number, so it cannot join a new-side range.
    const got = selectRow(prev, { side: 'new', line: 10 }, 5, null, true)
    expect(got?.sel).toEqual({ side: 'old', start: 5, end: 5 })
    expect(got?.anchor).toEqual({ side: 'old', line: 5 })
  })

  it('leaves the anchor alone on an extend', () => {
    expect(selectRow({ side: 'new', start: 10, end: 10 }, { side: 'new', line: 10 }, null, 14, true)?.anchor).toBeNull()
  })
})

describe('line param', () => {
  it('round-trips a single line and a range', () => {
    expect(formatLineParam('a/b.ts', { side: 'new', start: 12, end: 12 })).toBe('a/b.ts:R12')
    expect(formatLineParam('a/b.ts', { side: 'old', start: 3, end: 9 })).toBe('a/b.ts:L3-9')
    expect(parseLineParam('a/b.ts:R12')).toEqual({ path: 'a/b.ts', sel: { side: 'new', start: 12, end: 12 } })
    expect(parseLineParam('a/b.ts:L3-9')).toEqual({ path: 'a/b.ts', sel: { side: 'old', start: 3, end: 9 } })
  })

  it('keeps a colon inside the path, and rejects nonsense', () => {
    expect(parseLineParam('weird:name.ts:R4')?.path).toBe('weird:name.ts')
    expect(parseLineParam('a/b.ts:X4')).toBeNull()
    expect(parseLineParam('')).toBeNull()
    expect(parseLineParam(undefined)).toBeNull()
  })
})
