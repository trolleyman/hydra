import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { CaseTree } from './CaseTree'
import type { TestCase } from '../api/models/TestCase'
import type { TestCaseStatus } from '../api/models/TestCaseStatus'

afterEach(cleanup)

// Regression tests for row key stability across the worst-status-first sort.
// Keys used to append the POST-sort index to caseKey, so a streamed status
// update that reordered the list also changed the keys of every shifted row -
// remounting them mid-reorder (losing DOM state and desyncing React DevTools'
// mirror of the tree, which threw "Children cannot be added or removed during
// a reorder operation" on every later commit). Keys are now derived from the
// stable visCases order, so a reorder moves the same DOM nodes.

function mk(name: string, status: TestCaseStatus): TestCase {
  return { name, status, path: 'pkg/foo_test.go' }
}

function renderTree(cases: TestCase[]) {
  return <CaseTree cases={cases} visible={cases} useScope={false} />
}

describe('CaseTree row keys', () => {
  it('keeps DOM nodes when a status change reorders the rows', () => {
    const { rerender } = render(renderTree([mk('alpha', 'passed'), mk('beta', 'skipped')]))
    const alpha = screen.getByText('alpha')
    const beta = screen.getByText('beta')
    // passed ranks above skipped: alpha first.
    expect(alpha.compareDocumentPosition(beta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // beta fails - it sorts above alpha now. Same logical cases, fresh objects,
    // as a streaming update would produce.
    rerender(renderTree([mk('alpha', 'passed'), mk('beta', 'failed')]))
    const alpha2 = screen.getByText('alpha')
    const beta2 = screen.getByText('beta')
    expect(beta2.compareDocumentPosition(alpha2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The reorder must move the existing nodes, not remount them.
    expect(alpha2).toBe(alpha)
    expect(beta2).toBe(beta)
  })

  it('renders duplicate cases distinctly (dedup suffix)', () => {
    render(renderTree([mk('dup', 'passed'), mk('dup', 'passed')]))
    expect(screen.getAllByText('dup')).toHaveLength(2)
  })
})
