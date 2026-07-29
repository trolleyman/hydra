import { describe, it, expect } from 'vitest'
import { gitOutputSpans, parseBlameLine } from './gitOutput'

// The colour a span carries, named rather than spelled, so a case reads as the
// line it is about rather than as a list of Tailwind classes.
function tag(cls: string): string {
  if (cls === '') return ''
  if (cls.includes('green')) return 'add'
  if (cls.includes('red')) return 'del'
  if (cls.includes('amber')) return 'sha'
  if (cls.includes('sky')) return 'ref'
  // A span carrying a fragment of a language takes Prism's own token classes -
  // the ignore pattern in a `check-ignore -v` line.
  if (cls.startsWith('token ')) return cls.slice('token '.length)
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

  it('colours a patch by direction, with its header receding', () => {
    expect(spans(
      'diff --git a/internal/chat/manager.go b/internal/chat/manager.go',
      'index 560e9b39..28c6f309 100644',
      '--- a/internal/chat/manager.go',
      '+++ b/internal/chat/manager.go',
      '@@ -556,7 +556,9 @@ func (m *Manager) RetractOrphanedTurn(id string) error {',
      ' \tif len(orphans) == 0 {',
      '-\tif _, err := s.Append("messages_retracted", m); err != nil {',
      '+\tretracted := MessagesRetracted{}',
      '\\ No newline at end of file',
    )).toEqual([
      [['diff --git ', 'dim'], ['a/internal/chat/manager.go b/internal/chat/manager.go', '']],
      [['index ', 'dim'], ['560e9b39..28c6f309', 'sha'], [' 100644', 'dim']],
      [['--- ', 'dim'], ['a/internal/chat/manager.go', '']],
      [['+++ ', 'dim'], ['b/internal/chat/manager.go', '']],
      [['@@ -556,7 +556,9 @@', 'ref'], [' func (m *Manager) RetractOrphanedTurn(id string) error {', 'dim']],
      [[' \tif len(orphans) == 0 {', '']],
      [['-\tif _, err := s.Append("messages_retracted", m); err != nil {', 'del']],
      [['+\tretracted := MessagesRetracted{}', 'add']],
      [['\\ No newline at end of file', 'dim']],
    ])
  })

  it('reads a patch of a new file', () => {
    expect(spans('new file mode 100644', '--- /dev/null', '+++ b/a.go')).toEqual([
      [['new file mode 100644', 'dim']],
      // Not a path anyone is looking for.
      [['--- ', 'dim'], ['/dev/null', 'dim']],
      [['+++ ', 'dim'], ['b/a.go', '']],
    ])
  })

  it('runs the patch state through a log -p, and drops it at the next commit', () => {
    const out = spans(
      'commit a7401035',
      '    - dropped the retry loop',
      'diff --git a/a.go b/a.go',
      '-\told',
      'commit 5d671ab0',
      '    - and the backoff with it',
    )
    // A dash in a commit message is not a deletion...
    expect(out[1]).toEqual([['    - dropped the retry loop', '']])
    expect(out[3]).toEqual([['-\told', 'del']])
    // ...on either side of the patch.
    expect(out[4]).toEqual([['commit ', 'dim'], ['5d671ab0', 'sha']])
    expect(out[5]).toEqual([['    - and the backoff with it', '']])
  })

  it('reads a check-ignore as the rule it names', () => {
    expect(spans(
      'web/public/fonts/.gitignore:9:iosevka-*.woff2\tweb/public/fonts/iosevka-400-normal.woff2',
      '.gitignore:35:/.iosevka-build.json\tweb/.iosevka-build.json',
    )).toEqual([
      [
        ['web/public/fonts/.gitignore:9:', 'dim'],
        ['iosevka-', ''], ['*', 'operator'], ['.woff2', ''],
        ['\t', ''], ['web/public/fonts/iosevka-400-normal.woff2', ''],
      ],
      [
        ['.gitignore:35:', 'dim'],
        ['/', 'punctuation'], ['.iosevka-build.json', ''],
        ['\t', ''], ['web/.iosevka-build.json', ''],
      ],
    ])
  })

  it('reads the empty source `-n` prints for a path nothing ignores', () => {
    expect(spans('::\tweb/public/fonts/OFL.txt')).toEqual([
      [['::', 'dim'], ['\t', ''], ['web/public/fonts/OFL.txt', '']],
    ])
  })

  it('reads a branch listing, and says which one you are on', () => {
    expect(spans(
      '* main       a7401035 [origin/main: ahead 2] Fix it',
      '  feat/x     5d671ab0 Ship it',
    )).toEqual([
      [['* ', 'ref'], ['main', 'ref'], ['       ', ''], ['a7401035', 'sha'], [' ', ''], ['[origin/main: ahead 2] Fix it', 'dim']],
      [['  ', 'dim'], ['feat/x', ''], ['     ', ''], ['5d671ab0', 'sha'], [' ', ''], ['Ship it', 'dim']],
    ])
  })

  it('reads a remote, a stash and a shortlog', () => {
    expect(spans('origin\tgit@github.com:trolleyman/hydra.git (fetch)')).toEqual([
      [['origin', 'ref'], ['\t', ''], ['git@github.com:trolleyman/hydra.git', ''], [' (fetch)', 'dim']],
    ])
    expect(spans('stash@{0}: WIP on main: a7401035 Fix it')).toEqual([
      [['stash@{0}', 'ref'], [': ', 'dim'], ['WIP on main: ', 'dim'], ['a7401035', 'sha'], [' Fix it', '']],
    ])
    expect(spans('    42\tCallum Tolley')).toEqual([
      [['    ', ''], ['42', 'sha'], ['\t', ''], ['Callum Tolley', '']],
    ])
  })

  it('leaves a line it has no shape for alone', () => {
    // A commit message body, indented four spaces by `git show`.
    expect(spans('    Merge branch \'main\'', '')).toEqual([[["    Merge branch 'main'", '']], []])
  })
})

describe('parseBlameLine', () => {
  it('splits a blame line into its commit, its context and its code', () => {
    expect(parseBlameLine('a7401035 (Callum Tolley 2026-07-29 16:57:41 +0100  12) func main() {')).toEqual({
      sha: 'a7401035',
      meta: '(Callum Tolley 2026-07-29 16:57:41 +0100',
      num: '12',
      code: 'func main() {',
    })
    // A boundary commit, and a blank line of the file.
    expect(parseBlameLine('^5d671ab (Callum Tolley 2026-07-29 16:57:41 +0100   3)')).toMatchObject({
      sha: '^5d671ab', num: '3', code: '',
    })
  })

  it('declines anything that is not one', () => {
    expect(parseBlameLine('fatal: no such path')).toBeNull()
    expect(parseBlameLine('')).toBeNull()
  })
})
