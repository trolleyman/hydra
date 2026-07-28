import { describe, it, expect } from 'vitest'
import { parseMatchLines, parseScriptSteps, splitScriptOutput, type ScriptStep } from './shellSections'

function kinds(script: string) {
  return (parseScriptSteps(script) ?? []).map((s) => s.kind)
}

function steps(script: string): ScriptStep[] {
  const parsed = parseScriptSteps(script)
  if (!parsed) throw new Error(`no steps for ${script}`)
  return parsed
}

describe('parseScriptSteps', () => {
  it('reads the shape of an investigation script', () => {
    expect(kinds("cd /tmp/x\ngrep -n 'a' f.go\necho '=== next ==='\ntail -30 README.md")).toEqual([
      'silent', 'matches', 'marker', 'view',
    ])
  })

  it('takes a constant echo as a marker', () => {
    const [step] = steps('echo "=== README tail ==="\ncat a.go')
    expect(step).toEqual({ kind: 'marker', text: '=== README tail ===' })
  })

  it('refuses an echo that is not a constant line of its own', () => {
    // A variable, a substitution, and the flags that change what is printed.
    expect(kinds('echo "$file"\ncat a.go')).toEqual(['unknown', 'view'])
    expect(kinds('echo "$(date)"\ncat a.go')).toEqual(['unknown', 'view'])
    expect(kinds('echo -n ---\ncat a.go')).toEqual(['unknown', 'view'])
    // Too short to search the output for safely.
    expect(kinds('echo --\ncat a.go')).toEqual(['unknown', 'view'])
    // Piped somewhere, so what reaches the transcript is not this text.
    expect(kinds('echo ---- | tee log\ncat a.go')).toEqual(['unknown', 'view'])
  })

  it('reads a grep', () => {
    expect(steps('grep -n "rclone" mise/config.toml')[0]).toEqual({
      kind: 'matches',
      command: 'grep -n "rclone" mise/config.toml',
      match: { paths: ['mise/config.toml'], numbered: true },
    })
    // Clustered flags, an explicit pattern, several files, no numbers.
    expect(steps('grep -rn foo src')[0]).toMatchObject({ match: { paths: ['src'], numbered: true } })
    expect(steps('grep -e foo a.go b.go')[0]).toMatchObject({ match: { paths: ['a.go', 'b.go'], numbered: false } })
    expect(steps('grep -n -C 2 foo a.go')[0]).toMatchObject({ match: { paths: ['a.go'], numbered: true } })
    // A glob can name files this cannot enumerate, so it names none.
    expect(steps('grep -n foo *.go')[0]).toMatchObject({ match: { paths: [], numbered: true } })
  })

  it('refuses a grep whose lines are not lines of a file', () => {
    expect(kinds('grep -c foo a.go\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('grep -l foo a.go\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('grep -no foo a.go\ncat b.go')).toEqual(['unknown', 'view'])
  })

  it('sees through a trailing head or tail', () => {
    expect(steps('grep -n foo a.go | head')[0]).toMatchObject({ kind: 'matches' })
    // `| head` keeps the start of a file view and drops its end; `| tail` keeps
    // an end this cannot number.
    expect(steps('sed -n 40,110p a.go | head -5')[0]).toMatchObject({ kind: 'view', view: { start: 40, end: null } })
    expect(steps('cat a.go | tail -5')[0]).toMatchObject({ kind: 'view', view: { start: null, end: null } })
    // Any other pipe transforms the output into something else.
    expect(kinds('grep -n foo a.go | wc -l\ncat b.go')).toEqual(['unknown', 'view'])
    expect(kinds('cat a.go | grep foo\ncat b.go')).toEqual(['unknown', 'view'])
  })

  it('treats what prints nothing as silent', () => {
    expect(kinds('cd web\nDIR=x\nexport A=1\ncat a.go > out.txt\ncat b.go')).toEqual([
      'silent', 'silent', 'silent', 'silent', 'view',
    ])
    // stderr going to /dev/null is not stdout going anywhere.
    expect(kinds('cat a.go 2>/dev/null\necho ----')).toEqual(['view', 'marker'])
  })

  it('declines a script with nothing to describe', () => {
    expect(parseScriptSteps('go test ./...')).toBeNull()
    expect(parseScriptSteps('cd web && bun run lint')).toBeNull()
    // Shapes it will not model at all.
    expect(parseScriptSteps("cat <<'EOF' > f\ncat a.go\nEOF")).toBeNull()
    expect(parseScriptSteps('(cat a.go)')).toBeNull()
    expect(parseScriptSteps('cat a.go &')).toBeNull()
  })
})

describe('splitScriptOutput', () => {
  it('splits an investigation script at its separators', () => {
    const script = [
      "cd '/tmp/extcheck/dotfiles'",
      'grep -n "rclone" mise/config.toml ||',
      'echo "no rclone in mise/config.toml"',
      'echo "=== create_dirs usage ==="',
      'grep -n "create_dirs" bin/dotfiles-setup | head',
      'echo "=== README tail ==="',
      'tail -3 README.md',
    ].join('\n')
    const output = [
      'no rclone in mise/config.toml',
      '=== create_dirs usage ===',
      '262:# Create directories from create_dirs.txt',
      '554:_create_files',
      '=== README tail ===',
      '## TODO',
      '- Set `.ssh/` on PowerShell',
      '- Store Windows Terminal `settings.json`',
    ].join('\n')
    const sections = splitScriptOutput(steps(script), output)
    expect(sections?.map((s) => [s.kind, s.lines.length])).toEqual([
      ['marker', 1],
      ['marker', 1],
      ['matches', 2],
      ['marker', 1],
      ['view', 3],
    ])
    expect(sections?.[4]).toMatchObject({ kind: 'view', view: { path: 'README.md' } })
  })

  it('skips a separator that never printed', () => {
    // The `||` echo only runs when the grep found nothing - here it found something.
    const script = 'grep -n a f.go || echo "nothing found"\necho ====\ncat b.go'
    const sections = splitScriptOutput(steps(script), '3:a\n====\nbee')
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([
      ['matches', ['3:a']],
      ['marker', ['====']],
      ['view', ['bee']],
    ])
  })

  it('prefers the separator where the ranges put it', () => {
    // The file's own text contains the marker; the section must not stop there.
    const sections = splitScriptOutput(steps('sed -n 1,3p a.go\necho ---\nsed -n 1,1p b.go'), 'a1\n---\na3\n---\nb1')
    expect(sections?.map((s) => s.lines)).toEqual([['a1', '---', 'a3'], ['---'], ['b1']])
  })

  it('falls back to plain text where it cannot tell the producers apart', () => {
    // Two open-ended reads back to back have no boundary between them.
    const sections = splitScriptOutput(steps('cat a.go\ncat b.go'), 'a1\nb1')
    expect(sections).toBeNull()
    // ... but a bounded one still splits.
    const split = splitScriptOutput(steps('head -1 a.go\ncat b.go'), 'a1\nb1')
    expect(split?.map((s) => [s.kind, s.lines])).toEqual([['view', ['a1']], ['view', ['b1']]])
  })

  it('gives a section back to plain text when it printed more than it could have', () => {
    const sections = splitScriptOutput(steps('head -2 a.go\necho ----'), 'a1\na2\na3\n----')
    expect(sections?.map((s) => s.kind)).toEqual(['plain', 'marker'])
  })

  it('keeps the output of a step it cannot describe out of its neighbours', () => {
    const script = 'go build ./...\necho "=== the file ==="\ncat a.go'
    const sections = splitScriptOutput(steps(script), 'build failed\n=== the file ===\npackage main')
    expect(sections?.map((s) => [s.kind, s.lines])).toEqual([
      ['plain', ['build failed']],
      ['marker', ['=== the file ===']],
      ['view', ['package main']],
    ])
  })

  it('has nothing to say about output it cannot attribute', () => {
    expect(splitScriptOutput(steps('cat a.go\ncat b.go'), 'x\ny')).toBeNull()
    expect(splitScriptOutput(steps('cat a.go'), '  \n')).toBeNull()
  })
})

describe('parseMatchLines', () => {
  it('reads grep line numbers off a single file', () => {
    expect(parseMatchLines(['12:const a = 1', '40-  // context', '--', 'noise'], ['a.ts'])).toEqual([
      { path: '', num: '12', text: 'const a = 1', separator: false },
      { path: '', num: '40', text: '  // context', separator: false },
      { path: '', num: '', text: '--', separator: true },
      { path: '', num: '', text: 'noise', separator: false },
    ])
  })

  it('reads the file prefix a multi-file search adds', () => {
    expect(parseMatchLines(['src/a.go:12:func a()', 'src/b.go:3:func b()'], [])).toEqual([
      { path: 'src/a.go', num: '12', text: 'func a()', separator: false },
      { path: 'src/b.go', num: '3', text: 'func b()', separator: false },
    ])
    expect(parseMatchLines(['src/a.go:func a()', 'src/b.go:func b()'], [])).toEqual([
      { path: 'src/a.go', num: '', text: 'func a()', separator: false },
      { path: 'src/b.go', num: '', text: 'func b()', separator: false },
    ])
  })

  it('leaves lines alone when no shape holds for most of them', () => {
    const lines = ['plain text', 'more text', '3:a match']
    expect(parseMatchLines(lines, ['a.ts']).every((l) => l.num === '')).toBe(true)
    // A single file's own `key: value` content must not be read as a path prefix.
    expect(parseMatchLines(['name: hydra', 'kind: app'], ['x.yaml']).every((l) => l.path === '')).toBe(true)
  })
})
