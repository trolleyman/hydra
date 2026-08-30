import { describe, expect, it } from 'vitest'
import type { TestRunResult } from '../api'
import { mergeGateForRunners, testSummaryForRunners } from './mergePreflight'

const runner = (name: string, status: TestRunResult['status'], failed = 0): TestRunResult => ({
  name,
  status,
  failed,
})

describe('mergeGateForRunners', () => {
  it('allows a normal merge with no configured runners or all passing runners', () => {
    expect(mergeGateForRunners([])).toBeNull()
    expect(mergeGateForRunners([runner('web', 'passing')])).toBeNull()
  })

  it('prioritises a failing verdict and totals failures like the server gate', () => {
    expect(mergeGateForRunners([
      runner('web', 'running'),
      runner('go', 'failing', 2),
      runner('e2e', 'failing', 1),
    ])).toEqual({ kind: 'failing', failed: 3 })
  })

  it('treats a missing verdict as unknown instead of green', () => {
    expect(mergeGateForRunners([runner('manual', 'none')])).toEqual({ kind: 'errored', failed: 0 })
  })

  it('distinguishes a run in progress when nothing has errored', () => {
    expect(mergeGateForRunners([runner('web', 'running')])).toEqual({ kind: 'running', failed: 0 })
  })
})

describe('testSummaryForRunners', () => {
  it('aggregates the preflight response for the ambient verdict chip', () => {
    expect(testSummaryForRunners([
      { name: 'web', status: 'running', total: 10, passed: 4, warnings: 1, progress: '4/10', ref: 'abc' },
      { name: 'go', status: 'passing', total: 7, passed: 7, duration_ms: 80, ref: 'abc' },
    ])).toMatchObject({
      status: 'running', total: 17, passed: 11, warnings: 1, progress: '4/10', ref: 'abc', duration_ms: 80,
    })
  })
})
