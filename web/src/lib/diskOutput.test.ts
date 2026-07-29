import { describe, it, expect } from 'vitest'
import { diskOutputSpans } from './diskOutput'

// The colour a span carries, named rather than spelled - as in gitOutput.test.
function tag(cls: string): string {
  if (cls === '') return ''
  if (cls.includes('amber')) return 'size'
  return cls.includes('red') ? 'full' : 'dim'
}

function spans(...lines: string[]) {
  return diskOutputSpans('du', lines).map((row) => row.map((s) => [s.text, tag(s.cls)]))
}

describe('diskOutputSpans: du', () => {
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
    // An empty line has nothing in it to colour, and renders as the blank it is.
    expect(spans('')).toEqual([[]])
  })
})

describe('diskOutputSpans: df', () => {
  const df = (...lines: string[]) =>
    diskOutputSpans('df', lines).map((row) => row.map((s) => [s.text, tag(s.cls)]))

  it('marks what is used and what is left, and lowlights the device', () => {
    expect(df('/dev/nvme0n1p2  1.8T  1.2T  522G  70% /')).toEqual([[
      ['/dev/nvme0n1p2', 'dim'], ['  ', ''], ['1.8T', 'dim'], ['  ', ''],
      ['1.2T', 'size'], ['  ', ''], ['522G', 'size'], ['  ', ''],
      ['70%', 'size'], [' ', ''], ['/', ''],
    ]])
  })

  it('calls out a filesystem that is nearly full', () => {
    const row = df('/dev/sda1  100G  95G  5G  95% /var')[0]
    expect(row.find(([text]) => text === '95%')).toEqual(['95%', 'full'])
  })

  it('lowlights the header, which measures nothing', () => {
    expect(df('Filesystem      Size  Used Avail Use% Mounted on')).toEqual([
      [['Filesystem      Size  Used Avail Use% Mounted on', 'dim']],
    ])
  })
})

describe('diskOutputSpans: ls', () => {
  const ls = (...lines: string[]) =>
    diskOutputSpans('ls', lines).map((row) => row.map((s) => [s.text, tag(s.cls)]))

  it('marks the size and the name, and lowlights the mode bits and the date', () => {
    expect(ls('-rw-rw-r-- 1 callum callum  87K Jul 29 16:57 simulation_chat.go')).toEqual([[
      ['-rw-rw-r--', 'dim'], [' 1 callum callum  ', 'dim'], ['87K', 'size'],
      [' ', ''], ['Jul 29 16:57', 'dim'], [' ', ''], ['simulation_chat.go', ''],
    ]])
  })

  it('reads a directory row and the total above it', () => {
    expect(ls('total 48')).toEqual([[['total ', 'dim'], ['48', 'dim']]])
    const row = ls('drwxrwxr-x 3 callum callum 4096 Jul 29 16:57 internal')[0]
    expect(row[row.length - 1]).toEqual(['internal', ''])
  })

  it('leaves a bare listing alone - there is no measurement in it', () => {
    expect(ls('main.go')).toEqual([[['main.go', '']]])
  })
})

describe('diskOutputSpans: stat', () => {
  it('lowlights the labels so the values read', () => {
    const rows = diskOutputSpans('stat', ['  Size: 4096      Blocks: 8'])
    expect(rows[0].map((s) => [s.text, tag(s.cls)])).toEqual([
      ['  ', ''], ['Size:', 'dim'], [' 4096      ', ''], ['Blocks:', 'dim'], [' 8', ''],
    ])
  })
})
