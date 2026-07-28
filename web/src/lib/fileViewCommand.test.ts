import { describe, it, expect } from 'vitest'
import { fileViewLineInfo, parseFileViewScript, splitFileViewOutput, type FileViewStep } from './fileViewCommand'

function views(script: string) {
  return (parseFileViewScript(script) ?? []).flatMap((s) => (s.kind === 'view' ? [s.view] : []))
}

describe('parseFileViewScript', () => {
  it('reads a sed line range', () => {
    expect(views('sed -n 40,110p internal/chat/claude.go')).toEqual([
      { path: 'internal/chat/claude.go', start: 40, end: 110, numbered: false, command: 'sed -n 40,110p internal/chat/claude.go' },
    ])
  })

  it('accepts the quoted, -e and single-line sed spellings', () => {
    expect(views("sed -n '40,110p' a.go").map((v) => [v.start, v.end])).toEqual([[40, 110]])
    expect(views("sed -n -e '5p' a.go").map((v) => [v.start, v.end])).toEqual([[5, 5]])
    expect(views("sed -n '40,$p' a.go").map((v) => [v.start, v.end])).toEqual([[40, null]])
  })

  it('reads cat, head and tail', () => {
    expect(views('cat a.go').map((v) => [v.start, v.end, v.numbered])).toEqual([[1, null, false]])
    expect(views('cat -n a.go').map((v) => [v.start, v.end, v.numbered])).toEqual([[1, null, true]])
    expect(views('head -n 50 a.go').map((v) => [v.start, v.end])).toEqual([[1, 50]])
    expect(views('head -50 a.go').map((v) => [v.start, v.end])).toEqual([[1, 50]])
    expect(views('head a.go').map((v) => [v.start, v.end])).toEqual([[1, 10]])
    expect(views('tail -n +200 a.go').map((v) => [v.start, v.end])).toEqual([[200, null]])
    expect(views('tail -n 20 a.go').map((v) => [v.start, v.end])).toEqual([[null, null]])
  })

  it('keeps the path as written', () => {
    expect(views('cat ~/.claude/settings.json')[0].path).toBe('~/.claude/settings.json')
    expect(views("sed -n 1,5p 'my file.go'")[0].path).toBe('my file.go')
  })

  it('refuses anything that is not a plain read of one named file', () => {
    // Pipes, redirects and substitutions make the output something else.
    expect(parseFileViewScript('sed -n 40,110p a.go | head -20')).toBeNull()
    expect(parseFileViewScript('cat a.go > b.go')).toBeNull()
    expect(parseFileViewScript('cat $FILE')).toBeNull()
    expect(parseFileViewScript('cat "$(ls)"')).toBeNull()
    expect(parseFileViewScript('cat *.go')).toBeNull()
    // sed that edits or transforms, not prints.
    expect(parseFileViewScript('sed -i s/a/b/ a.go')).toBeNull()
    expect(parseFileViewScript("sed -n 's/a/b/p' a.go")).toBeNull()
    expect(parseFileViewScript("sed -n '1,5p;20,25p' a.go")).toBeNull()
    // Byte counts and follow mode are not line ranges.
    expect(parseFileViewScript('head -c 100 a.go')).toBeNull()
    expect(parseFileViewScript('tail -f log.txt')).toBeNull()
    // Several files interleave `==> name <==` banners.
    expect(parseFileViewScript('head -20 a.go b.go')).toBeNull()
    expect(parseFileViewScript('cat a.go b.go')).toBeNull()
    // A step that is neither a view nor an echo poisons the whole script.
    expect(parseFileViewScript('cd web && cat a.go')).toBeNull()
    expect(parseFileViewScript('cat a.go && rm a.go')).toBeNull()
    expect(parseFileViewScript('go test ./...')).toBeNull()
    // An echo alone is not a read.
    expect(parseFileViewScript('echo hello')).toBeNull()
    // Flags that change what echo prints break the output split.
    expect(parseFileViewScript('cat a.go; echo -n ---; cat b.go')).toBeNull()
  })

  it('reads a chain of views and echo separators', () => {
    const steps = parseFileViewScript('sed -n 1,2p a.go; echo ---; sed -n 5,6p b.go')
    expect(steps?.map((s) => (s.kind === 'view' ? s.view.path : `echo:${s.text}`))).toEqual(['a.go', 'echo:---', 'b.go'])
  })

  it('treats newlines and && as step separators', () => {
    expect(views('cat a.go\ncat b.go').map((v) => v.path)).toEqual(['a.go', 'b.go'])
    expect(views('head -3 a.go && head -3 b.go').map((v) => v.path)).toEqual(['a.go', 'b.go'])
  })
})

