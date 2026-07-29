import { describe, it, expect } from 'vitest'
import { searchSummarySpans } from './searchSummary'

function tag(cls: string): string {
  if (cls === '') return ''
  return cls.includes('amber') ? 'count' : 'dim'
}

const spans = (kind: 'counts' | 'files', ...lines: string[]) =>
  searchSummarySpans(kind, lines).map((row) => row.map((s) => [s.text, tag(s.cls)]))

describe('searchSummarySpans', () => {
  it('lowlights the directories in a list of files', () => {
    expect(spans('files', 'internal/claudestream/claudestream.go', 'main.go')).toEqual([
      [['internal/claudestream/', 'dim'], ['claudestream.go', '']],
      [['main.go', '']],
    ])
  })

  it('reads a count per file, and says nothing loudly about a zero', () => {
    expect(spans('counts', 'internal/artifacts/upload.go:3', 'internal/tui/app.go:0')).toEqual([
      [['internal/artifacts/', 'dim'], ['upload.go', ''], [':', 'dim'], ['3', 'count']],
      [['internal/tui/', 'dim'], ['app.go', ''], [':', 'dim'], ['0', 'dim']],
    ])
  })

  it('reads the bare count a single-file search prints', () => {
    expect(spans('counts', '12', '0')).toEqual([[['12', 'count']], [['0', 'dim']]])
  })

  it('leaves a line that is neither alone', () => {
    expect(spans('counts', 'grep: internal/x: Is a directory')).toEqual([
      [['grep: internal/x: Is a directory', '']],
    ])
  })
})
