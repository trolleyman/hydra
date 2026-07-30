import { describe, expect, it } from 'vitest'
import { buildFixTestMessage } from './testCases'
import type { TestCase } from '../api/models/TestCase'
import { TestCaseStatus } from '../api/models/TestCaseStatus'

function caseOf(over: Partial<TestCase>): TestCase {
  return { name: 'does a thing', status: TestCaseStatus.TestCaseFailed, ...over } as TestCase
}

describe('buildFixTestMessage', () => {
  it('carries the runner, the scoped name, the location and the raw output', () => {
    const msg = buildFixTestMessage('go', caseOf({
      name: 'rotates the key',
      path: 'internal/auth/rotation_test.go',
      line: 42,
      scope: ['TestRotation'],
      message: 'want 3, got 4\n',
    }))
    expect(msg).toContain('The `go` test runner reports a failure.')
    // Name in inline code; location as a markdown link (href carries the :line).
    expect(msg).toContain('Test: `TestRotation > rotates the key`')
    expect(msg).toContain('Location: [internal/auth/rotation_test.go:42](internal/auth/rotation_test.go:42)')
    // Fenced verbatim, with the runner's trailing newline trimmed off the fence.
    expect(msg).toContain('Output:\n```\nwant 3, got 4\n```')
  })

  it('says warning for a warning case', () => {
    const msg = buildFixTestMessage('vitest', caseOf({ status: TestCaseStatus.TestCaseWarning }))
    expect(msg).toContain('reports a warning.')
  })

  it('omits the location and output lines when the case has neither', () => {
    const msg = buildFixTestMessage('go', caseOf({}))
    expect(msg).not.toContain('Location:')
    expect(msg).not.toContain('Output:')
    expect(msg).toContain('Test: `does a thing`')
  })
})
