import { describe, it, expect } from 'vitest'
import { buildOutputSpans, diagnosticSpans } from './buildOutput'

// The colour a span carries, named rather than spelled - as in gitOutput.test.
function tag(cls: string): string {
  if (cls === '') return ''
  if (cls.includes('green')) return 'pass'
  if (cls.includes('red')) return 'fail'
  if (cls.includes('amber')) return 'warn'
  if (cls.includes('sky')) return 'loc'
  return 'dim'
}

function spans(...lines: string[]) {
  return (buildOutputSpans(lines) ?? []).map((row) => row.map((s) => [s.text, tag(s.cls)]))
}

describe('buildOutputSpans', () => {
  it('reads a Go compiler diagnostic', () => {
    expect(spans('internal/chat/manager.go:556:12: undefined: retractTurn')).toEqual([
      [
        ['internal/chat/manager.go', 'dim'], [':556:12', 'loc'], [': ', 'dim'],
        ['undefined: retractTurn', ''],
      ],
    ])
  })

  it('picks the severity out of a message that names one', () => {
    expect(spans(
      'web/src/x.ts:12:5: error TS2345: Argument of type X',
      'internal/x.go:3:1: warning: unused import',
    )).toEqual([
      [
        ['web/src/x.ts', 'dim'], [':12:5', 'loc'], [': ', 'dim'],
        ['error TS2345:', 'fail'], [' Argument of type X', ''],
      ],
      [
        ['internal/x.go', 'dim'], [':3:1', 'loc'], [': ', 'dim'],
        ['warning:', 'warn'], [' unused import', ''],
      ],
    ])
  })

  it("reads tsc's parenthesised spelling", () => {
    expect(spans('src/App.tsx(12,5): error TS2551: Property x does not exist')).toEqual([
      [
        ['src/App.tsx', 'dim'], ['(12,5)', 'loc'], [': ', 'dim'],
        ['error TS2551:', 'fail'], [' Property x does not exist', ''],
      ],
    ])
  })

  it('reads the location a test failure prints under itself', () => {
    expect(spans('    upload_test.go:41: expected 5 attempts, got 1')).toEqual([
      [
        ['    ', ''], ['upload_test.go', 'dim'], [':41', 'loc'], [': ', 'dim'],
        ['expected 5 attempts, got 1', ''],
      ],
    ])
  })

  it('reads a go test verdict, and lowlights the package behind it', () => {
    expect(spans(
      'ok  \tgithub.com/trolleyman/hydra/internal/chat\t0.606s',
      'FAIL\tgithub.com/trolleyman/hydra/internal/artifacts\t0.5s',
      '--- FAIL: TestPutRetry (0.02s)',
      '--- PASS: TestBackoff (0.00s)',
      '?   \tgithub.com/trolleyman/hydra/internal/tui\t[no test files]',
      '=== RUN   TestPutRetry',
    )).toEqual([
      [['ok', 'pass'], ['  \tgithub.com/trolleyman/hydra/internal/chat\t0.606s', '']],
      [['FAIL', 'fail'], ['\tgithub.com/trolleyman/hydra/internal/artifacts\t0.5s', '']],
      [['--- FAIL', 'fail'], [': TestPutRetry (0.02s)', '']],
      [['--- PASS', 'pass'], [': TestBackoff (0.00s)', '']],
      [['?', 'dim'], ['   \tgithub.com/trolleyman/hydra/internal/tui\t[no test files]', 'dim']],
      [['=== RUN   TestPutRetry', 'dim']],
    ])
  })

  it('reads a runner tick, a cross and a summary', () => {
    expect(spans(
      ' ✓ src/lib/gitOutput.test.ts (17)',
      ' × src/lib/x.test.ts > drops a line',
      ' Test Files  1 failed | 91 passed (92)',
    )).toEqual([
      [[' ', ''], ['✓', 'pass'], [' src/lib/gitOutput.test.ts (17)', '']],
      [[' ', ''], ['×', 'fail'], [' src/lib/x.test.ts > drops a line', '']],
      [
        [' Test Files  ', 'dim'], ['1 failed', 'fail'], [' | ', 'dim'],
        ['91 passed', 'pass'], [' (92)', 'dim'],
      ],
    ])
  })

  it('colours a panic, and the frames that point into a file', () => {
    expect(spans(
      'panic: runtime error: index out of range [3]',
      '\tat internal/chat/manager.go:556',
    )).toEqual([
      [['panic: runtime error: index out of range [3]', 'fail']],
      [['\tat ', 'dim'], ['internal/chat/manager.go', 'dim'], [':556', 'loc']],
    ])
  })

  it('reads a Vitest failure report and highlights its TSX excerpt', () => {
    const lines = [
      '\u23af\u23af\u23af Failed Tests 1 \u23af\u23af\u23af',
      ' FAIL  web/src/components/ConfigForm.test.tsx > settings > inserts a row',
      'ReferenceError: document is not defined',
      ' \u276f web/src/components/ConfigForm.test.tsx:8:5',
      "      6|   it('inserts a row', () => {",
      '      7|     render(<PathListEditor paths={[\'github.com\']} />)',
      '       |     ^',
      '      8|   })',
      '\u23af\u23af\u23af\u23af[1/1]\u23af',
    ]
    const out = buildOutputSpans(lines)

    expect(out).not.toBeNull()
    expect(out?.map((row) => row.map((span) => span.text).join(''))).toEqual(lines)
    expect(out?.[0].map((span) => tag(span.cls))).toEqual(['dim', 'fail', 'dim'])
    expect(out?.[1].map((span) => [span.text, tag(span.cls)])).toEqual([
      [' ', ''], ['FAIL', 'fail'], ['  ', ''],
      ['web/src/components/ConfigForm.test.tsx', 'dim'], [' > ', 'dim'],
      ['settings', ''], [' > ', 'dim'], ['inserts a row', ''],
    ])
    expect(out?.[2].map((span) => [span.text, tag(span.cls)])).toEqual([
      ['ReferenceError', 'fail'], [':', 'dim'], [' document is not defined', ''],
    ])
    expect(out?.[5].some((span) => span.cls.includes('token tag'))).toBe(true)
    expect(out?.[5].some((span) => span.cls.includes('token string'))).toBe(true)
    expect(out?.[6].map((span) => tag(span.cls))).toEqual(['dim', 'fail'])
    expect(out?.[8].map((span) => tag(span.cls))).toEqual(['dim', 'loc', 'dim'])
  })

  it('does not treat source-shaped prose as a failure excerpt by itself', () => {
    expect(buildOutputSpans([
      'ReferenceError: this is a heading in a document',
      '      7| this is quoted prose',
    ])).toBeNull()
  })

  it('colours the command and verdict in a shell execution failure', () => {
    expect(spans('/usr/bin/bash: line 1: codex: command not found')).toEqual([
      [
        ['/usr/bin/bash: line 1: ', 'dim'], ['codex', 'fail'],
        [': ', 'dim'], ['command not found', 'fail'],
      ],
    ])
  })

  it('leaves a sentence that opens with a verdict word alone', () => {
    // `ok` in go test's output is a COLUMN, padded out to the package name; in
    // prose it is the first word of a sentence.
    expect(buildOutputSpans([
      'ok now rebuilding the frontend',
      'x is still unset',
      'PASSING the config through instead',
    ])).toBeNull()
  })

  it('declines output that carries no location and no verdict', () => {
    // Prose, a URL, a time of day, a Go map literal: nothing here says where.
    expect(buildOutputSpans([
      'Building the frontend...',
      'see https://example.com/docs:12 for more',
      '2026-07-29 16:57:41 starting',
      'm := map[string]int{"a": 1}',
    ])).toBeNull()
  })

  it('leaves the lines it does not recognise exactly as they arrived', () => {
    const out = buildOutputSpans(['prose about the build', 'a.go:1:1: oops'])
    expect(out?.[0]).toEqual([{ text: 'prose about the build', cls: '' }])
  })

  it('reads the harness status line above a failed command', () => {
    expect(spans('Exit code 2')).toEqual([[['Exit code ', 'dim'], ['2', 'fail']]])
    // A sentence about one is prose.
    expect(buildOutputSpans(['Exit code 2 means the pattern was not found'])).toBeNull()
  })
})

