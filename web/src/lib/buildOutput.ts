// Colour what a compiler, a linter or a test runner says went wrong.
//
//   internal/chat/manager.go:556:12: undefined: retractTurn
//   web/src/lib/x.ts(12,5): error TS2345: Argument of type ...
//   --- FAIL: TestPutRetry (0.02s)
//       upload_test.go:41: expected 5 attempts, got 1
//   FAIL	github.com/trolleyman/hydra/internal/artifacts	0.5s
//
// This is the output an agent stares at hardest and the only one where the
// reader's eye has somewhere specific to go: the LOCATION (which file, which
// line) and the VERDICT (did it pass). Everything else on the line is prose.
//
// Unlike lib/gitOutput and lib/duOutput this is keyed on the LINE and not on
// the command, because the command is unknowable: the same diagnostics come out
// of `go build`, `go vet`, `mage build`, `npm run lint`, `make`, a test run, or
// a script that pipes three of them together. So it is applied to the stretches
// nothing else could describe (and to a whole output that could not be
// sectioned at all), and returns null when it recognised nothing - which is what
// keeps a shape this loose from repainting ordinary prose.
//
// The shapes are deliberately the ones that carry a `file:line`. A line saying
// only "Error: something failed" is prose, and it stays prose.
import type { OutputSpan } from './outputSpan'

const DIM = 'text-stone-400 dark:text-stone-500'
const PASS = 'text-green-600 dark:text-green-400'
const FAIL = 'text-red-600 dark:text-red-400'
const WARN = 'text-amber-600 dark:text-amber-400'
const LOC = 'text-sky-700 dark:text-sky-400'

// `path/to/file.go:12:5: message`, `path/to/file.ts:12: message`. The path must
// carry an extension and the line a number, which is what keeps a URL, a
// timestamp (`12:30:01`) and a Go map literal out of it.
const COLON_LOC = /^(\s*)([\w./~@+-]+\.[A-Za-z][\w]*):(\d+)(?::(\d+))?:(\s+)(.*)$/
// tsc's own spelling: `src/App.tsx(12,5): error TS2345: ...`.
const PAREN_LOC = /^(\s*)([\w./~@+-]+\.[A-Za-z][\w]*)\((\d+),(\d+)\):(\s+)(.*)$/
// rustc / a Go panic point to a location on a line of their own.
const ARROW_LOC = /^(\s*(?:-->|\tat |\s+at )\s*)([\w./~@+-]+\.[A-Za-z][\w]*):(\d+)(?::(\d+))?(.*)$/
// The severity a diagnostic opens its message with, however the tool spells it.
const SEVERITY = /^(error|err|fatal|failure|failed|warning|warn|note|info|hint)\b(\s*(?:\[[^\]]*\]|[A-Z]+\d+)?:?)/i

// `go test`'s verdict lines. The package path and timing are furniture; whether
// it passed is the whole message.
// A lookahead rather than a `\b`, because `?` (Go's "no test files" marker) is
// not a word character and would never have one after it.
const GO_RESULT = /^(ok|FAIL|PASS|SKIP|\?|---\s*(?:FAIL|PASS|SKIP))(?=[:\s]|$)(.*)$/
const GO_RUN = /^(===\s*(?:RUN|PAUSE|CONT|NAME)\b.*)$/
// vitest / bun / jest summaries: `Test Files  1 failed | 91 passed (92)`.
const SUMMARY_PART = /\d+\s+(?:failed|passed|skipped|todo)/gi
// A tick or cross a runner prints in front of a test name.
const TICK = /^(\s*)([✓✔√])(\s.*)$/
const CROSS = /^(\s*)([✗✘×x])(\s.*)$/

function severitySpans(message: string): OutputSpan[] {
  const m = SEVERITY.exec(message)
  if (!m) return [{ text: message, cls: '' }]
  const word = m[1].toLowerCase()
  const cls = /^(warn|warning|note|info|hint)$/.test(word) ? WARN : FAIL
  return [
    { text: m[1] + m[2], cls },
    { text: message.slice(m[0].length), cls: '' },
  ]
}

