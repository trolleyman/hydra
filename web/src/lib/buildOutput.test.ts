import { describe, it, expect } from 'vitest'
import { buildOutputSpans } from './buildOutput'

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
})
