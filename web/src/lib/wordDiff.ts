// Word-level (intra-line) diffing for the diff viewer. Given a paired
// deletion/addition line, this finds the sub-runs of characters that actually
// changed so the viewer can highlight just those words rather than tinting the
// whole row. The character ranges are computed against the *raw* line content
// (offsets into the plain string); applyWordRanges then overlays them onto the
// already syntax-highlighted per-line HTML, so word highlighting and syntax
// colours coexist.
import type { DiffLine } from '../api'

// A [start, end) half-open character range into a line's raw content.
export type WordRange = [number, number]

// Token granularity: runs of identifiers/numbers, and every other character on
// its own. Whitespace deliberately does *not* clump into runs - a re-indent from
// four spaces to eight is then a four-space insertion, so only the added spaces
// at the end of the indent light up instead of the whole indent being repainted
// as a substitution. Every character of the input lands in exactly one token, so
// token lengths sum to the string length and char offsets stay exact.
const TOKEN_RE = /[0-9A-Za-z_]+|[^0-9A-Za-z_]/g
// Coarse fallback used only when the fine tokenization would make the LCS grid
// too big: whitespace clumps back into runs, cutting the token count on lines
// that are mostly padding.
const TOKEN_RE_COARSE = /[0-9A-Za-z_]+|\s+|[^0-9A-Za-z_\s]/g

function tokenize(s: string, coarse = false): string[] {
  return s.match(coarse ? TOKEN_RE_COARSE : TOKEN_RE) ?? []
}

// Shared prefix/suffix token counts. Those tokens are unchanged by definition
// and shrinking them out of the LCS grid often leaves nothing to solve at all
// (a one-token edit, or a pure indent insertion).
type Trim = { lo: number; aHi: number; bHi: number }

function trimCommon(a: string[], b: string[]): Trim {
  let lo = 0
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++
  let aHi = a.length
  let bHi = b.length
  while (aHi > lo && bHi > lo && a[aHi - 1] === b[bHi - 1]) { aHi--; bHi-- }
  return { lo, aHi, bHi }
}

function gridCells(t: Trim): number {
  return (t.aHi - t.lo) * (t.bHi - t.lo)
}

// Lines longer than this, or an LCS grid larger than MAX_CELLS after trimming
// the common prefix/suffix, skip word diffing - the whole-row tint still shows
// the change and we avoid a pathological O(n*m) cost on huge minified lines.
const MAX_LINE_LEN = 3000
const MAX_CELLS = 160_000

// contiguousRanges merges the per-token "changed" flags into a minimal list of
// character ranges, collapsing adjacent changed tokens into one range.
function contiguousRanges(tokens: string[], changed: boolean[]): WordRange[] {
  const ranges: WordRange[] = []
  let pos = 0
  let runStart = -1
  for (let k = 0; k < tokens.length; k++) {
    if (changed[k]) {
      if (runStart < 0) runStart = pos
    } else if (runStart >= 0) {
      ranges.push([runStart, pos])
      runStart = -1
    }
    pos += tokens[k].length
  }
  if (runStart >= 0) ranges.push([runStart, pos])
  return ranges
}

function coversWhole(ranges: WordRange[], len: number): boolean {
  return len > 0 && ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === len
}

// computeWordDiff finds the changed character ranges on each side of a
// deletion/addition pair. It trims the common leading/trailing tokens (which are
// unchanged by definition), runs an LCS over what remains, and marks every
// non-common token as changed. When both sides turn out to be entirely changed
// (no shared structure) it returns empty ranges: highlighting the whole of both
// lines is just noise on top of the row tint that already conveys the change.
export function computeWordDiff(oldStr: string, newStr: string): { old: WordRange[]; new: WordRange[] } {
  if (oldStr === newStr) return { old: [], new: [] }
  if (oldStr.length > MAX_LINE_LEN || newStr.length > MAX_LINE_LEN) return { old: [], new: [] }

  let a = tokenize(oldStr)
  let b = tokenize(newStr)
  let t = trimCommon(a, b)
  if (gridCells(t) > MAX_CELLS) {
    // Too big at character granularity - retry with whitespace clumped, and give
    // up if even that is pathological (the row tint still conveys the change).
    a = tokenize(oldStr, true)
    b = tokenize(newStr, true)
    t = trimCommon(a, b)
    if (gridCells(t) > MAX_CELLS) return { old: [], new: [] }
  }

  const oldChanged = new Array<boolean>(a.length).fill(false)
  const newChanged = new Array<boolean>(b.length).fill(false)
  const { lo, aHi, bHi } = t
  const an = aHi - lo
  const bn = bHi - lo
  if (an === 0 && bn === 0) return { old: [], new: [] }

  if (an === 0) {
    // Pure insertion in the middle: every remaining new token changed.
    for (let j = lo; j < bHi; j++) newChanged[j] = true
  } else if (bn === 0) {
    for (let i = lo; i < aHi; i++) oldChanged[i] = true
  } else {
    // LCS length table over the trimmed middles, then backtrack: a token pair
    // that matches is common (unchanged); everything else is a change on its
    // side.
    const w = bn + 1
    const dp = new Uint32Array((an + 1) * w)
    for (let i = an - 1; i >= 0; i--) {
      const ai = a[lo + i]
      for (let j = bn - 1; j >= 0; j--) {
        dp[i * w + j] = ai === b[lo + j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)])
      }
    }
    let i = 0
    let j = 0
    while (i < an && j < bn) {
      if (a[lo + i] === b[lo + j]) { i++; j++ }
      else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { oldChanged[lo + i] = true; i++ }
      else { newChanged[lo + j] = true; j++ }
    }
    while (i < an) { oldChanged[lo + i] = true; i++ }
    while (j < bn) { newChanged[lo + j] = true; j++ }
  }

  const oldRanges = contiguousRanges(a, oldChanged)
  const newRanges = contiguousRanges(b, newChanged)
  if (coversWhole(oldRanges, oldStr.length) && coversWhole(newRanges, newStr.length)) {
    return { old: [], new: [] }
  }
  return { old: oldRanges, new: newRanges }
}