describe('diagnosticSpans', () => {
  const of = (line: string) => diagnosticSpans(line).map((s) => [s.text, tag(s.cls)])

  it('reads a tool complaining about what it was asked to do', () => {
    // The file is lowlit like paths elsewhere; the phrase naming what happened
    // stays at full strength, the tool is furniture, and the reason is the
    // verdict.
    expect(of("sed: can't read web/src/lib/fileIcons.ts: No such file or directory")).toEqual([
      ['sed', 'dim'], [': ', 'dim'],
      ["can't read ", ''], ['web/src/lib/fileIcons.ts', 'dim'], [': ', 'dim'],
      ['No such file or directory', 'fail'],
    ])
    expect(of('cat: docs/missing.md: No such file or directory')).toEqual([
      ['cat', 'dim'], [': ', 'dim'], ['docs/missing.md', 'dim'], [': ', 'dim'], ['No such file or directory', 'fail'],
    ])
    expect(of('rg: Magefile.go: No such file or directory (os error 2)')).toEqual([
      ['rg', 'dim'], [': ', 'dim'], ['Magefile.go', 'dim'], [': ', 'dim'],
      ['No such file or directory (os error 2)', 'fail'],
    ])
  })

  it('points at the line of the script the shell fell over on', () => {
    expect(of('/bin/bash: line 3: node: command not found')).toEqual([
      ['/bin/bash', 'dim'], [': line 3', 'loc'], [': ', 'dim'], ['node: ', ''], ['command not found', 'fail'],
    ])
  })

  it('leaves a tool that is only narrating in the furniture', () => {
    // The same shape carries `go: downloading ...` as carries `go: cannot find
    // module`, so the red is spent on the one that says something went wrong.
    expect(of('go: downloading github.com/google/go-cmp v0.6.0')).toEqual([
      ['go', 'dim'], [': ', 'dim'], ['downloading github.com/google/go-cmp v0.6.0', 'dim'],
    ])
    expect(of('go: cannot find main module')).toEqual([
      ['go', 'dim'], [': ', 'dim'], ['cannot find main module', 'fail'],
    ])
  })

  it('carries the exit status, and renders anything else as it arrived', () => {
    expect(of('Exit code 127')).toEqual([['Exit code ', 'dim'], ['127', 'fail']])
    expect(of('something else entirely')).toEqual([['something else entirely', '']])
  })

  it('lowlights the harness note that stands in for output', () => {
    expect(of('(Bash completed with no output)')).toEqual([['(Bash completed with no output)', 'dim']])
    expect(of('(no output)')).toEqual([['(no output)', 'dim']])
  })
})
