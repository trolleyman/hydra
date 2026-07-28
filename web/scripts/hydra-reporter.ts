// Vitest reporter that emits Hydra streaming test markers (::hydra:test:*::) on
// stdout, so the web suite can run as a type = "stdout" [[tests]] runner and
// stream per-spec pass/fail/skip into the tests panel live (see
// internal/tests/stream.go for the marker format). It replaces the JUnit
// reporter: pass `--reporter=./scripts/hydra-reporter.ts` to vitest.
//
// The location token is the repo-relative spec path (web/ + the module's project
// path); the describe chain becomes the scope, the `it` name is the leaf. It uses
// vitest 4's reporter API - `onTestCaseResult` fires as each case finishes, so
// counts tick live rather than all-at-once.
//
// A cumulative ::hydra:test:total:: is emitted as each module's cases are
// collected (collection runs well ahead of execution), so the panel gets a
// progress denominator early; the final count re-emits it at the end. Plain
// per-file `ok/FAIL` summary lines go to stdout too - markers are kept out of
// Hydra's build log, so these are what make it non-empty.
import type { Reporter, TestCase, TestModule, TestSuite } from 'vitest/node'

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
  private finished = 0
  private declared = 0

  onTestModuleCollected(module: TestModule): void {
    this.declared += Array.from(module.children.allTests()).length
    console.log(`::hydra:test:total:: ${this.declared}`)
  }

  onTestCaseResult(testCase: TestCase): void {
    const verb = verbFor(testCase.result().state)
    if (!verb) return
    this.finished++

    // Walk the suite chain (describe blocks) up to the module for the scope.
    const scope: string[] = []
    for (let p = testCase.parent; p.type === 'suite'; p = (p as TestSuite).parent) {
      scope.unshift(p.name)
    }
    const loc = `web/${testCase.module.relativeModuleId}`

    // Duration rides on the verb as ":<ms>" (see internal/tests/stream.go), so a
    // streamed case shows its timing like a JUnit one does. It lives on
    // diagnostic(), NOT result() - the latter carries state/errors only, and
    // reading duration off it silently yields undefined for every case.
    const ms = Math.round(testCase.diagnostic()?.duration ?? 0)
    let line = `::hydra:test:${verb}${ms > 0 ? `:${ms}` : ''}:: ${[loc, ...scope, testCase.name].join(' › ')}`
    if (verb === 'fail') {
      const msg = testCase.result().errors?.[0]?.message
      if (msg) line += ` | ${esc(String(msg))}`
    }
    console.log(line)
  }

  onTestModuleEnd(module: TestModule): void {
    const n = Array.from(module.children.allTests()).length
    const verdict = module.state() === 'failed' ? 'FAIL' : 'ok'
    console.log(`${verdict}  web/${module.relativeModuleId} (${n} tests)`)
  }

  onTestRunEnd(): void {
    console.log(`::hydra:test:total:: ${this.finished}`)
  }
}
