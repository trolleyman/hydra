import { describe, it, expect } from 'vitest'
import { parseSedRanges, parseView, viewLimit, viewLineNumbers } from './fileViewCommand'

// The command as lib/shellSections hands it over: words, with their quotes
// removed. (That module does the lexing - it has to cope with pipes and
// commands this one knows nothing about.)
function words(command: string): string[] {
  return (command.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^['"]|['"]$/g, ''))
}

function view(command: string) {
  return parseView(words(command), command)
}

describe('parseView', () => {
  it('reads a sed line range', () => {
    expect(view('sed -n 40,110p internal/chat/claude.go')).toEqual({
      path: 'internal/chat/claude.go',
      start: 40,
      end: 110,
      ranges: undefined,
      numbered: false,
      command: 'sed -n 40,110p internal/chat/claude.go',
    })
  })

  it('accepts the quoted, -e and single-line sed spellings', () => {
    expect([view("sed -n '40,110p' a.go")].map((v) => [v?.start, v?.end])).toEqual([[40, 110]])
    expect([view("sed -n -e '5p' a.go")].map((v) => [v?.start, v?.end])).toEqual([[5, 5]])
    expect([view("sed -n '40,$p' a.go")].map((v) => [v?.start, v?.end])).toEqual([[40, null]])
  })

  it('reads a sed of several ranges as the stretches it prints', () => {
    // What an agent writes to quote several places in one file at once.
    const v = view("sed -n '10,14p;80,84p;96,100p' docs/chat-mode.md")
    expect([v?.start, v?.end, v?.ranges]).toEqual([
      10, 100, [{ start: 10, end: 14 }, { start: 80, end: 84 }, { start: 96, end: 100 }],
    ])
    // One range is the ordinary read, and carries no list.
    expect(view("sed -n '10,14p' a.go")?.ranges).toBeUndefined()
    // Single lines, which is the other way agents spell this.
    expect([view("sed -n '3p;9p' a.go")].map((v) => [v?.start, v?.end])).toEqual([[3, 9]])
  })

  it('reads cat, head and tail', () => {
    expect([view('cat a.go')].map((v) => [v?.start, v?.end, v?.numbered])).toEqual([[1, null, false]])
    expect([view('cat -n a.go')].map((v) => [v?.start, v?.end, v?.numbered])).toEqual([[1, null, true]])
    expect([view('head -n 50 a.go')].map((v) => [v?.start, v?.end])).toEqual([[1, 50]])
    expect([view('head -50 a.go')].map((v) => [v?.start, v?.end])).toEqual([[1, 50]])
    expect([view('head a.go')].map((v) => [v?.start, v?.end])).toEqual([[1, 10]])
    expect([view('tail -n +200 a.go')].map((v) => [v?.start, v?.end])).toEqual([[200, null]])
    expect([view('tail -n 20 a.go')].map((v) => [v?.start, v?.end])).toEqual([[null, null]])
  })

  it('reads a git blob as a read of the path in it', () => {
    // The revision goes: the command above the content already says which one,
    // and what the renderer wants from a path is its language, which does not
    // change with the revision.
    expect([view('git show main:web/src/App.tsx')].map((v) => [v?.path, v?.start, v?.end])).toEqual([
      ['web/src/App.tsx', 1, null],
    ])
    expect(view('git show HEAD~2:a.go')?.path).toBe('a.go')
    expect(view('git show :a.go')?.path).toBe('a.go')
    expect(view('git -C /repo show main:a.go')?.path).toBe('a.go')
    // Everything else git prints is a report about the repository, not a file.
    expect(view('git show HEAD')).toBeNull()
    expect(view('git show --stat main:a.go')).toBeNull()
    expect(view('git show main:a.go b.go')).toBeNull()
    expect(view('git show main:')).toBeNull()
    expect(view('git log --oneline')).toBeNull()
  })

  it('keeps the path as written', () => {
    expect(view('cat ~/.claude/settings.json')?.path).toBe('~/.claude/settings.json')
    expect(view("sed -n 1,5p 'my file.go'")?.path).toBe('my file.go')
  })

  it('refuses anything that is not a plain read of one named file', () => {
    // sed that edits or transforms, not prints.
    expect(view('sed -i s/a/b/ a.go')).toBeNull()
    expect(view("sed -n 's/a/b/p' a.go")).toBeNull()
    // Ranges that overlap print the line they share twice, and one that runs to
    // `$` swallows everything after it - neither is a sequence of stretches.
    expect(view("sed -n '1,10p;5,20p' a.go")).toBeNull()
    expect(view("sed -n '20,25p;1,5p' a.go")).toBeNull()
    expect(view("sed -n '1,$p;40,50p' a.go")).toBeNull()
    // Byte counts and follow mode are not line ranges.
    expect(view('head -c 100 a.go')).toBeNull()
    expect(view('tail -f log.txt')).toBeNull()
    // Several files interleave `==> name <==` banners.
    expect(view('head -20 a.go b.go')).toBeNull()
    expect(view('cat a.go b.go')).toBeNull()
    // A `cat` flag that rewrites the bytes it prints.
    expect(view('cat -A a.go')).toBeNull()
    // Not a read at all.
    expect(view('go test ./...')).toBeNull()
  })
})

describe('parseSedRanges', () => {
  it('reads a list of prints in file order', () => {
    expect(parseSedRanges('1,3p;40,42p')).toEqual([{ start: 1, end: 3 }, { start: 40, end: 42 }])
    expect(parseSedRanges('9p')).toEqual([{ start: 9, end: 9 }])
    expect(parseSedRanges('1,3p;5,$p')).toEqual([{ start: 1, end: 3 }, { start: 5, end: null }])
  })

  it('refuses what it cannot put in order', () => {
    expect(parseSedRanges('5,20p;1,10p')).toBeNull()
    expect(parseSedRanges('1,10p;10,20p')).toBeNull()
    expect(parseSedRanges('1,$p;40,50p')).toBeNull()
    expect(parseSedRanges('1,3p;s/a/b/p')).toBeNull()
    expect(parseSedRanges('')).toBeNull()
  })
})

describe('viewLimit', () => {
  it('counts what the command asked for, not the span it covers', () => {
    expect(viewLimit({ start: 40, end: 42, ranges: undefined })).toBe(3)
    // 1-2 and 9-9 is three lines, not nine.
    expect(viewLimit({ start: 1, end: 9, ranges: [{ start: 1, end: 2 }, { start: 9, end: 9 }] })).toBe(3)
    // Open-ended, so nothing bounds it.
    expect(viewLimit({ start: 1, end: null, ranges: undefined })).toBeNull()
    expect(viewLimit({ start: null, end: null, ranges: undefined })).toBeNull()
  })
})

describe('viewLineNumbers', () => {
  it('counts a single range from its start, however short the output came back', () => {
    expect(viewLineNumbers({ start: 40, end: 42, ranges: undefined }, 3)).toEqual(['40', '41', '42'])
    // The file ended first: only the tail is missing, so what did arrive is
    // still numbered.
    expect(viewLineNumbers({ start: 40, end: 500, ranges: undefined }, 2)).toEqual(['40', '41'])
    // A plain `tail` counts back from an end nothing here knows.
    expect(viewLineNumbers({ start: null, end: null, ranges: undefined }, 3)).toEqual([])
  })

  it('numbers several ranges only when every one of them printed in full', () => {
    const v = { start: 10, end: 82, ranges: [{ start: 10, end: 12 }, { start: 80, end: 82 }] }
    expect(viewLineNumbers(v, 6)).toEqual(['10', '11', '12', '80', '81', '82'])
    // One stretch came up short and nothing says which, so every number after
    // it would be wrong: no gutter beats a gutter that lies.
    expect(viewLineNumbers(v, 5)).toEqual([])
  })
})
