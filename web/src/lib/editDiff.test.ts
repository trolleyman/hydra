import { describe, it, expect } from 'vitest'
import { buildEditRows, parseEditPatch, hasLineNumbers } from './editDiff'

const shape = (rows: ReturnType<typeof buildEditRows>) => rows.map((r) => `${r.type} ${r.oldNum ?? '-'}/${r.newNum ?? '-'} ${r.content}`)

describe('parseEditPatch', () => {
  it('accepts the provider hunk shape', () => {
    const hunks = parseEditPatch([{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' a', '-b', '+B'] }])
    expect(hunks).toEqual([{ oldStart: 3, newStart: 3, lines: [' a', '-b', '+B'] }])
  })

  it('rejects anything else', () => {
    expect(parseEditPatch(null)).toBeNull()
    expect(parseEditPatch([])).toBeNull()
    expect(parseEditPatch([{ oldStart: 1, newStart: 1 }])).toBeNull()
    expect(parseEditPatch([{ oldStart: '1', newStart: 1, lines: [] }])).toBeNull()
  })
})

describe('buildEditRows from a patch', () => {
  it('numbers each side from the hunk start', () => {
    const rows = buildEditRows('b', 'B', [
      { oldStart: 10, newStart: 10, lines: [' a', '-b', '+B', ' c'] },
    ])
    expect(shape(rows)).toEqual([
      'context 10/10 a',
      'del 11/- b',
      'add -/11 B',
      'context 12/12 c',
    ])
  })

  it('keeps the two sides numbered independently when the line count changes', () => {
    const rows = buildEditRows('b', 'B\nC', [
      { oldStart: 1, newStart: 1, lines: [' a', '-b', '+B', '+C', ' c'] },
    ])
    expect(shape(rows)).toEqual([
      'context 1/1 a',
      'del 2/- b',
      'add -/2 B',
      'add -/3 C',
      'context 3/4 c',
    ])
  })

  it('separates hunks with a gap row and drops the no-newline note', () => {
    const rows = buildEditRows('x', 'y', [
      { oldStart: 1, newStart: 1, lines: ['-x', '+y', '\\ No newline at end of file'] },
      { oldStart: 40, newStart: 40, lines: ['-x', '+y'] },
    ])
    expect(shape(rows)).toEqual(['del 1/- x', 'add -/1 y', 'gap -/- ', 'del 40/- x', 'add -/40 y'])
    expect(hasLineNumbers(rows)).toBe(true)
  })
})

describe('buildEditRows from the strings alone', () => {
  it('keeps shared lines as unnumbered context', () => {
    const rows = buildEditRows('a\nb\nc', 'a\nB\nc')
    expect(shape(rows)).toEqual(['context -/- a', 'del -/- b', 'add -/- B', 'context -/- c'])
    expect(hasLineNumbers(rows)).toBe(false)
  })

  it('aligns an insertion in the middle', () => {
    const rows = buildEditRows('a\nc', 'a\nb\nc')
    expect(shape(rows)).toEqual(['context -/- a', 'add -/- b', 'context -/- c'])
  })

  it('orders a replaced block as deletions then additions', () => {
    const rows = buildEditRows('a\nb\nz', 'A\nB\nz')
    expect(rows.map((r) => r.type)).toEqual(['del', 'del', 'add', 'add', 'context'])
  })

  it('treats an empty side as no lines rather than one blank line', () => {
    expect(shape(buildEditRows('', 'a'))).toEqual(['add -/- a'])
    expect(shape(buildEditRows('a', ''))).toEqual(['del -/- a'])
  })

  it('marks the changed characters of a paired line', () => {
    const rows = buildEditRows('const a = 1', 'const a = 2')
    const del = rows.find((r) => r.type === 'del')
    const add = rows.find((r) => r.type === 'add')
    expect(del?.ranges).toEqual([[10, 11]])
    expect(add?.ranges).toEqual([[10, 11]])
  })

  it('leaves an unrelated deletion/addition pair unmarked', () => {
    const rows = buildEditRows('apple', 'orange')
    expect(rows.every((r) => r.ranges === undefined)).toBe(true)
  })
})
