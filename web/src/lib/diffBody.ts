// The diff body model: the pure logic that decides what a file's diff body
// renders, with no JSX in sight.
//
// DiffViewer renders from these (buildSegments -> the reveal/collapse model,
// buildSideBySide -> the paired rows), and bodyShape below re-states the same
// decisions as data so diffMetrics can measure a body's height before any of it
// is mounted - see the note in diffMetrics.ts for why that matters. Keeping both
// callers in one module is the point: the shape and the render must agree, and
// DiffViewer.test.tsx renders a real body to check that they still do.
import type { DiffFile, DiffHunk, DiffLine } from '../api'
import { isImagePath } from './imageDiff'
import type { BodyShape, ExpanderShape, SbsPair } from './diffMetrics'

export interface SideBySideLine {
  oldLineNum: number | null
  oldType: 'context' | 'deletion' | 'empty'
  oldContent: string | null
  newLineNum: number | null
  newType: 'context' | 'addition' | 'empty'
  newContent: string | null
}

export function buildSideBySide(hunkLines: DiffHunk['lines']): SideBySideLine[] {
  const result: SideBySideLine[] = []
  let i = 0
  while (i < hunkLines.length) {
    const l = hunkLines[i]
    if (l.type === 'context') {
      result.push({
        oldLineNum: l.old_line_num ?? null, oldType: 'context', oldContent: l.content,
        newLineNum: l.new_line_num ?? null, newType: 'context', newContent: l.content,
      })
      i++
    } else if (l.type === 'deletion') {
      const dels: typeof hunkLines = []
      const adds: typeof hunkLines = []
      while (i < hunkLines.length && hunkLines[i].type === 'deletion') dels.push(hunkLines[i++])
      while (i < hunkLines.length && hunkLines[i].type === 'addition') adds.push(hunkLines[i++])
      const maxLen = Math.max(dels.length, adds.length)
      for (let j = 0; j < maxLen; j++) {
        result.push({
          oldLineNum: dels[j]?.old_line_num ?? null,
          oldType: j < dels.length ? 'deletion' : 'empty',
          oldContent: dels[j]?.content ?? null,
          newLineNum: adds[j]?.new_line_num ?? null,
          newType: j < adds.length ? 'addition' : 'empty',
          newContent: adds[j]?.content ?? null,
        })
      }
    } else if (l.type === 'addition') {
      result.push({
        oldLineNum: null, oldType: 'empty', oldContent: null,
        newLineNum: l.new_line_num ?? null, newType: 'addition', newContent: l.content,
      })
      i++
    } else {
      i++
    }
  }
  return result
}

// Computes the number of lines hidden between two adjacent hunks.
export function computeGap(prevHunk: DiffHunk, nextHunk: DiffHunk): number {
  let lastNewLine = 0
  let lastOldLine = 0
  for (const l of prevHunk.lines) {
    if (l.new_line_num != null) lastNewLine = l.new_line_num
    if (l.old_line_num != null) lastOldLine = l.old_line_num
  }
  const lastLine = lastNewLine > 0 ? lastNewLine : lastOldLine
  const nextStart = nextHunk.new_start > 0 ? nextHunk.new_start : nextHunk.old_start
  return Math.max(0, nextStart - lastLine - 1)
}

// trailingContext counts the unchanged context lines at the very end of a hunk,
// ignoring a trailing "no newline" marker. `git diff -U<n>` emits up to `n`
// context lines after the last change, so when a hunk shows fewer than the
// requested context it has run out of file - the hunk already reaches EOF and
// there is nothing left below to expand into.
export function trailingContext(hunk: DiffHunk): number {
  let count = 0
  for (let i = hunk.lines.length - 1; i >= 0; i--) {
    const t = hunk.lines[i].type
    if (t === 'no_newline') continue
    if (t === 'context') { count++; continue }
    break
  }
  return count
}

// Default surrounding-context lines shown around each change (mirrors the git
// `-U3` the diff is first fetched with).
export const CTX = 3

// An unchanged run that would hide this few lines behind an expander isn't worth
// collapsing - a "··· 1 line ···" toggle saves no vertical space and just adds a
// click - so show those lines inline instead.
export const MIN_COLLAPSE_GAP = 1

// Files whose full content exceeds this many lines keep the lightweight `-U3`
// view + network expansion rather than rendering the whole file client-side.
// The server applies the same cap when deciding which files to expand in the
// full_context response (max_full_lines); this is the matching client guard.
export const FULL_MAX_LINES = 6000

export const isChangeLine = (l: DiffLine) => l.type === 'addition' || l.type === 'deletion'

