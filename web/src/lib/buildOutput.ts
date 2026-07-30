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
// Unlike lib/gitOutput and lib/diskOutput this is keyed on the LINE and not on
// the command, because the command is unknowable: the same diagnostics come out
// of `go build`, `go vet`, `mage build`, `npm run lint`, `make`, a test run, or
// a script that pipes three of them together. So it is applied to the stretches
// nothing else could describe (and to a whole output that could not be
// sectioned at all), and returns null when it recognised nothing - which is what
// keeps a shape this loose from repainting ordinary prose.
//
// The shapes are deliberately the ones that carry a `file:line`. A line saying
// only "Error: something failed" is prose, and it stays prose.
//
// diagnosticSpans at the bottom is the one shape that does NOT carry a location:
// what a tool said about ITSELF (`sed: can't read f: No such file or
// directory`). It is exported on its own rather than folded into the pass above,
// because recognising one needs the script that ran it - see the comment there.
import type { OutputSpan } from './outputSpan'

const DIM = 'text-stone-400 dark:text-stone-500'
const PASS = 'text-green-600 dark:text-green-400'
const FAIL = 'text-red-600 dark:text-red-400'
const WARN = 'text-amber-600 dark:text-amber-400'
const LOC = 'text-sky-700 dark:text-sky-400'

// The harness's own lines, which no command printed: the status above a failed
// command's output, and the note that stands in for the output when there was
// none. Anchored at both ends - it is that line, or it is a sentence about exit
// codes.
//
// Exported for lib/shellSections, which lifts them out of the attribution before
// splitting an output up. A `(Bash completed with no output)` handed to the file
// a step had read came back with `with` coloured as a JavaScript keyword.
export const EXIT_STATUS = /^(Exit code )(\d+)$/
export const NO_OUTPUT = /^\((?:[^()]*\b)?no output\)$/i
// The Bash tool's note that it put the shell back where it started, which it
// writes after the command's own output (see lib/shellCwd).
export const CWD_RESET = /^Shell cwd was reset to \S+$/

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
//
// A lookahead rather than a `\b`, because `?` (Go's "no test files" marker) is
// not a word character and would never have one after it. What it demands is the
// COLUMN go test prints: end of line, a colon, a tab, or the padding that lines
// the package names up. A single space after the word means this is a sentence
// that happens to open with "ok", and it is left alone.
const GO_RESULT = /^(ok|FAIL|PASS|SKIP|\?|---\s*(?:FAIL|PASS|SKIP))(?=$|[:\t]| {2,})(.*)$/
const GO_RUN = /^(===\s*(?:RUN|PAUSE|CONT|NAME)\b.*)$/
// vitest / bun / jest summaries: `Test Files  1 failed | 91 passed (92)`.
const SUMMARY_PART = /\d+\s+(?:failed|passed|skipped|todo)/gi
// A tick or cross a runner prints in front of a test name. Only the marks - a
// bare `x` is a variable name far more often than it is a failing test.
const TICK = /^(\s*)([✓✔√])(\s.*)$/
const CROSS = /^(\s*)([✗✘×])(\s.*)$/

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
  const status = EXIT_STATUS.exec(line)
  if (status) return exitStatusSpans(status)

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

function exitStatusSpans(m: RegExpExecArray): OutputSpan[] {
  return [{ text: m[1], cls: DIM }, { text: m[2], cls: FAIL }]
}

// --- What the shell and its tools said about themselves -----------------------

// A diagnostic a tool wrote about what it was ASKED to do rather than about a
// file it read - the other half of a failed command's output:
//
//   sed: can't read web/src/lib/fileIcons.ts: No such file or directory
//   /bin/bash: line 3: node: command not found
//   go: downloading github.com/x v1.2.3
//
// Which lines these are cannot be read off the line alone: `sed: ...` in a
// file's own content is content, and it is only sed talking when the script ran
// sed. That question belongs to the script, so it is answered in
// lib/shellSections; this colours a line already known to be one.
const DIAG = /^((?:[\w.+-]*\/)*[\w.+-]+)((?:: line \d+)?):(\s+)(.*)$/

// Whether a diagnostic is reporting a FAILURE or only narrating. Both come out
// of the same `tool: message` shape - `go: downloading ...` and `go: cannot find
// module` are the same line to any parser - so the verdict is red only when the
// message says something went wrong, and the rest recedes as the furniture it
// is.
const FAILURE = /\b(no such|not found|cannot|can't|could not|couldn't|unable|denied|invalid|unrecognized|unrecognised|illegal|missing|failed|failure|errors?|not a|too many|unexpected|syntax|ambiguous|bad|refused|timed out|broken|read-only)\b/i

// diagnosticSpans colours one such line. Its three parts are worth reading in
// this order: the SUBJECT it names is the thing that failed and reads at full
// strength, the REASON it ends with is the verdict, and the TOOL that is talking
// is furniture - the opposite weighting to a compiler diagnostic above, where
// every line of the log repeats the same path and the message is the news.
export function diagnosticSpans(line: string): OutputSpan[] {
  const status = EXIT_STATUS.exec(line)
  if (status) return exitStatusSpans(status)
  // The harness saying there was nothing, or saying where it left the shell:
  // furniture, all of it.
  if (NO_OUTPUT.test(line) || CWD_RESET.test(line)) return [{ text: line, cls: DIM }]
  const m = DIAG.exec(line)
  // Not a shape this knows: rendered as it arrived rather than guessed at.
  if (!m) return [{ text: line, cls: '' }]
  const [, tool, at, sep, message] = m
  const cls = FAILURE.test(message) ? FAIL : DIM
  // `tool: subject: reason`, split at the LAST colon: the reason is one clause
  // with no colon of its own ("No such file or directory", "command not found"),
  // and everything before it names what the tool was working on - which for a
  // shell's own error is a `cd:`/`node:` of its own, and reads correctly as part
  // of the subject.
  const cut = message.lastIndexOf(': ')
  return [
    { text: tool, cls: DIM },
    { text: at, cls: LOC },
    { text: `:${sep}`, cls: DIM },
    { text: cut > 0 ? message.slice(0, cut + 2) : '', cls: '' },
    { text: cut > 0 ? message.slice(cut + 2) : message, cls },
  ].filter((s) => s.text !== '')
}
