import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, render, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { FileDiff, FileRow, TreeNodeView, diffMetaKey } from './DiffViewer'
import { commitParentSelection, reconcileRightSelection } from './lib/commitRange'
import { bodyShape, buildSegments, regionKey, type RevealMap } from './lib/diffBody'
import { DiffFile, DiffHunk, DiffLine, type DiffResponse } from './api'
import { EXPANDER_ROW, UNIFIED_CODE_CLASS, SBS_CODE, type BodyShape } from './lib/diffMetrics'

// bodyShape tells diffMetrics what a file body WILL render so its height can be
// measured before the rows exist (that measurement is what keeps the scrollbar
// from growing as you scroll a big diff). It mirrors FileDiff's render branches
// by hand, so the risk is drift: a change to how the body renders that
// bodyShape doesn't learn about silently makes every placeholder wrong again.
//
// These tests render the real body and count what came out, then assert
// bodyShape predicted exactly that. jsdom has no layout - which is fine, because
// nothing here measures pixels; it counts rows and expanders. (It also has no
// IntersectionObserver, so FileDiff renders its body immediately rather than
// waiting to be scrolled near.)
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const commits = [
  { sha: 'new', short_sha: 'new', message: 'new', author_name: 'A', author_email: 'a@example.com', timestamp: '', additions: 1, deletions: 0, parent_sha: 'middle' },
  { sha: 'middle', short_sha: 'middle', message: 'middle', author_name: 'A', author_email: 'a@example.com', timestamp: '', additions: 1, deletions: 0, parent_sha: 'old' },
  { sha: 'old', short_sha: 'old', message: 'old', author_name: 'A', author_email: 'a@example.com', timestamp: '', additions: 1, deletions: 0, parent_sha: 'branch-point' },
]

describe('commit range selection', () => {
  it('uses the oldest commit actual parent when isolating it', () => {
    expect(commitParentSelection('old', commits)).toEqual({ type: 'base', sha: 'branch-point' })
  })

  it('moves left to the selected commit parent when a right click would invert the range', () => {
    expect(reconcileRightSelection({ type: 'commit', sha: 'middle' }, { type: 'commit', sha: 'old' }, commits)).toEqual({
      left: { type: 'base', sha: 'branch-point' },
      right: { type: 'commit', sha: 'old' },
    })
  })

  it('preserves a valid multi-commit range', () => {
    expect(reconcileRightSelection({ type: 'commit', sha: 'old' }, { type: 'commit', sha: 'new' }, commits)).toEqual({
      left: { type: 'commit', sha: 'old' },
      right: { type: 'commit', sha: 'new' },
    })
  })
})

const line = (type: DiffLine.type, content: string, oldN: number | null, newN: number | null): DiffLine =>
  ({ type, content, old_line_num: oldN, new_line_num: newN })

const ctx = (content: string, n: number) => line(DiffLine.type.CONTEXT, content, n, n)
const add = (content: string, n: number) => line(DiffLine.type.ADDITION, content, null, n)
const del = (content: string, n: number) => line(DiffLine.type.DELETION, content, n, null)

const hunk = (lines: DiffLine[], oldStart = 1, newStart = 1): DiffHunk =>
  ({ header: `@@ -${oldStart} +${newStart} @@`, old_start: oldStart, new_start: newStart, lines })

function file(over: Partial<DiffFile>): DiffFile {
  return {
    path: 'a.ts', change_type: DiffFile.change_type.MODIFIED,
    additions: 1, deletions: 1, binary: false, hunks: [], ...over,
  }
}

