import { describe, it, expect } from 'vitest'
import { duOutputSpans } from './duOutput'

// The colour a span carries, named rather than spelled - as in gitOutput.test.
function tag(cls: string): string {
  if (cls === '') return ''
  return cls.includes('amber') ? 'size' : 'dim'
}

function spans(...lines: string[]) {
  return duOutputSpans(lines).map((row) => row.map((s) => [s.text, tag(s.cls)]))
}

describe('duOutputSpans', () => {
  it('marks the size and leaves the path in the panel colour', () => {
    expect(spans('18G\t/home/callum/.cache/go', '2.5G\t/home/callum/.cache/Google')).toEqual([
      [['18G', 'size'], ['\t', ''], ['/home/callum/.cache/go', '']],
      [['2.5G', 'size'], ['\t', ''], ['/home/callum/.cache/Google', '']],
    ])
  })

  it('reads a size in blocks, and one with a full unit', () => {
    expect(spans('4096\t./web', '1.0KiB\t./a', '512M\t./b')).toEqual([
      [['4096', 'size'], ['\t', ''], ['./web', '']],
      [['1.0KiB', 'size'], ['\t', ''], ['./a', '']],
      [['512M', 'size'], ['\t', ''], ['./b', '']],
    ])
  })

  it('lowlights the total a -c adds up, which names no file', () => {
    expect(spans('1.2G\ttotal')).toEqual([[['1.2G', 'size'], ['\t', ''], ['total', 'dim']]])
  })

  it('keeps the padding a `du` aligned its columns with', () => {
    expect(spans('  16K   ./x')).toEqual([[['  ', ''], ['16K', 'size'], ['   ', ''], ['./x', '']]])
  })

  it('leaves a line that is not a measurement alone', () => {
    // stderr, interleaved into the output by a `2>&1`.
    expect(spans("du: cannot read directory './root': Permission denied")).toEqual([
      [["du: cannot read directory './root': Permission denied", '']],
    ])
    expect(spans('')).toEqual([[['', '']]])
  })
})
