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

// The line number a hunk's last line sits on, and the one its first line starts
// on, both counted on the new side - falling back to the old side when the hunk
// has no new side at all (a deletion). Unchanged lines carry the same number on
// both sides, and every gap is measured from unchanged ground, so which side
// answers only matters for that all-deletions case.
function lastLineNum(hunk: DiffHunk): number {
  let lastNewLine = 0
  let lastOldLine = 0
  for (const l of hunk.lines) {
    if (l.new_line_num != null) lastNewLine = l.new_line_num
    if (l.old_line_num != null) lastOldLine = l.old_line_num
  }
  return lastNewLine > 0 ? lastNewLine : lastOldLine
}

const startLineNum = (hunk: DiffHunk) => (hunk.new_start > 0 ? hunk.new_start : hunk.old_start)

// Computes the number of lines hidden between two adjacent hunks.
export function computeGap(prevHunk: DiffHunk, nextHunk: DiffHunk): number {
  return Math.max(0, startLineNum(nextHunk) - lastLineNum(prevHunk) - 1)
}

// The three counts below are the windowed (`-U3`) path's answer to "how many
// lines is this expander hiding?" - the number the whole-content model reads
// straight off its line list (buildSegments' `hidden`) and a fragmented file has
// to work out from line numbers instead.
//
// leadingGap is free: the first hunk states the line it starts on, so everything
// before it is hidden.
export function leadingGap(hunk: DiffHunk): number {
  return Math.max(0, startLineNum(hunk) - 1)
}

// trailingGap is the one that needs help. Nothing in a windowed diff says where
// the file ENDS, so it takes the file's total_lines - which the server fills in
// from the full read it already does - and returns null when that is absent, the
// signal to render the expander as a bare chevron with no count. Null and 0 are
// therefore quite different answers: 0 means the last hunk provably reaches EOF
// and the expander should not be there at all.
export function trailingGap(hunk: DiffHunk, totalLines: number | undefined): number | null {
  if (!totalLines) return null
  return Math.max(0, totalLines - lastLineNum(hunk))
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

// atFileEnd reports whether the last hunk already reaches EOF, so there is
// nothing below it to expand into and no expander to draw. total_lines settles
// it exactly; without one it falls back to trailingContext's inference, which is
// right whenever the file has more trailing context than the last hunk shows and
// wrong (an extra chevron that expands to nothing) when it has exactly as much.
export function atFileEnd(hunk: DiffHunk, totalLines: number | undefined, currentContext: number): boolean {
  const tail = trailingGap(hunk, totalLines)
  return tail != null ? tail === 0 : trailingContext(hunk) < currentContext
}

// Default surrounding-context lines shown around each change (mirrors the git
// `-U3` the diff is first fetched with).
export const CTX = 3

// An unchanged run that would hide this few lines behind an expander isn't worth
// collapsing - a "··· 1 line ···" toggle saves no vertical space and just adds a
// click - so show those lines inline instead.
export const MIN_COLLAPSE_GAP = 1

// How much whole-file content the server may ship PER FILE in the bulk diff
// (max_full_lines). Files past it arrive at the windowed `-U3` context, so a
// diff touching a few huge files doesn't drag their entire contents along.
export const FULL_MAX_LINES = 6000

// The cap for ONE file the reader has explicitly asked to expand: the first
// click on a windowed file's expander re-fetches just that file with this cap
// (see expandFileDiff), which is also the guard on rendering a file with the
// whole-content reveal model. It is far above the bulk cap because the cost
// profile is different - one file, on request, instead of every file in the
// diff - and because the alternative is the windowed `-U<wider>` re-fetch,
// which widens every hunk in the file rather than the gap that was clicked.
// Only the collapsed view of the content is rendered either way; what this
// really bounds is the payload and the one whole-file highlight pass.
export const PROMOTED_MAX_LINES = 20000

// Changed-line cap for that same single-file request. The bulk one
// (max_full_changes) exists to keep big files out of the shared response; for a
// file the reader opened on purpose there is nothing left to protect.
export const PROMOTED_MAX_CHANGES = 1_000_000

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
export type RevealMap = Map<string, {
  top?: number
  bot?: number
  closingHidden?: number
  closingSide?: 'top' | 'bot'
  settled?: boolean
}>

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
  closing?: boolean // the fully-revealed expander is playing its exit animation
}