// isContiguous verifies the line-number sequence has no gaps, i.e. these lines
// really are the *entire* file (`git diff -U<huge>`) and not several hunks with
// hidden lines between them. Only then is client-side reveal correct.
export function isContiguous(lines: DiffLine[]): boolean {
  let prevOld: number | null = null
  let prevNew: number | null = null
  for (const l of lines) {
    if (l.old_line_num != null) {
      if (prevOld != null && l.old_line_num !== prevOld + 1) return false
      prevOld = l.old_line_num
    }
    if (l.new_line_num != null) {
      if (prevNew != null && l.new_line_num !== prevNew + 1) return false
      prevNew = l.new_line_num
    }
  }
  return true
}

// How many context lines a region currently shows at its top (adjacent to the
// preceding change) and bottom (adjacent to the following change). Absent ⇒
// region uses its default.
export type RevealMap = Map<string, { top?: number; bot?: number }>

export interface RenderSeg {
  kind: 'lines' | 'gap' | 'topedge' | 'botedge'
  key: string
  lines?: DiffLine[]
  regionId?: string
  hidden?: number
  top?: number     // resolved context lines shown at the region's top
  bot?: number     // resolved context lines shown at the region's bottom
  length?: number  // total lines in the region
  context?: DiffLine // enclosing function/section line of the code just below the gap
}

export const regionKey = (l: DiffLine) => `${l.old_line_num ?? 'x'}:${l.new_line_num ?? 'x'}`

// hunkContext returns the function-context trailer git appends after the second
// `@@` of a hunk header (`@@ -a,b +c,d @@ <context>`) - the enclosing function or
// section git worked out via its per-language xfuncname driver - or '' when the
// header carries none.
export function hunkContext(header: string): string {
  const close = header.indexOf('@@', 2)
  return close < 0 ? '' : header.slice(close + 2).trim()
}

// Git's DEFAULT funcname heuristic (xdiff/xemit.c def_ff), used when no
// per-language diff driver is configured: a line is "a function line" if it
// starts with a letter, `_` or `$`. Crude - it catches `export function foo(` and
// `type X = {` alike - but it is what the `@@ ... @@ <context>` trailer already
// shows everywhere else, so deriving our own labels this way keeps the two paths
// saying the same thing.
const FUNC_LINE = /^[A-Za-z_$]/

// findContextLine searches backwards from `from` for the line git would name in
// a hunk header there - the nearest preceding top-level declaration.
//
// Why we do this ourselves rather than read the `@@` trailers: a file the server
// sent in FULL (the whole-file reveal model below) arrives as a single
// whole-file hunk, whose one header starts at line 1 and therefore carries no
// context at all. Every collapsed gap in it would be unlabelled while the big
// files that stay windowed - the ones still shipped as several `-U3` hunks, each
// with its own trailer - kept their labels. Scanning the content we already hold
// labels every gap, and lets the label carry the line's own highlighting.
//
// Deletions are skipped: the label describes the file as it now reads. A file
// with nothing but deletions (a delete) has no such line, so the second pass
// takes whatever is there.
function findContextLine(lines: DiffLine[], from: number): DiffLine | undefined {
  for (let i = from - 1; i >= 0; i--) {
    const l = lines[i]
    if (l.type !== 'deletion' && FUNC_LINE.test(l.content)) return l
  }
  for (let i = from - 1; i >= 0; i--) {
    if (FUNC_LINE.test(lines[i].content)) return lines[i]
  }
  return undefined
}

