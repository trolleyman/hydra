import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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

// A case at web/src/<dir>/<file>, so a tree built from several has real depth to
// unfold: web/src, then a dir row, then a file row, then the cases.
function at(dir: string, file: string, name: string): TestCase {
  return { name, status: 'passed' as TestCaseStatus, path: `web/src/${dir}/${file}` }
}

function pathRow(path: string): HTMLElement {
  const row = screen.getByTitle(`Copy ${path}`).closest<HTMLElement>('[role="button"]')
  if (!row) throw new Error(`No tree row for ${path}`)
  return row
}

// Shaped so nothing collapses away under us: two cases per file (or hoistedCase
// folds the chain into one leaf row) and two files under `components` (or
// compact() merges it into "components/Chat.test.tsx"). `lib` deliberately has
// only the one file, so it DOES merge - the level counting below expects it.
const DEEP: TestCase[] = [
  { name: 'loads api', status: 'passed', path: 'web/src/api.test.ts' },
  { name: 'handles api errors', status: 'passed', path: 'web/src/api.test.ts' },
  at('components', 'Chat.test.tsx', 'renders'),
  at('components', 'Chat.test.tsx', 'scrolls'),
  at('components', 'Diff.test.tsx', 'diffs'),
  at('components', 'Diff.test.tsx', 'merges'),
  at('lib', 'paths.test.ts', 'joins'),
  at('lib', 'paths.test.ts', 'splits'),
]

describe('CaseTree defaultExpanded', () => {
  it('unfolds the whole tree by default', () => {
    render(<CaseTree cases={DEEP} visible={DEEP} useScope={false} />)
    expect(screen.getByText('renders')).toBeTruthy()
    expect(screen.getByText('joins')).toBeTruthy()
  })

  it('opens one level per click when defaultExpanded is off', () => {
    render(<CaseTree cases={DEEP} visible={DEEP} useScope={false} defaultExpanded={false} />)
    // Only the root row is on screen; nothing below it is even mounted.
    expect(pathRow('web/src')).toBeTruthy()
    expect(screen.queryByText('components')).toBeNull()
    expect(screen.queryByText('renders')).toBeNull()

    // One click reveals its children - and stops there.
    fireEvent.click(pathRow('web/src'))
    const components = screen.getByText('components')
    const alphabeticallyEarlierFile = pathRow('web/src/api.test.ts')
    expect(components).toBeTruthy()
    expect(alphabeticallyEarlierFile).toBeTruthy()
    // Directory nodes sort before file nodes even when the file's label would
    // otherwise come first alphabetically.
    expect(components.compareDocumentPosition(alphabeticallyEarlierFile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(pathRow('web/src/lib/paths.test.ts')).toBeTruthy()
    expect(screen.queryByText('Chat.test.tsx')).toBeNull()

    // The next level down behaves the same way.
    fireEvent.click(screen.getByText('components'))
    expect(screen.getByText('Chat.test.tsx')).toBeTruthy()
    expect(screen.queryByText('renders')).toBeNull()

    fireEvent.click(screen.getByText('Chat.test.tsx'))
    expect(screen.getByText('renders')).toBeTruthy()
    // The sibling the user never opened stays shut.
    expect(screen.queryByText('joins')).toBeNull()
  })

  it('lets a lifted toggle set survive the tree unmounting', () => {
    // What the result sections do: hold the override set above the tree, so
    // folding a section and reopening it restores what was expanded inside.
    const toggled = new Set<string>()
    const tree = () => (
      <CaseTree
        cases={DEEP}
        visible={DEEP}
        useScope={false}
        defaultExpanded={false}
        toggled={toggled}
        onToggle={(k) => { toggled.add(k) }}
      />
    )
    const { rerender, unmount } = render(tree())
    fireEvent.click(pathRow('web/src'))
    rerender(tree())
    expect(screen.getByText('components')).toBeTruthy()

    unmount()
    render(tree())
    expect(screen.getByText('components')).toBeTruthy()
  })
})