// locationSpans renders `path:line:col:` - the part that says WHERE - with the
// path dimmed and the numbers in the colour a hunk header takes in a diff, so
// the eye lands on the same thing it lands on there.
function locationSpans(indent: string, path: string, line: string, col: string | undefined, sep: string): OutputSpan[] {
  return [
    { text: indent, cls: '' },
    { text: path, cls: DIM },
    { text: `:${line}${col ? `:${col}` : ''}`, cls: LOC },
    { text: `:${sep}`, cls: DIM },
  ]
}

function lineSpans(line: string): OutputSpan[] | null {
  const colon = COLON_LOC.exec(line)
  if (colon) {
    const [, indent, path, num, col, sep, message] = colon
    return [...locationSpans(indent, path, num, col, sep), ...severitySpans(message)]
  }

  const paren = PAREN_LOC.exec(line)
  if (paren) {
    const [, indent, path, num, col, sep, message] = paren
    return [
      { text: indent, cls: '' },
      { text: path, cls: DIM },
      { text: `(${num},${col})`, cls: LOC },
      { text: `:${sep}`, cls: DIM },
      ...severitySpans(message),
    ]
  }

  const arrow = ARROW_LOC.exec(line)
  if (arrow) {
    const [, lead, path, num, col, rest] = arrow
    return [
      { text: lead, cls: DIM },
      { text: path, cls: DIM },
      { text: `:${num}${col ? `:${col}` : ''}`, cls: LOC },
      { text: rest, cls: DIM },
    ]
  }

  const result = GO_RESULT.exec(line)
  if (result) {
    const verdict = result[1]
    const passed = /^(ok|---\s*PASS|PASS)$/.test(verdict)
    const skipped = /^(---\s*SKIP|SKIP|\?)$/.test(verdict)
    return [
      { text: verdict, cls: skipped ? DIM : passed ? PASS : FAIL },
      // The package and the timing after it are the same on every line of a
      // suite's output, so they recede behind the verdict and the test name.
      { text: result[2] ?? '', cls: skipped ? DIM : '' },
    ]
  }

  if (GO_RUN.test(line)) return [{ text: line, cls: DIM }]

  const tick = TICK.exec(line)
  if (tick) return [{ text: tick[1], cls: '' }, { text: tick[2], cls: PASS }, { text: tick[3], cls: '' }]
  const cross = CROSS.exec(line)
  if (cross) return [{ text: cross[1], cls: '' }, { text: cross[2], cls: FAIL }, { text: cross[3], cls: '' }]

  if (SUMMARY_PART.test(line)) {
    SUMMARY_PART.lastIndex = 0
    const spans: OutputSpan[] = []
    let at = 0
    for (const part of line.matchAll(SUMMARY_PART)) {
      spans.push({ text: line.slice(at, part.index), cls: DIM })
      spans.push({ text: part[0], cls: /failed/i.test(part[0]) ? FAIL : /passed/i.test(part[0]) ? PASS : DIM })
      at = part.index + part[0].length
    }
    spans.push({ text: line.slice(at), cls: DIM })
    return spans
  }

  if (/^panic:|^fatal error:/.test(line)) return [{ text: line, cls: FAIL }]

  return null
}

// buildOutputSpans colours a stretch of build or test output, one span list per
// line, or null when not one line of it carried a location or a verdict - in
// which case it is not build output and the caller renders it as it was.
export function buildOutputSpans(lines: string[]): OutputSpan[][] | null {
  let recognised = 0
  const out = lines.map((line) => {
    const spans = lineSpans(line)
    if (spans) recognised++
    return (spans ?? [{ text: line, cls: '' }]).filter((s) => s.text !== '')
  })
  return recognised > 0 ? out : null
}