// buildSegments turns a fully-fetched file (every line as a diff line) plus the
// user's per-region reveal state into a flat list of render segments: runs of
// visible lines interleaved with collapsed-region expanders. Each unchanged run
// between (or around) changes shows `CTX` lines next to the change by default
// and collapses the rest behind an expander; expanders that would hide nothing
// (short gaps, the file's true top/bottom once fully revealed) are omitted, so
// e.g. a 1-line gap simply renders the line and the top expander vanishes at
// line 1 / the bottom expander at EOF.
export function buildSegments(fullLines: DiffLine[], reveal: RevealMap): RenderSeg[] {
  const n = fullLines.length
  const runs: { change: boolean; s: number; e: number }[] = []
  let i = 0
  while (i < n) {
    const change = isChangeLine(fullLines[i])
    let e = i + 1
    while (e < n && isChangeLine(fullLines[e]) === change) e++
    runs.push({ change, s: i, e })
    i = e
  }

  const segs: RenderSeg[] = []
  runs.forEach((run, ri) => {
    if (run.change) {
      segs.push({ kind: 'lines', key: `b${run.s}`, lines: fullLines.slice(run.s, run.e) })
      return
    }
    const L = run.e - run.s
    const isLead = ri === 0
    const isTrail = ri === runs.length - 1
    const id = regionKey(fullLines[run.s])
    const ov = reveal.get(id)
    const top = Math.min(L, ov?.top ?? (isLead ? 0 : CTX))
    const bot = Math.min(L - top, ov?.bot ?? (isTrail ? 0 : CTX))
    const hidden = L - top - bot
    if (hidden <= MIN_COLLAPSE_GAP) {
      segs.push({ kind: 'lines', key: `c${run.s}`, lines: fullLines.slice(run.s, run.e) })
      return
    }
    if (top > 0) segs.push({ kind: 'lines', key: `ct${run.s}`, lines: fullLines.slice(run.s, run.s + top) })
    // Label the gap with the declaration enclosing the code that resumes just
    // below it, so you needn't reveal it to know what you're looking at. The
    // search starts at the first row the reader sees under the expander. The
    // trailing edge has nothing below it, so it stays unlabelled - as git also
    // leaves the tail of a file.
    const context = isTrail ? undefined : findContextLine(fullLines, run.e - bot)
    segs.push({
      kind: isLead ? 'topedge' : isTrail ? 'botedge' : 'gap',
      key: `g${run.s}`, regionId: id, hidden, top, bot, length: L, context,
    })
    if (bot > 0) segs.push({ kind: 'lines', key: `cb${run.s}`, lines: fullLines.slice(run.e - bot, run.e) })
  })
  return segs
}

// No per-region reveals are possible while a body is still a placeholder, so the
// shape below is always built against an empty reveal map.
const NO_REVEAL: RevealMap = new Map()

// bodyShape describes what a file's body WILL render - the visible code lines in
// order plus the expander rows between them - so diffMetrics can measure its
// height before any of it exists. It mirrors the body's render branches below
// (whole-file segments when the server sent full content, the `-U3` hunks
// otherwise, the fixed one-line notice for binary/no-change files, the "Load
// diff" block for hidden ones), so the two must be kept in step. Returns null
// for the one body whose height nothing can predict: an in-tree image.
export function bodyShape(file: DiffFile, sideBySide: boolean, isHidden: boolean, currentContext: number): BodyShape | null {
  if (file.binary) return isImagePath(file.path) ? null : { kind: 'notice' }
  if (isHidden) return { kind: 'hidden', changed: file.additions + file.deletions }
  const hunks = file.hunks ?? []
  if (hunks.length === 0) return { kind: 'notice' }
  // A whole file with no additions/deletions (a pure rename) collapses to a
  // label in the stacked view rather than rendering its lines.
  if (file.additions === 0 && file.deletions === 0) return { kind: 'notice' }

  const all = hunks.flatMap((h) => h.lines)
  const whole = !!file.expanded && all.length > 0 && all.length <= FULL_MAX_LINES && isContiguous(all)

  // Runs of lines that render as rows, and the expander rows interleaved between
  // them - counted exactly the way each render branch emits them.
  const runs: DiffLine[][] = []
  const expanders: ExpanderShape[] = []
  if (whole) {
    for (const seg of buildSegments(all, NO_REVEAL)) {
      // A gap sits between two changes and offers both directions; the file's
      // leading/trailing edges only offer one.
      if (seg.kind === 'lines') runs.push(seg.lines!)
      else expanders.push({ buttons: seg.kind === 'gap' ? 2 : 1, hidden: seg.hidden! })
    }
  } else {
    hunks.forEach((hunk, i) => {
      const isFirst = i === 0
      const isLast = i === hunks.length - 1
      const atTopOfFile = isFirst && hunk.new_start <= 1 && hunk.old_start <= 1
      const atEndOfFile = isLast && trailingContext(hunk) < currentContext
      const gap = isFirst ? 0 : computeGap(hunks[i - 1], hunk)
      // The windowed-hunk path's edge expanders are a bare chevron - no count.
      if (isFirst && !atTopOfFile) expanders.push({ buttons: 1, hidden: null })
      if (!isFirst && gap > 0) expanders.push({ buttons: 2, hidden: gap })
      runs.push(hunk.lines)
      if (isLast && !atEndOfFile) expanders.push({ buttons: 1, hidden: null })
    })
  }

  if (!sideBySide) return { kind: 'rows', expanders, lines: runs.flatMap((run) => run.map((l) => l.content)) }
  // Side by side pairs deletions with additions per rendered run, so build the
  // pairs the same way the renderer does - one buildSideBySide call per run.
  const pairs: SbsPair[] = []
  for (const run of runs) {
    for (const l of buildSideBySide(run)) pairs.push({ old: l.oldContent, new: l.newContent })
  }
  return { kind: 'sbsRows', expanders, pairs }
}
