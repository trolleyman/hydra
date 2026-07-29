import { describe, it, expect } from 'vitest'
import { gitOutputSpans } from './gitOutput'

// The colour a span carries, named rather than spelled, so a case reads as the
// line it is about rather than as a list of Tailwind classes.
function tag(cls: string): string {
  if (cls === '') return ''
  if (cls.includes('green')) return 'add'
  if (cls.includes('red')) return 'del'
  if (cls.includes('amber')) return 'sha'
  if (cls.includes('sky')) return 'ref'
  return 'dim'
}

function spans(...lines: string[]) {
  return gitOutputSpans(lines).map((row) => row.map((s) => [s.text, tag(s.cls)]))
}

describe('gitOutputSpans', () => {
  it('splits a short status into its two columns', () => {
    expect(spans(' M web/src/x.tsx', 'A  a.go', 'MM b.go', '?? scratch/')).toEqual([
      [[' ', ''], ['M', 'del'], [' ', ''], ['web/src/x.tsx', '']],
      [['A', 'add'], [' ', ''], [' ', ''], ['a.go', '']],
      [['M', 'add'], ['M', 'del'], [' ', ''], ['b.go', '']],
      // Untracked is neither an addition nor a deletion.
      [['?', 'dim'], ['?', 'dim'], [' ', ''], ['scratch/', '']],
    ])
  })

  it('reads a rename as one path', () => {
    expect(spans('R  old.go -> new.go')).toEqual([
      [['R', 'add'], [' ', ''], [' ', ''], ['old.go', 'dim'], [' -> ', 'dim'], ['new.go', '']],
    ])
  })

  it('colours a diffstat by direction', () => {
    expect(spans(' web/src/index.css    |  20 ++++--', ' img.png | Bin 0 -> 12 bytes')).toEqual([
      [[' ', ''], ['web/src/index.css', ''], ['    |  ', 'dim'], ['20', 'dim'], [' ', ''], ['++++', 'add'], ['--', 'del']],
      [[' ', ''], ['img.png', ''], [' | ', 'dim'], ['Bin 0 -> 12 bytes', 'dim']],
    ])
  })

  it('picks the counts out of a diffstat trailer', () => {
    expect(spans(' 8 files changed, 174 insertions(+), 43 deletions(-)')).toEqual([
      [[' 8 files changed, ', 'dim'], ['174 insertions(+)', 'add'], [', ', 'dim'], ['43 deletions(-)', 'del']],
    ])
  })

  it('reads a commit header', () => {
    expect(spans('commit a7401035 (HEAD -> main)', 'Merge: 5d671ab0 a7401035', 'Date:   Wed Jul 29 12:00:47 2026 +0100')).toEqual([
      [['commit ', 'dim'], ['a7401035', 'sha'], [' (HEAD -> main)', 'ref']],
      [['Merge:', 'dim'], [' ', ''], ['5d671ab0 a7401035', 'sha']],
      [['Date:', 'dim'], ['   ', ''], ['Wed Jul 29 12:00:47 2026 +0100', '']],
    ])
  })

  it('lowlights the address on an author line', () => {
    expect(spans('Author: Callum Tolley <cgtrolley@gmail.com>')).toEqual([
      [['Author:', 'dim'], [' ', ''], ['Callum Tolley', ''], [' <cgtrolley@gmail.com>', 'dim']],
    ])
  })

  it('picks the sha out of a --oneline log', () => {
    expect(spans('832c46c8 Merge branch \'main\'')).toEqual([
      [['832c46c8', 'sha'], [' ', ''], ["Merge branch 'main'", '']],
    ])
  })

  it('colours the refs a decorated --oneline log carries, and only those', () => {
    expect(spans('832c46c8 (HEAD -> main, origin/main) Fix it', '4ff1e2a1 (tag: v1.2) Ship it')).toEqual([
      [['832c46c8', 'sha'], [' ', ''], ['(HEAD -> main, origin/main) ', 'ref'], ['Fix it', '']],
      [['4ff1e2a1', 'sha'], [' ', ''], ['(tag: v1.2) ', 'ref'], ['Ship it', '']],
    ])
    // A subject that merely opens with a parenthesis is a subject.
    expect(spans('4ff1e2a1 (chore) bump deps')).toEqual([
      [['4ff1e2a1', 'sha'], [' ', ''], ['(chore) bump deps', '']],
    ])
  })

  it('dims a --graph margin and reads the line behind it', () => {
    expect(spans('* 832c46c8 Fix it', '|\\  ', '| * 4ff1e2a1 Ship it', '|/  ')).toEqual([
      [['* ', 'dim'], ['832c46c8', 'sha'], [' ', ''], ['Fix it', '']],
      [['|\\  ', 'dim']],
      [['| * ', 'dim'], ['4ff1e2a1', 'sha'], [' ', ''], ['Ship it', '']],
      [['|/  ', 'dim']],
    ])
    // The same margin over a full log's commit header.
    expect(spans('*   commit a7401035', '|\\  Merge: 5d671ab0 a7401035')).toEqual([
      [['*   ', 'dim'], ['commit ', 'dim'], ['a7401035', 'sha']],
      [['|\\  ', 'dim'], ['Merge:', 'dim'], [' ', ''], ['5d671ab0 a7401035', 'sha']],
    ])
  })

  it('leaves a bulleted commit message alone rather than reading it as a graph', () => {
    expect(spans('    * dropped the retry loop')).toEqual([[['    * dropped the retry loop', '']]])
  })

  it('takes staged or not from the heading above the entry', () => {
    const out = spans(
      'On branch main',
      'Changes to be committed:',
      '  (use "git restore --staged <file>..." to unstage)',
      '\tmodified:   a.go',
      'Changes not staged for commit:',
      '\tmodified:   b.go',
      'Untracked files:',
      '\tscratch/',
    )
    expect(out[0]).toEqual([['On branch ', 'dim'], ['main', 'ref']])
    expect(out[2]).toEqual([['  (use "git restore --staged <file>..." to unstage)', 'dim']])
    expect(out[3]).toEqual([['\t', ''], ['modified:', 'add'], ['   ', ''], ['a.go', 'add']])
    expect(out[5]).toEqual([['\t', ''], ['modified:', 'del'], ['   ', ''], ['b.go', 'del']])
    expect(out[7]).toEqual([['\t', ''], ['scratch/', 'del']])
  })

  it('leaves a line it has no shape for alone', () => {
    // A commit message body, indented four spaces by `git show`.
    expect(spans('    Merge branch \'main\'', '')).toEqual([[["    Merge branch 'main'", '']], []])
  })
})
