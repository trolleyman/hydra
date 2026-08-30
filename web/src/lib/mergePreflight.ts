import { TestStatus, type TestRunResult, type TestSummary } from '../api'

export type MergeGate = {
  kind: 'failing' | 'errored' | 'running'
  failed: number
}

// Map the authoritative per-runner response onto the same choice the server's
// merge gate will make. A missing runner verdict is unknown, not green: the
// eventual merge request would start it and be blocked while it runs, so surface
// the Force / Queue choice before a normal merge confirmation.
export function mergeGateForRunners(runners: TestRunResult[]): MergeGate | null {
  let failed = 0
  let errored = false
  let running = false
  for (const runner of runners) {
    if (runner.status === 'failing') failed += runner.failed ?? 0
    else if (runner.status === 'running') running = true
    else if (runner.status !== 'passing') errored = true
  }
  if (failed > 0 || runners.some((runner) => runner.status === 'failing')) return { kind: 'failing', failed }
  if (errored) return { kind: 'errored', failed: 0 }
  if (running) return { kind: 'running', failed: 0 }
  return null
}

// Let the merge preflight update the ambient verdict immediately instead of
// waiting for the project event stream's next tick.
export function testSummaryForRunners(runners: TestRunResult[], previous?: TestSummary): TestSummary {
  let total = 0
  let passed = 0
  let failed = 0
  let skipped = 0
  let warnings = 0
  let durationMs = 0
  let anyRunning = false
  let anyFailing = false
  let anyErrored = false
  let anyMissing = false
  let progress: string | null = null
  let ref: string | null = null

  for (const runner of runners) {
    total += runner.total ?? 0
    passed += runner.passed ?? 0
    failed += runner.failed ?? 0
    skipped += runner.skipped ?? 0
    warnings += runner.warnings ?? 0
    durationMs += runner.duration_ms ?? 0
    if (runner.progress) progress = runner.progress
    if (runner.ref) ref = runner.ref
    if (runner.status === 'running') anyRunning = true
    else if (runner.status === 'failing') anyFailing = true
    else if (runner.status === 'errored') anyErrored = true
    else if (runner.status !== 'passing') anyMissing = true
  }

  const status = runners.length === 0
    ? TestStatus.TestStatusNone
    : anyRunning
      ? TestStatus.TestStatusRunning
      : anyFailing
        ? TestStatus.TestStatusFailing
        : anyErrored
          ? TestStatus.TestStatusErrored
          : anyMissing
            ? TestStatus.TestStatusNone
            : TestStatus.TestStatusPassing

  return {
    status,
    total,
    passed,
    failed,
    skipped,
    warnings,
    duration_ms: durationMs || null,
    progress,
    ref,
    at_base: previous?.at_base,
  }
}