describe('diff sidebar path tooltips', () => {
  it('keeps the change type beside the filename and the line counts right aligned', () => {
    render(
      <FileRow
        file={file({ path: 'docs/guide/README.md' })}
        isActive={false}
        onClick={() => {}}
      />,
    )

    const filenameCluster = screen.getByText('README.md').parentElement?.parentElement
    const changeType = screen.getByLabelText('modified')
    const lineCounts = screen.getByLabelText('1 lines added, 1 lines removed')

    expect(filenameCluster).toContainElement(changeType)
    expect(filenameCluster).not.toContainElement(lineCounts)
    expect(lineCounts).toHaveClass('ml-auto')
  })

  it('shows the shared file-path treatment for a file row', () => {
    vi.useFakeTimers()
    const { container } = render(
      <FileRow
        file={file({ path: 'docs/guide/README.md' })}
        isActive={false}
        onClick={() => {}}
      />,
    )

    fireEvent.mouseEnter(screen.getByText('README.md'))
    act(() => void vi.advanceTimersByTime(600))

    const tooltip = screen.getByRole('tooltip')
    expect(within(tooltip).getByText('docs/guide/')).toHaveClass('text-stone-400')
    expect(within(tooltip).getByText('README.md')).toHaveClass('text-stone-700')
    expect(within(tooltip).getByText('README.md').parentElement).toHaveClass('whitespace-normal', 'break-words')
    expect(tooltip.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('[title]')).toBeNull()
  })

  it('shows the full directory path for a tree folder', () => {
    vi.useFakeTimers()
    render(
      <TreeNodeView
        node={{ name: 'components', path: 'web/src/components', type: 'dir', children: [] }}
        depth={0}
        collapsedFolders={new Set()}
        toggleFolder={() => {}}
        onFileClick={() => {}}
        activeFilePath={null}
      />,
    )

    fireEvent.mouseEnter(screen.getByText('components'))
    act(() => void vi.advanceTimersByTime(600))

    const tooltip = screen.getByRole('tooltip')
    expect(within(tooltip).getByText('web/src/components')).toHaveClass('text-stone-700')
    expect(tooltip.querySelector('svg')).not.toBeNull()
  })
})

