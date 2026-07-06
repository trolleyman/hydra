import { describe, it, expect } from 'vitest'
import { hashDiffFile, hashHunks } from './diffSig'
import { DiffFile } from '../api/models/DiffFile'
import { DiffLine } from '../api/models/DiffLine'
import type { DiffHunk } from '../api/models/DiffHunk'

function line(content: string, type: DiffLine.type = DiffLine.type.CONTEXT, oldN = 1, newN = 1): DiffLine {
  return { type, content, old_line_num: oldN, new_line_num: newN }
}

function hunk(lines: DiffLine[], header = '@@ -1 +1 @@'): DiffHunk {
  return { header, old_start: 1, new_start: 1, lines }
}

function file(lines: DiffLine[]): DiffFile {
  return {
    path: 'a.ts',
    change_type: DiffFile.change_type.MODIFIED,
    additions: 1,
    deletions: 0,
    binary: false,
    expanded: true,
    hunks: [hunk(lines)],
  }
}

describe('hashDiffFile', () => {
  it('is stable across separate but structurally-identical objects', () => {
    expect(hashDiffFile(file([line('foo')]))).toBe(hashDiffFile(file([line('foo')])))
  })

  it('changes when line content changes (same line count)', () => {
    // The case additions/deletions counts alone would miss - an in-place edit.
    expect(hashDiffFile(file([line('foo')]))).not.toBe(hashDiffFile(file([line('bar')])))
  })

  it('changes when a line type changes', () => {
    const a = file([line('x', DiffLine.type.CONTEXT)])
    const b = file([line('x', DiffLine.type.ADDITION)])
    expect(hashDiffFile(a)).not.toBe(hashDiffFile(b))
  })

  it('is not fooled by string-concatenation ambiguity (length prefixing)', () => {
    const ab = file([line('ab'), line('c')])
    const a = file([line('a'), line('bc')])
    expect(hashDiffFile(ab)).not.toBe(hashDiffFile(a))
  })

  it('reflects a change to metadata (expanded / path)', () => {
    const base = file([line('foo')])
    expect(hashDiffFile({ ...base, expanded: false })).not.toBe(hashDiffFile(base))
    expect(hashDiffFile({ ...base, path: 'b.ts' })).not.toBe(hashDiffFile(base))
  })
})

describe('hashHunks', () => {
  it('is stable and change-sensitive', () => {
    expect(hashHunks([hunk([line('a')])])).toBe(hashHunks([hunk([line('a')])]))
    expect(hashHunks([hunk([line('a')])])).not.toBe(hashHunks([hunk([line('b')])]))
  })

  it('treats undefined hunks as an empty, stable signature', () => {
    expect(hashHunks(undefined)).toBe(hashHunks([]))
  })
})
