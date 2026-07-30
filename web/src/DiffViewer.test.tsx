import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { FileDiff, diffMetaKey } from './DiffViewer'
import { bodyShape } from './lib/diffBody'
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
afterEach(cleanup)

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

// A whole-file (expanded) diff: 40 unchanged lines, a change, 40 more. The
// reveal model shows CTX lines either side of the change and collapses the rest
// behind expanders, so the rendered row count is far below the line count.
function wholeFile(): DiffFile {
  const lines: DiffLine[] = []
  for (let i = 1; i <= 40; i++) lines.push(ctx(`context line ${i}`, i))
  lines.push(del('old code', 41))
  lines.push(add('new code', 41))
  for (let i = 42; i <= 81; i++) lines.push(ctx(`context line ${i}`, i))
  return file({ expanded: true, additions: 1, deletions: 1, hunks: [hunk(lines)] })
}

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

function renderBody(f: DiffFile, sideBySide: boolean) {
  const { container } = render(
    <FileDiff
      file={f} sideBySide={sideBySide} currentContext={3}
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
    // Leading and trailing edge expanders: one chevron each, both counting the
    // 37 lines they hide (40 minus the CTX shown next to the change).
    expect(shape).toMatchObject({ expanders: [{ buttons: 1, hidden: 37 }, { buttons: 1, hidden: 37 }] })
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
// expanders used to be bare chevrons: the gaps BETWEEN hunks could state their
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
      expanders: [{ buttons: 1, hidden: 99 }, { buttons: 1, hidden: 395 }],
    })
  })

  it('still counts the leading run without one, and leaves the trailing chevron bare', () => {
    const f = windowedDeep()
    expect(expanderTexts(f)).toEqual([expect.stringContaining('99 lines'), ''])
    expect(bodyShape(f, false, false, 3)).toMatchObject({
      expanders: [{ buttons: 1, hidden: 99 }, { buttons: 1, hidden: null }],
    })
  })

  // The old EOF test - "fewer trailing context lines than we asked for" - can't
  // tell a hunk that ends exactly `currentContext` lines from EOF apart from one
  // with more file below it, and drew a chevron that expanded to nothing.
  // total_lines settles it, so that expander now disappears.
  it('drops the trailing expander when the last hunk provably reaches EOF', () => {
    const atEof = windowedDeep({ total_lines: 105 })
    expect(expanderTexts(atEof)).toEqual([expect.stringContaining('99 lines')])
    expect(bodyShape(atEof, false, false, 3)).toMatchObject({ expanders: [{ buttons: 1, hidden: 99 }] })
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
