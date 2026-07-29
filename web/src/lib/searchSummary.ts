// Colour what a search says ABOUT the files rather than what it found in them:
//
//   grep -rc "sleepBackoff" internal      internal/artifacts/upload.go:3
//   rg -l "IsHiddenChatMessage" internal  internal/claudestream/claudestream.go
//
// Both are lists of paths - one with a number beside each - and both arrive as a
// flat grey block where the thing worth reading (which file, and how many) is
// spelled in the same colour as the directories above it.
//
// So a path is lowlit down to its basename, the way the file trees show one, and
// a count reads as the number it is. Nothing here is a line of any file, which
// is why it is not lib/shellSections' `matches`: there is no gutter, and no
// language to highlight by.
import type { OutputSpan } from './outputSpan'

const DIM = 'text-stone-400 dark:text-stone-500'
const COUNT = 'text-amber-600 dark:text-amber-400'
const ZERO = 'text-stone-400 dark:text-stone-500'

export type SearchSummary =
  // `-c`: `path:12`, or a bare `12` when the search named one file.
  | 'counts'
  // `-l` / `-L`: one path per line.
  | 'files'

// `path:12`, with the count last so a path carrying a colon still splits right.
const COUNT_LINE = /^(.*):(\d+)$/

// pathSpans lowlights the directories in front of a path, so a column of them
// reads as the names that differ rather than as the prefix they share.
function pathSpans(path: string): OutputSpan[] {
  const at = path.lastIndexOf('/')
  if (at < 0) return [{ text: path, cls: '' }]
  return [{ text: path.slice(0, at + 1), cls: DIM }, { text: path.slice(at + 1), cls: '' }]
}

// searchSummarySpans colours a whole summary, one span list per line.
export function searchSummarySpans(kind: SearchSummary, lines: string[]): OutputSpan[][] {
  return lines.map((line) => {
    if (line === '') return []
    if (kind === 'files') return pathSpans(line)
    const m = COUNT_LINE.exec(line)
    // A single-file `-c` prints the count alone.
    if (!m) return /^\d+$/.test(line) ? [{ text: line, cls: line === '0' ? ZERO : COUNT }] : [{ text: line, cls: '' }]
    return [
      ...pathSpans(m[1]),
      { text: ':', cls: DIM },
      // A zero is the answer "nowhere", which is worth reading as quietly as it
      // deserves: `grep -c` prints a row per file searched, most of them 0.
      { text: m[2], cls: m[2] === '0' ? ZERO : COUNT },
    ]
  })
}