describe('file header metadata', () => {
  it('marks generated files and passes the current blob to the viewed toggle', () => {
    const onToggleViewed = vi.fn()
    render(
      <FileDiff
        file={file({ path: 'Cargo.lock', head_blob_sha: 'blob-1' })}
        sideBySide={false}
        currentContext={3}
        viewed={false}
        onToggleViewed={onToggleViewed}
        onComment={() => {}}
        onExpand={() => {}}
        isCollapsed={false}
        onToggleCollapse={() => {}}
      />,
    )

    expect(screen.getByText('Auto-generated')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Viewed' }))
    expect(onToggleViewed).toHaveBeenCalledWith('Cargo.lock', 'blob-1')
  })

  it('searches for and applies a syntax language override', () => {
    render(
      <FileDiff
        file={file({ path: 'a.ts' })}
        sideBySide={false}
        currentContext={3}
        onComment={() => {}}
        onExpand={() => {}}
        isCollapsed={false}
        onToggleCollapse={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Syntax highlighting: TypeScript' }))
    fireEvent.change(screen.getByPlaceholderText('Search languages, aliases, extensions'), { target: { value: '.libsonnet' } })
    fireEvent.click(screen.getByRole('button', { name: /Jsonnet/ }))
    expect(screen.getByRole('button', { name: 'Syntax highlighting: Jsonnet' })).toBeInTheDocument()
  })
})

describe('viewed file delta', () => {
  it('labels new changes and marks the latest blob when reviewed', () => {
    const onToggleViewed = vi.fn()
    const reviewedDelta = file({
      path: 'README.md',
      head_blob_sha: 'current-blob',
      hunks: [hunk([ctx('already reviewed', 1), add('new since review', 2)])],
    })
    const { rerender } = render(
      <FileDiff
        file={reviewedDelta} sideBySide={false} currentContext={3}
        viewed={false} showingSinceViewed onToggleViewed={onToggleViewed}
        onComment={() => {}} onExpand={() => {}}
        isCollapsed={false} onToggleCollapse={() => {}}
      />,
    )

    expect(screen.getByText('New since viewed')).toBeVisible()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Viewed' }))
    expect(onToggleViewed).toHaveBeenCalledWith('README.md', 'current-blob')

    rerender(
      <FileDiff
        file={reviewedDelta} sideBySide={false} currentContext={3}
        viewed showingSinceViewed={false} onToggleViewed={onToggleViewed}
        onComment={() => {}} onExpand={() => {}}
        isCollapsed={false} onToggleCollapse={() => {}}
      />,
    )
    expect(screen.queryByText('New since viewed')).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Viewed' })).toBeChecked()
  })
})

// A whole-file (expanded) diff: 40 unchanged lines, a change, 40 more. The
// reveal model shows the selected context either side of the change and collapses the rest
// behind expanders, so the rendered row count is far below the line count.
function wholeFile(): DiffFile {
  const lines: DiffLine[] = []
  for (let i = 1; i <= 40; i++) lines.push(ctx(`context line ${i}`, i))
  lines.push(del('old code', 41))
  lines.push(add('new code', 41))
  for (let i = 42; i <= 81; i++) lines.push(ctx(`context line ${i}`, i))
  return file({ expanded: true, additions: 1, deletions: 1, hunks: [hunk(lines)] })
}

describe('context reveal animation keys', () => {
  it('keeps the growing run mounted when showing all remaining lines', () => {
    const lines = wholeFile().hunks.flatMap((part) => part.lines)
    const leadId = regionKey(lines[0])
    const initial = buildSegments(lines, new Map()).find((seg) => seg.regionId === leadId)
    expect(initial?.kind).toBe('topedge')

    const reveal: RevealMap = new Map([[leadId, { bot: 40 }]])
    const expanded = buildSegments(lines, reveal).find((seg) => seg.key === 'cb0')
    expect(expanded).toMatchObject({ kind: 'lines', lines: lines.slice(0, 40) })
  })

  it('keeps the bar and opposite context mounted throughout the final reveal', () => {
    const lines = [add('before', 1)]
    for (let i = 2; i <= 11; i++) lines.push(ctx(`context ${i}`, i))
    lines.push(add('after', 12))
    const id = regionKey(lines[1])

    const closing: RevealMap = new Map([[id, {
      top: 10,
      closingHidden: 4,
      closingSide: 'top',
    }]])
    expect(buildSegments(lines, closing).map((seg) => [seg.key, seg.kind, seg.closing])).toEqual([
      ['b0', 'lines', undefined],
      ['ct1', 'lines', undefined],
      ['g1', 'gap', true],
      ['cb1', 'lines', undefined],
      ['b11', 'lines', undefined],
    ])

    const settled: RevealMap = new Map([[id, { top: 10, settled: true }]])
    expect(buildSegments(lines, settled).map((seg) => seg.key)).toEqual(['b0', 'c1', 'b11'])
  })
})

// Two windowed `-U3` hunks with a gap between them - the other render branch.
function windowedFile(): DiffFile {
  return file({
    expanded: false, additions: 2, deletions: 0,
    hunks: [
      hunk([ctx('a', 10), ctx('b', 11), add('added one', 12), ctx('c', 13)], 10, 10),
      hunk([ctx('d', 60), add('added two', 61), ctx('e', 62)], 60, 60),
    ],
  })
}

function renderBody(f: DiffFile, sideBySide: boolean, currentContext = 3) {
  const { container } = render(
    <FileDiff
      file={f} sideBySide={sideBySide} currentContext={currentContext}
      onComment={() => {}} onExpand={() => {}}
      isCollapsed={false} onToggleCollapse={() => {}}
    />,
  )
  // getAttribute, not .className: svg icons carry an SVGAnimatedString there.
  const classes = Array.from(container.querySelectorAll('*'), (el) => el.getAttribute('class') ?? '')
  return {
    // The code cell of every rendered diff row. no_newline rows append extra
    // classes to the same base, hence startsWith.
    unifiedCells: classes.filter((c) => c.startsWith(UNIFIED_CODE_CLASS)).length,
    sbsCells: classes.filter((c) => c === SBS_CODE).length,
    expanders: classes.filter((c) => c === EXPANDER_ROW).length,
  }
}

const rows = (s: BodyShape | null) => (s?.kind === 'rows' ? s.lines.length : -1)
const pairs = (s: BodyShape | null) => (s?.kind === 'sbsRows' ? s.pairs.length : -1)
const expanders = (s: BodyShape | null) => (s && 'expanders' in s ? s.expanders.length : -1)

describe('bodyShape matches what the body renders', () => {
  it('predicts the rows and expanders of a whole-file diff', () => {
    const f = wholeFile()
    const shape = bodyShape(f, false, false, 3)
    const seen = renderBody(f, false)
    expect(rows(shape)).toBe(seen.unifiedCells)
    expect(expanders(shape)).toBe(seen.expanders)
    // Sanity: the reveal model really did collapse most of the file.
    expect(rows(shape)).toBeLessThan(20)
    expect(expanders(shape)).toBe(2)
  })

  it('predicts the rows and expanders of a windowed multi-hunk diff', () => {
    const f = windowedFile()
    const shape = bodyShape(f, false, false, 3)
    const seen = renderBody(f, false)
    expect(rows(shape)).toBe(seen.unifiedCells)
    expect(expanders(shape)).toBe(seen.expanders)
  })

  it('predicts side-by-side row pairs (each pair renders two code cells)', () => {
    for (const f of [wholeFile(), windowedFile()]) {
      cleanup()
      const shape = bodyShape(f, true, false, 3)
      const seen = renderBody(f, true)
      expect(pairs(shape)).toBe(seen.sbsCells / 2)
      expect(expanders(shape)).toBe(seen.expanders)
    }
  })

  it('carries the label text of each expander, so a narrow pane can be measured', () => {
    const shape = bodyShape(wholeFile(), false, false, 3)
    // Leading and trailing edge expanders each offer a directional action and
    // show-all, both counting the 37 lines they hide.
    expect(shape).toMatchObject({ expanders: [{ buttons: 2, hidden: 37 }, { buttons: 2, hidden: 37 }] })
  })

  it('uses the selected context for whole-file rendering and measurement', () => {
    const f = wholeFile()
    const shape = bodyShape(f, false, false, 10)
    const seen = renderBody(f, false, 10)
    expect(rows(shape)).toBe(seen.unifiedCells)
    expect(expanders(shape)).toBe(seen.expanders)
    expect(shape).toMatchObject({ expanders: [{ buttons: 2, hidden: 30 }, { buttons: 2, hidden: 30 }] })
  })

  it('describes the fixed-height bodies', () => {
    expect(bodyShape(file({ binary: true, path: 'x.bin' }), false, false, 3)).toEqual({ kind: 'notice' })
    // An in-tree image is the one body whose height nothing can predict.
    expect(bodyShape(file({ binary: true, path: 'x.png' }), false, false, 3)).toBeNull()
    expect(bodyShape(file({ hunks: [hunk([ctx('a', 1)])], additions: 900, deletions: 200 }), false, true, 3))
      .toEqual({ kind: 'hidden', changed: 1100 })
    // A pure rename has whole-file content but nothing changed: a label, not lines.
    expect(bodyShape(file({ additions: 0, deletions: 0, hunks: [hunk([ctx('a', 1)])] }), false, false, 3))
      .toEqual({ kind: 'notice' })
    expect(bodyShape(file({ hunks: [] }), false, false, 3)).toEqual({ kind: 'notice' })
  })
})

// A windowed diff shows fragments of a file, and gluing them together to
// highlight them invents code that isn't there: a `{/*` on the last visible line
// of one hunk has no `*/` until a line the diff never shows, so every fragment
// below it came back as comment. Whole files of AgentChat.tsx read italic grey
// from one JSX comment. Each contiguous run is highlighted on its own now.
describe('highlighting does not leak across a collapsed gap', () => {
  const truncatedComment = () => file({
    path: 'a.tsx', expanded: false, additions: 1, deletions: 0,
    hunks: [
      hunk([ctx('const before = 1', 10), ctx('  {/* an opening comment', 11)], 10, 10),
      hunk([ctx('const after = 2', 60), add('const added = 3', 61)], 60, 60),
    ],
  })

  const codeCells = (c: HTMLElement) =>
    Array.from(c.querySelectorAll(`span[class^="${UNIFIED_CODE_CLASS}"]`), (el) => el.innerHTML)

  it('leaves the fragments below an unterminated comment un-commented', () => {
    const { container } = render(
      <FileDiff
        file={truncatedComment()} sideBySide={false} currentContext={3}
        onComment={() => {}} onExpand={() => {}}
        isCollapsed={false} onToggleCollapse={() => {}}
      />,
    )
    const cells = codeCells(container)
    // Sanity: the run that really does open the comment still marks it as one.
    expect(cells.find((h) => h.includes('an opening comment'))).toContain('comment')
    for (const html of cells.filter((h) => h.includes('const a'))) {
      expect(html).not.toContain('comment')
      expect(html).toContain('token') // ...and is highlighted, not left plain
    }
  })
})

// Every collapsed gap says which declaration the code below it belongs to. The
// server ships an expanded file as ONE whole-file hunk, whose header starts at
// line 1 and so carries no `@@ ... @@ <context>` trailer at all - which is why
// the label is derived from the content rather than read off the header.
describe('expander context labels', () => {
  function fileWithHiddenFunction(): DiffFile {
    const lines: DiffLine[] = []
    lines.push(add('const first = 1', 1))
    for (let i = 2; i <= 20; i++) lines.push(ctx(`  body ${i}`, i))
    lines.push(ctx('function theEnclosingOne() {', 21))
    for (let i = 22; i <= 40; i++) lines.push(ctx(`  body ${i}`, i))
    lines.push(add('  const second = 2', 41))
    return file({ path: 'a.ts', expanded: true, additions: 2, deletions: 0, hunks: [hunk(lines)] })
  }

  it('names the declaration enclosing the code below the gap, highlighted', () => {
    const { container } = render(
      <FileDiff
        file={fileWithHiddenFunction()} sideBySide={false} currentContext={3}
        onComment={() => {}} onExpand={() => {}}
        isCollapsed={false} onToggleCollapse={() => {}}
      />,
    )
    const row = Array.from(container.querySelectorAll(`div[class="${EXPANDER_ROW}"]`))
      .find((el) => el.textContent?.includes('lines'))
    expect(row?.textContent).toContain('function theEnclosingOne() {')
    // The label carries the file's own token markup rather than flat grey text.
    expect(row?.innerHTML).toContain('token keyword')
  })
})

// A file too big to ship whole arrives as `-U3` fragments, and its two edge
// expanders identify their direction and count: the gaps BETWEEN hunks can state their
// size (two hunk headers bracket them) but the runs above the first and below the
// last had nothing to measure against, so the reader was told "there is more"
// without being told how much - and only learnt it after a click promoted the
// file. The run above is measurable from the first hunk's start line; the run
// below needs the file's length, which the diff now carries as total_lines.
describe('a windowed file counts what its edges hide', () => {
  // One `-U3` hunk spanning lines 100-105 of a 500-line file: 99 lines above it,
  // 395 below. Its trailing context is a full 3 lines, so the old
  // "fewer context lines than we asked for" test can't tell where EOF is.
  const deepHunk = () =>
    hunk([ctx('a', 100), ctx('b', 101), add('added', 102), ctx('c', 103), ctx('d', 104), ctx('e', 105)], 100, 100)
  const windowedDeep = (over: Partial<DiffFile> = {}) =>
    file({ expanded: false, additions: 1, deletions: 0, hunks: [deepHunk()], ...over })

  const expanderTexts = (f: DiffFile, currentContext = 3) => {
    cleanup()
    const { container } = render(
      <FileDiff
        file={f} sideBySide={false} currentContext={currentContext}
        onComment={() => {}} onExpand={() => {}}
        isCollapsed={false} onToggleCollapse={() => {}}
      />,
    )
    return Array.from(container.querySelectorAll(`div[class="${EXPANDER_ROW}"]`), (el) => el.textContent ?? '')
  }

  it('counts both edges when the file states its length', () => {
    const f = windowedDeep({ total_lines: 500 })
    expect(expanderTexts(f)).toEqual([
      expect.stringContaining('99 lines'),
      expect.stringContaining('395 lines'),
    ])
    expect(bodyShape(f, false, false, 3)).toMatchObject({
      expanders: [{ buttons: 2, hidden: 99 }, { buttons: 2, hidden: 395 }],
    })
  })

  it('still counts the leading run without one, and leaves the trailing action directional-only', () => {
    const f = windowedDeep()
    expect(expanderTexts(f)).toEqual([expect.stringContaining('99 lines'), 'Down 20 lines'])
    expect(bodyShape(f, false, false, 3)).toMatchObject({
      expanders: [{ buttons: 2, hidden: 99 }, { buttons: 1, hidden: null }],
    })
  })

  // The old EOF test - "fewer trailing context lines than we asked for" - can't
  // tell a hunk that ends exactly `currentContext` lines from EOF apart from one
  // with more file below it, and drew a chevron that expanded to nothing.
  // total_lines settles it, so that expander now disappears.
  it('drops the trailing expander when the last hunk provably reaches EOF', () => {
    const atEof = windowedDeep({ total_lines: 105 })
    expect(expanderTexts(atEof)).toEqual([expect.stringContaining('99 lines')])
    expect(bodyShape(atEof, false, false, 3)).toMatchObject({ expanders: [{ buttons: 2, hidden: 99 }] })
  })

  it('leaves a file that starts at line 1 without a leading expander', () => {
    const f = file({
      expanded: false, additions: 1, deletions: 0, total_lines: 500,
      hunks: [hunk([ctx('a', 1), add('added', 2), ctx('b', 3)], 1, 1)],
    })
    expect(expanderTexts(f)).toEqual([expect.stringContaining('497 lines')])
  })
})

// A silent (WS-triggered) refresh skips re-rendering when the FILES it fetched
// are identical to the ones on screen - that early-out is what keeps an agent's
// every git command from disturbing the reader's text selection. But merging the
// base in changes no file at all (the diff is against that base) while taking
// behind_count to 0, so dropping the whole response left the "N behind" chip and
// its Update-from-base button sitting there until the page was reloaded.
// diffMetaKey is what the refresh now compares to notice.
describe('diffMetaKey', () => {
  const resp = (over: Partial<DiffResponse> = {}): DiffResponse => ({
    files: [file({ path: 'a.ts' })], base_ref: 'main', head_ref: 'hydra/x', behind_count: 40, ...over,
  })

  it('ignores the files', () => {
    expect(diffMetaKey(resp())).toBe(diffMetaKey(resp({ files: [file({ path: 'b.ts', additions: 9 })] })))
  })

  it('notices the branch catching up with its base', () => {
    expect(diffMetaKey(resp())).not.toBe(diffMetaKey(resp({ behind_count: 0 })))
  })

  it('notices the other header state', () => {
    expect(diffMetaKey(resp())).not.toBe(diffMetaKey(resp({ uncommitted_changes: true })))
    expect(diffMetaKey(resp())).not.toBe(diffMetaKey(resp({ merge_conflict: true })))
    expect(diffMetaKey(resp())).not.toBe(diffMetaKey(resp({ head_ref: 'hydra/y' })))
  })
})
