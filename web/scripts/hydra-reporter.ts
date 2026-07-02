// Vitest reporter that emits Hydra streaming test markers (::hydra:test:*::) on
// stdout, so the web suite can run as a type = "stdout" [[tests]] runner and
// stream per-spec pass/fail/skip into the tests panel live (see
// internal/tests/stream.go for the marker format). It replaces the JUnit
// reporter: pass `--reporter=./scripts/hydra-reporter.ts` to vitest.
//
// The location token is the repo-relative spec path (web/ + the module's project
// path); the describe chain becomes the scope, the `it` name is the leaf. It uses
// vitest 4's reporter API — `onTestCaseResult` fires as each case finishes, so
// counts tick live rather than all-at-once.
import type { Reporter, TestCase, TestSuite } from 'vitest/node'

function esc(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
}

// verbFor maps a vitest TestResult state to a marker verb, or undefined for a
// state we don't report (a case that never finished running).
function verbFor(state: string): string | undefined {
  switch (state) {
    case 'passed':
      return 'pass'
    case 'failed':
      return 'fail'
    case 'skipped':
      return 'skip'
    default:
      return undefined
  }
}

export default class HydraReporter implements Reporter {
  private total = 0

  onTestCaseResult(testCase: TestCase): void {
    const verb = verbFor(testCase.result().state)
    if (!verb) return
    this.total++

    // Walk the suite chain (describe blocks) up to the module for the scope.
    const scope: string[] = []
    for (let p = testCase.parent; p.type === 'suite'; p = (p as TestSuite).parent) {
      scope.unshift(p.name)
    }
    const loc = `web/${testCase.module.relativeModuleId}`

    let line = `::hydra:test:${verb}:: ${[loc, ...scope, testCase.name].join(' › ')}`
    if (verb === 'fail') {
      const msg = testCase.result().errors?.[0]?.message
      if (msg) line += ` | ${esc(String(msg))}`
    }
    console.log(line)
  }

  onTestRunEnd(): void {
    console.log(`::hydra:test:total:: ${this.total}`)
  }
}