// buildWordRangeMaps walks a flat run of diff lines and, for each block of
// consecutive deletions followed by consecutive additions, pairs del[j] with
// add[j] (the same index pairing buildSideBySide uses) and computes their word
// diff. Returns per-line-number range maps keyed by old_line_num (deletions) and
// new_line_num (additions), matching how the highlight maps are keyed.
export function buildWordRangeMaps(lines: DiffLine[]): { old: Map<number, WordRange[]>; new: Map<number, WordRange[]> } {
  const oldMap = new Map<number, WordRange[]>()
  const newMap = new Map<number, WordRange[]>()
  let i = 0
  while (i < lines.length) {
    if (lines[i].type === 'deletion') {
      const dels: DiffLine[] = []
      const adds: DiffLine[] = []
      while (i < lines.length && lines[i].type === 'deletion') dels.push(lines[i++])
      while (i < lines.length && lines[i].type === 'addition') adds.push(lines[i++])
      const pairs = Math.min(dels.length, adds.length)
      for (let j = 0; j < pairs; j++) {
        const d = dels[j]
        const a = adds[j]
        const { old: oldR, new: newR } = computeWordDiff(d.content, a.content)
        if (oldR.length && d.old_line_num != null) oldMap.set(d.old_line_num, oldR)
        if (newR.length && a.new_line_num != null) newMap.set(a.new_line_num, newR)
      }
    } else {
      i++
    }
  }
  return { old: oldMap, new: newMap }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// applyWordRanges overlays <span class="..."> wrappers around the given
// character ranges of already syntax-highlighted line HTML. It walks the HTML
// counting plain-text characters (an entity like &amp; counts as one), so the
// ranges - which index the raw content - line up. The highlight span is kept
// strictly innermost and is never allowed to straddle an hljs <span>/</span>
// boundary: it is closed before every tag and (re)opened lazily just before the
// next highlighted character, so the markup stays well nested with no stray
// empty spans.
export function applyWordRanges(html: string, ranges: WordRange[], className: string): string {
  if (ranges.length === 0) return html
  const opens = new Set<number>()
  const closes = new Set<number>()
  for (const [s, e] of ranges) {
    if (e > s) { opens.add(s); closes.add(e) }
  }

  const openTag = `<span class="${className}">`
  let out = ''
  let pos = 0
  let i = 0
  let inRange = false
  let spanOpen = false

  const closeSpan = () => { if (spanOpen) { out += '</span>'; spanOpen = false } }
  // Called at each plain-char position: update whether pos sits inside a changed
  // range, then open or close the highlight span to match.
  const syncSpan = (p: number) => {
    if (closes.has(p)) inRange = false
    if (opens.has(p)) inRange = true
    if (inRange && !spanOpen) { out += openTag; spanOpen = true }
    else if (!inRange && spanOpen) { closeSpan() }
  }

  while (i < html.length) {
    const c = html[i]
    if (c === '<') {
      const end = html.indexOf('>', i)
      const tag = end === -1 ? html.slice(i) : html.slice(i, end + 1)
      // Never span a tag: close the highlight, emit the tag, reopen lazily.
      closeSpan()
      out += tag
      i = end === -1 ? html.length : end + 1
      continue
    }
    if (c === '&') {
      const semi = html.indexOf(';', i)
      syncSpan(pos)
      out += semi === -1 ? c : html.slice(i, semi + 1)
      pos += 1
      i = semi === -1 ? i + 1 : semi + 1
      continue
    }
    syncSpan(pos)
    out += c
    pos += 1
    i++
  }
  // Close out a range that ends exactly at end-of-line.
  syncSpan(pos)
  closeSpan()
  return out
}

// renderWordDiffHtml produces the final line HTML with word highlighting
// applied, working from the syntax-highlighted HTML when present and falling
// back to escaped raw content otherwise.
export function renderWordDiffHtml(
  highlighted: string | undefined,
  content: string,
  ranges: WordRange[],
  className: string,
): string {
  return applyWordRanges(highlighted ?? escapeHtml(content), ranges, className)
}
