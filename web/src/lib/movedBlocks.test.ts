import { describe, it, expect } from 'vitest'
import { detectMoves } from './movedBlocks'
import type { DiffFile, DiffLine, DiffHunk } from '../api'

const ctx = (c: string, o: number, n: number): DiffLine => ({ type: 'context', content: c, old_line_num: o, new_line_num: n } as DiffLine)
const del = (c: string, o: number): DiffLine => ({ type: 'deletion', content: c, old_line_num: o, new_line_num: null } as DiffLine)
const add = (c: string, n: number): DiffLine => ({ type: 'addition', content: c, old_line_num: null, new_line_num: n } as DiffLine)

function file(path: string, lines: DiffLine[]): DiffFile {
  const hunk: DiffHunk = { header: '', old_start: 1, new_start: 1, lines } as DiffHunk
  return { path, change_type: 'modified', additions: 0, deletions: 0, binary: false, hunks: [hunk] } as DiffFile
}

// A block with enough substance to clear the 20-alnum threshold.
const B1 = 'const handlerRegistry = new Map()'
const B2 = 'registry.set(name, handlerFunction)'

describe('detectMoves', () => {
  it('flags a block deleted in one file and added in another', () => {
    const files = [
      file('a.ts', [del(B1, 10), del(B2, 11)]),
      file('b.ts', [add(B1, 40), add(B2, 41)]),
    ]
    const m = detectMoves(files)
    expect(m.get('a.ts')!.del.get(10)).toMatchObject({ partnerPath: 'b.ts', partnerLine: 40 })
    expect(m.get('a.ts')!.del.get(11)).toMatchObject({ partnerPath: 'b.ts', partnerLine: 41 })
    expect(m.get('b.ts')!.add.get(40)).toMatchObject({ partnerPath: 'a.ts', partnerLine: 10 })
    // Same block -> same zebra parity on both halves.
    expect(m.get('a.ts')!.del.get(10)!.parity).toBe(m.get('b.ts')!.add.get(40)!.parity)
  })

  it('ignores a moved block too small to matter', () => {
    const files = [
      file('a.ts', [del('}', 10)]),
      file('b.ts', [add('}', 40)]),
    ]
    expect(detectMoves(files).size).toBe(0)
  })

  it('does not flag a genuine edit (content differs)', () => {
    const files = [file('a.ts', [del('const timeout = 1000', 5), add('const timeout = 2000', 5)])]
    expect(detectMoves(files).size).toBe(0)
  })

  it('matches an indented move when allowIndentChange is on (default)', () => {
    // Same two lines, wrapped one tab deeper on the added side.
    const files = [
      file('a.ts', [del(B1, 10), del(B2, 11)]),
      file('a.ts', []), // placeholder to keep arrays non-trivial
      file('b.ts', [add('\t' + B1, 40), add('\t' + B2, 41)]),
    ]
    const m = detectMoves(files, { allowIndentChange: true })
    expect(m.get('b.ts')!.add.get(40)).toMatchObject({ partnerPath: 'a.ts', partnerLine: 10 })
  })

  it('rejects an indent-changed move when allowIndentChange is off', () => {
    const files = [
      file('a.ts', [del(B1, 10), del(B2, 11)]),
      file('b.ts', [add('\t' + B1, 40), add('\t' + B2, 41)]),
    ]
    expect(detectMoves(files, { allowIndentChange: false }).size).toBe(0)
  })

  it('assigns alternating parity to adjacent moved blocks', () => {
    const C1 = 'function alpha() { return computeSomething() }'
    const C2 = 'function beta() { return computeAnotherThing() }'
    const files = [
      file('src.ts', [del(C1, 1), ctx('', 2, 1), del(C2, 3)]),
      file('dst.ts', [add(C1, 50), ctx('', 1, 51), add(C2, 52)]),
    ]
    const m = detectMoves(files)
    const p1 = m.get('src.ts')!.del.get(1)!.parity
    const p2 = m.get('src.ts')!.del.get(3)!.parity
    expect(p1).not.toBe(p2)
  })
})