// Takes just the line numbers, so a caller can name a region it hasn't got the
// line for (LEAD_REGION_ID below).
export const regionKey = (l: Pick<DiffLine, 'old_line_num' | 'new_line_num'>) =>
  `${l.old_line_num ?? 'x'}:${l.new_line_num ?? 'x'}`

// The two helpers below let a WINDOWED file (one still shown as `-U3` hunks)
// name a region of the whole-content model it hasn't got yet, so a click on one
// of its expanders can be recorded now and applied the moment that file is
// promoted - see windowedExpand in DiffViewer.
//
// It works because buildSegments keys a region by its first line, and a hunk
// already shows the line the run below it starts on: `-U3` puts that line in the
// hunk as its first trailing context line.
export const LEAD_REGION_ID = regionKey({ old_line_num: 1, new_line_num: 1 })

export function regionAfterHunk(hunk: DiffHunk): string | null {
  let lastChange = -1
  for (let i = 0; i < hunk.lines.length; i++) {
    if (isChangeLine(hunk.lines[i])) lastChange = i
  }
  if (lastChange < 0) return null
  const next = hunk.lines[lastChange + 1]
  return next ? regionKey(next) : null
}

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
    const requestedTop = ov?.top ?? (isLead ? 0 : CTX)
    const requestedBot = ov?.bot ?? (isTrail ? 0 : CTX)
    // During the expander's exit, preserve the already-visible lines on the
    // opposite side instead of merging the entire run into the growing side.
    // Otherwise that small opposite segment unmounts immediately and creates a
    // second, subtler jump while the main segment is still expanding.
    const closingBot = Math.min(L, requestedBot)
    const closingTop = Math.min(L, requestedTop)
    const top = ov?.closingSide === 'top' ? L - closingBot : Math.min(L, requestedTop)
    const bot = ov?.closingSide === 'bot' ? L - closingTop : Math.min(L - top, requestedBot)
    const hidden = L - top - bot
    if (hidden <= MIN_COLLAPSE_GAP) {
      // Keep the growing side's key when a reveal consumes the final hidden
      // lines. That lets DiffViewer's context-run wrapper animate through the
      // render where the expander disappears instead of remounting the run and
      // snapping straight to its full height. Short runs that were never
      // collapsed keep their neutral key.
      const key = ov?.settled
        ? `c${run.s}`
        : ov?.bot != null && ov.top == null
        ? `cb${run.s}`
        : ov?.top != null
          ? `ct${run.s}`
          : `c${run.s}`
      // Keep the expander in the tree for one short exit animation. The line run
      // above/below it is already growing to full height, so collapsing the old
      // row at the same time makes the handoff continuous instead of replacing
      // a blue bar with clipped code in one frame.
      if (ov?.closingHidden != null) {
        if (top > 0) segs.push({ kind: 'lines', key: `ct${run.s}`, lines: fullLines.slice(run.s, run.s + top) })
        const closing = {
          kind: isLead ? 'topedge' as const : isTrail ? 'botedge' as const : 'gap' as const,
          key: `g${run.s}`,
          regionId: id,
          hidden: ov.closingHidden,
          top,
          bot,
          length: L,
          closing: true,
        }
        segs.push(closing)
        if (bot > 0) segs.push({ kind: 'lines', key: `cb${run.s}`, lines: fullLines.slice(run.e - bot, run.e) })
      } else {
        segs.push({ kind: 'lines', key, lines: fullLines.slice(run.s, run.e) })
      }
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
  const whole = !!file.expanded && all.length > 0 && all.length <= PROMOTED_MAX_LINES && isContiguous(all)

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
      const atEndOfFile = isLast && atFileEnd(hunk, file.total_lines, currentContext)
      const gap = isFirst ? 0 : computeGap(hunks[i - 1], hunk)
      // The windowed path's leading expander counts what it hides from the hunk's
      // own start line; the trailing one can only do so when the file's length
      // came with the diff, and is a bare chevron (hidden: null) otherwise.
      if (isFirst && !atTopOfFile) expanders.push({ buttons: 1, hidden: leadingGap(hunk) || null })
      if (!isFirst && gap > 0) expanders.push({ buttons: 2, hidden: gap })
      runs.push(hunk.lines)
      if (isLast && !atEndOfFile) expanders.push({ buttons: 1, hidden: trailingGap(hunk, file.total_lines) })
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
