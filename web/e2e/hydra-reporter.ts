// Playwright reporter that emits Hydra streaming test markers (::hydra:test:*::)
// on stdout, so the e2e suite can run as a type = "stdout" [tests.<name>] runner
// instead of writing a JUnit file. See internal/tests/stream.go for the format,
// and web/scripts/hydra-reporter.ts for the vitest equivalent this mirrors.
//
// Streaming beats JUnit here for the reason it does everywhere else: the panel
// counts tick as specs finish rather than all-at-once at exit, and a run killed
// by the timeout still reports everything that had passed - a JUnit run that
// never reaches the end writes no file at all, so the whole suite reads as a
// bare red exit code.
//
// The location token is the repo-relative spec path (web/ + the file), the
// describe chain becomes the scope, and the test title is the leaf.
import type { Reporter, TestCase, TestResult, FullResult, Suite } from '@playwright/test/reporter'
import { relative } from 'node:path'

// Playwright colourises assertion messages. Strip that before it goes into a
// marker: the other emitters (vitest, eslint) send plain text, and the escape
// bytes are pure noise inside a protocol line. Built from a char code so no raw
// control byte lands in the source (see CLAUDE.md).
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

function esc(s: string): string {
  return s
    .replace(ANSI_RE, '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
}

// verbFor maps a Playwright outcome to a marker verb. "flaky" counts as a pass:
// it went green on retry, and the merge gate should read it the way Playwright's
// own exit code does. An interrupted case reports nothing - it never ran to a
// verdict, so inventing one would be a lie.
function verbFor(test: TestCase, result: TestResult): string | undefined {
  if (result.status === 'interrupted') return undefined
  switch (test.outcome()) {
    case 'expected':
    case 'flaky':
      return 'pass'
    case 'unexpected':
      return 'fail'
    case 'skipped':
      return 'skip'
    default:
      return undefined
  }
}

class HydraPlaywrightReporter implements Reporter {
  private finished = 0
  private readonly extraCases = Number.parseInt(process.env.HYDRA_E2E_EXTRA_CASES ?? '0', 10) || 0

  // The full spec count is known up front (unlike vitest's rolling collection),
  // so the progress denominator can be declared before anything runs.
  onBegin(_config: unknown, suite: Suite): void {
    const total = suite.allTests().length + this.extraCases
    if (total > 0) console.log(`::hydra:test:total:: ${total}`)
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // onTestEnd fires per ATTEMPT, and the runner sets CI=1 which turns on a
    // retry - so an unexpected failing spec would otherwise arrive twice and
    // double-count the total. An expected failure has the same raw "failed"
    // result but Playwright does not retry it, so it is final immediately.
    // Skips are likewise final on their first and only attempt.
    const retryable = (result.status === 'failed' || result.status === 'timedOut') &&
      result.status !== test.expectedStatus
    if (retryable && result.retry < test.retries) return
    const verb = verbFor(test, result)
    if (!verb) return
    this.finished++

    // titlePath() is [root, project, file, ...describes, title]; the file is the
    // useful location and the describes are the scope. Deriving them from
    // test.location/test.parent avoids depending on that shape.
    const file = `web/${relative(process.cwd(), test.location.file)}`
    const loc = test.location.line > 0 ? `${file}:${test.location.line}:${test.location.column}` : file
    const scope: string[] = []
    for (let p = test.parent; p; p = p.parent as Suite) {
      if (p.type === 'describe' && p.title) scope.unshift(p.title)
    }

    const ms = Math.round(result.duration ?? 0)
    let line = `::hydra:test:${verb}${ms > 0 ? `:${ms}` : ''}:: ${[loc, ...scope, test.title].join(' › ')}`
    if (verb === 'fail') {
      const msg = result.error?.message ?? result.errors?.[0]?.message
      if (msg) line += ` | ${esc(String(msg))}`
    }
    console.log(line)

    // Markers are protocol and are kept out of Hydra's build log, so echo a plain
    // line per spec too - otherwise the log renders empty for the whole run.
    console.log(`${verb === 'fail' ? 'FAIL' : verb === 'skip' ? 'skip' : 'ok  '} ${test.title} (${ms}ms)`)
  }

  onEnd(result: FullResult): void {
    console.log(`::hydra:test:total:: ${this.finished + this.extraCases}`)
    console.log(`e2e: ${this.finished} spec(s), status ${result.status}`)
  }
}

export default HydraPlaywrightReporter