describe('splitFileViewOutput', () => {
  const steps = (script: string) => parseFileViewScript(script) as FileViewStep[]

  it('gives a single view all the output', () => {
    const sections = splitFileViewOutput(steps('sed -n 3,5p a.go'), 'three\nfour\nfive\n')
    expect(sections).toHaveLength(1)
    expect(sections![0]).toMatchObject({ path: 'a.go', start: 3, lines: ['three', 'four', 'five'] })
  })

  it('cuts at echo markers', () => {
    const sections = splitFileViewOutput(steps('sed -n 1,2p a.go; echo ---; sed -n 5,6p b.go'), 'a1\na2\n---\nb5\nb6')
    expect(sections?.map((s) => [s.path, s.start, s.lines])).toEqual([
      ['a.go', 1, ['a1', 'a2']],
      ['b.go', 5, ['b5', 'b6']],
    ])
  })

  it('prefers the marker where the range puts it over an identical file line', () => {
    // The file's own text contains the separator - the section must not stop there.
    const sections = splitFileViewOutput(steps('sed -n 1,3p a.go; echo ---; sed -n 1,1p b.go'), 'a1\n---\na3\n---\nb1')
    expect(sections?.map((s) => s.lines)).toEqual([['a1', '---', 'a3'], ['b1']])
  })

  it('falls back to the range length for back-to-back views', () => {
    const sections = splitFileViewOutput(steps('sed -n 1,2p a.go; sed -n 9,9p b.go'), 'a1\na2\nb9')
    expect(sections?.map((s) => [s.path, s.lines])).toEqual([
      ['a.go', ['a1', 'a2']],
      ['b.go', ['b9']],
    ])
  })

  it('gives up when the output does not match the script', () => {
    // A marker that never appears.
    expect(splitFileViewOutput(steps('cat a.go; echo ---; cat b.go'), 'a1\na2')).toBeNull()
    // More lines than the range could have produced (an error line, a banner).
    expect(splitFileViewOutput(steps('sed -n 1,2p a.go'), 'a1\na2\na3')).toBeNull()
    // Two open-ended reads have no boundary at all.
    expect(splitFileViewOutput(steps('cat a.go; cat b.go'), 'a1\nb1')).toBeNull()
    // Nothing printed (the file did not exist and the error went to stderr).
    expect(splitFileViewOutput(steps('cat a.go'), '   \n')).toBeNull()
  })

  it('accepts a range the file ended before', () => {
    const sections = splitFileViewOutput(steps('sed -n 1,500p a.go'), 'only\ntwo')
    expect(sections?.[0].lines).toEqual(['only', 'two'])
  })
})

describe('fileViewLineInfo', () => {
  it('phrases a range the way a Read does', () => {
    expect(fileViewLineInfo({ start: 40, end: 110 })).toBe('lines 40-110')
    expect(fileViewLineInfo({ start: 1, end: 50 })).toBe('first 50 lines')
    expect(fileViewLineInfo({ start: 40, end: null })).toBe('from line 40')
    expect(fileViewLineInfo({ start: 1, end: null })).toBe('')
    expect(fileViewLineInfo({ start: null, end: null })).toBe('')
  })
})
