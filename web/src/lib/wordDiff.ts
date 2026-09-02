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

// The LCS runs over "tokens", but the finest tokenization is a single character:
// diffing character-by-character lets a highlight land *inside* an identifier, so
// `getUserName` -> `getUserId` lights only `Name`/`Id` rather than the whole
// token. It is a strict refinement of a word diff. Whichever level is used, every
// character of the input lands in exactly one token, so token lengths sum to the
// string length and char offsets stay exact.
//
// Character granularity would make the O(n*m) grid too big on long lines, and can
// scatter matches across stray shared letters, so tokenize() takes a level and
// computeWordDiff walks a ladder from fine to coarse, dropping to the next level
// only when the grid exceeds MAX_CELLS:
//   0 - single characters (finest; sub-identifier precision)
//   1 - identifier/number runs, every other character on its own (a word diff,
//       but whitespace still per-char so a re-indent lights only the added
//       columns instead of the whole indent)
//   2 - as 1 but whitespace clumps into runs too, cutting the token count on
//       lines that are mostly padding
const TOKEN_RE_WORD = /[0-9A-Za-z_]+|[^0-9A-Za-z_]/g
const TOKEN_RE_COARSE = /[0-9A-Za-z_]+|\s+|[^0-9A-Za-z_\s]/g

function tokenize(s: string, level: number): string[] {
  // Array.from splits on code points, so a surrogate pair stays one token and a
  // range boundary can never fall inside it (offsets remain UTF-16 code units,
  // matching how applyWordRanges counts).
  if (level === 0) return Array.from(s)
  return s.match(level === 1 ? TOKEN_RE_WORD : TOKEN_RE_COARSE) ?? []
}

// Adjacent changed ranges separated by only a short run of unchanged characters
// are merged into one. A character diff of two similar identifiers otherwise
// reads as confetti - `counter` -> `pointer` matching the stray shared `o` would
// light `c`,`u` and `p`,`i` separately - so coalescing across a <=2 char gap
// restores a single `cou`/`poi` edit. Larger gaps are a real unchanged stretch
// worth showing, so they are left alone.
const COALESCE_GAP = 2

function coalesceRanges(ranges: WordRange[]): WordRange[] {
  if (ranges.length < 2) return ranges
  const out: WordRange[] = [[ranges[0][0], ranges[0][1]]]
  for (let k = 1; k < ranges.length; k++) {
    const prev = out[out.length - 1]
    const [s, e] = ranges[k]
    if (s - prev[1] <= COALESCE_GAP) prev[1] = e
    else out.push([s, e])
  }
  return out
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

function isWord(ch: string): boolean {
  return /[0-9A-Za-z_]/.test(ch)
}

// isSubwordBoundary reports whether an *internal* subword boundary sits between
// str[i-1] and str[i] - a camelCase hump (handle|Click), a snake_case underscore
// edge, an acronym/word split (HTTP|Server), or a letter<->digit change (item|1).
// It is deliberately blind to token edges (word<->punctuation, start/end of the
// identifier): those are handled by the tokenizer, and snapping to them would
// drag a highlight across a whole monocase run. So `counter`/`pointer`, which has
// no internal boundary, keeps its precise `cou`/`poi` char diff, while
// `handleClick`/`handleClose` snaps out to `Click`/`Close`.
function isSubwordBoundary(str: string, i: number): boolean {
  if (i <= 0 || i >= str.length) return false
  const p = str[i - 1]
  const c = str[i]
  if (!isWord(p) || !isWord(c)) return false
  if (p === '_' || c === '_') return true
  const pDigit = p >= '0' && p <= '9'
  const cDigit = c >= '0' && c <= '9'
  if (pDigit !== cDigit) return true
  const pUpper = p >= 'A' && p <= 'Z'
  const cUpper = c >= 'A' && c <= 'Z'
  const pLower = p >= 'a' && p <= 'z'
  if (pLower && cUpper) return true // camelCase hump
  // Acronym followed by a word: the last capital starts the next subword,
  // e.g. HTTP|Server splits before the S that precedes "erver".
  if (pUpper && cUpper && i + 1 < str.length && str[i + 1] >= 'a' && str[i + 1] <= 'z') return true
  return false
}

// snapToSubwords grows each changed range outward to the nearest internal subword
// boundary, but only while stepping over word characters and only if a boundary
// is actually reached - so a pure character diff snaps `lick`/`lose` back to the
// camelCase `Click`/`Close`, yet a monocase edit that has no boundary to snap to
// is left exactly as the char diff found it. Whitespace/punctuation ranges never
// move (their neighbours are non-word).
function snapToSubwords(ranges: WordRange[], str: string): WordRange[] {
  return ranges.map(([s, e]) => {
    let ns = s
    while (ns > 0 && isWord(str[ns - 1]) && isWord(str[ns]) && !isSubwordBoundary(str, ns)) ns--
    if (!isSubwordBoundary(str, ns)) ns = s
    let ne = e
    while (ne < str.length && isWord(str[ne - 1]) && isWord(str[ne]) && !isSubwordBoundary(str, ne)) ne++
    if (!isSubwordBoundary(str, ne)) ne = e
    return [ns, ne] as WordRange
  })
}

// scoreBoundary rates how natural a split between str[i-1] and str[i] is - higher
// is better. A line edge beats a whitespace edge beats a punctuation edge beats a
// split inside an identifier. This is diff-match-patch's diff_cleanupSemanticScore_
// idea, trimmed to what matters inside a single line.
function scoreBoundary(str: string, i: number): number {
  if (i <= 0 || i >= str.length) return 4 // start/end of line
  const before = str[i - 1]
  const after = str[i]
  if (/\s/.test(before) || /\s/.test(after)) return 3
  if (!isWord(before) || !isWord(after)) return 2 // a punctuation/identifier edge
  return 0 // mid-identifier
}

// slideRange shifts one changed range along the line to the best-scoring position
// it can reach losslessly - moving a boundary is valid exactly when the character
// leaving one end equals the one entering the other (str[s-1] === str[e-1] to
// slide left, str[e] === str[s] to slide right), which is the same condition
// diff-match-patch's cleanupSemanticLossless uses. This turns e.g. "foo(a)" ->
// "foo(|b, |a)" into "foo(|b, a|)"-free clean edges. Whitespace-only ranges are
// left alone: for a re-indent the highlight is deliberately pinned to the columns
// next to the code (see the tokenizer note), which sliding would undo.
function slideRange(str: string, s: number, e: number): WordRange {
  if (str.slice(s, e).trim() === '') return [s, e]
  let bestS = s
  let bestE = e
  let best = scoreBoundary(str, s) + scoreBoundary(str, e)
  let ls = s
  let le = e
  while (ls > 0 && str[ls - 1] === str[le - 1]) {
    ls--
    le--
    const sc = scoreBoundary(str, ls) + scoreBoundary(str, le)
    if (sc > best) { best = sc; bestS = ls; bestE = le }
  }
  let rs = s
  let re = e
  while (re < str.length && str[re] === str[rs]) {
    rs++
    re++
    const sc = scoreBoundary(str, rs) + scoreBoundary(str, re)
    if (sc > best) { best = sc; bestS = rs; bestE = re }
  }
  return [bestS, bestE]
}

function slideRanges(ranges: WordRange[], str: string): WordRange[] {
  if (ranges.length === 0) return ranges
  const out = ranges.map(([s, e]) => slideRange(str, s, e))
  out.sort((a, b) => a[0] - b[0])
  return out
}

// changedFraction is the share of a line's characters that fall inside a changed
// range. When *both* sides are mostly changed the pair is really a rewrite, and a
// character diff would just scatter highlights across whatever stray characters
// happen to line up (apple/orange -> "ppl"/"orang"), so computeWordDiff drops the
// ranges and lets the whole-row tint carry the change.
function changedFraction(ranges: WordRange[], len: number): number {
  if (len === 0) return 0
  let sum = 0
  for (const [s, e] of ranges) sum += e - s
  return sum / len
}
const REWRITE_FRACTION = 0.5

// computeWordDiff finds the changed character ranges on each side of a
// deletion/addition pair. It trims the common leading/trailing tokens (which are
// unchanged by definition), runs an LCS over what remains, and marks every
// non-common token as changed. When both sides turn out to be entirely changed
// (no shared structure) it returns empty ranges: highlighting the whole of both
// lines is just noise on top of the row tint that already conveys the change.
export function computeWordDiff(oldStr: string, newStr: string): { old: WordRange[]; new: WordRange[] } {
  if (oldStr === newStr) return { old: [], new: [] }
  if (oldStr.length > MAX_LINE_LEN || newStr.length > MAX_LINE_LEN) return { old: [], new: [] }

  // Walk the tokenization ladder from finest (per-character) to coarsest,
  // dropping a level only when the LCS grid would exceed MAX_CELLS. Character
  // granularity is the goal - it lets a highlight land inside an identifier - and
  // the coarser levels only kick in for long lines where an O(n*m) char grid is
  // too expensive.
  let a = tokenize(oldStr, 0)
  let b = tokenize(newStr, 0)
  let t = trimCommon(a, b)
  for (let level = 1; level <= 2 && gridCells(t) > MAX_CELLS; level++) {
    a = tokenize(oldStr, level)
    b = tokenize(newStr, level)
    t = trimCommon(a, b)
  }
  if (gridCells(t) > MAX_CELLS) return { old: [], new: [] }

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

  // contiguousRanges -> coalesce stray char-diff confetti -> slide each range to
  // its cleanest lossless boundary -> snap to camelCase / snake_case boundaries ->
  // coalesce again in case snapping merged neighbours.
  const refine = (changed: boolean[], tokens: string[], str: string) =>
    coalesceRanges(snapToSubwords(slideRanges(coalesceRanges(contiguousRanges(tokens, changed)), str), str))
  const oldRanges = refine(oldChanged, a, oldStr)
  const newRanges = refine(newChanged, b, newStr)
  if (
    changedFraction(oldRanges, oldStr.length) > REWRITE_FRACTION &&
    changedFraction(newRanges, newStr.length) > REWRITE_FRACTION
  ) {
    return { old: [], new: [] }
  }
  return { old: oldRanges, new: newRanges }
}

// lineSimilarity is a cheap 0..1 score of how alike two lines are, used only to
// decide which deletion pairs with which addition (not to produce the highlight
// itself). It is the multiset Jaccard of their word tokens, ignoring
// whitespace-only tokens so indentation noise doesn't inflate or deflate the
// score. O(len), so it is far cheaper than the per-pair char LCS.
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const counts = new Map<string, number>()
  let aTotal = 0
  for (const tok of tokenize(a, 1)) {
    if (!tok.trim()) continue
    counts.set(tok, (counts.get(tok) ?? 0) + 1)
    aTotal++
  }
  let bTotal = 0
  let inter = 0
  for (const tok of tokenize(b, 1)) {
    if (!tok.trim()) continue
    bTotal++
    const left = counts.get(tok) ?? 0
    if (left > 0) { counts.set(tok, left - 1); inter++ }
  }
  const union = aTotal + bTotal - inter
  return union === 0 ? 0 : inter / union
}

// Below this similarity two lines are treated as unrelated: pairing them would
// diff a removed line against an unrelated added one and highlight most of both,
// so they are left unpaired (the row tint alone). Mirrors git-delta's
// --max-line-distance.
const MIN_PAIR_SIM = 0.4
// Above this many del*add candidates the alignment DP isn't worth it (and the
// block is almost certainly machine-generated churn); fall back to index pairing.
const MAX_PAIR_CELLS = 2500

// pairLines aligns a run of deleted lines with a run of added lines by content
// similarity, preserving order, so each word diff compares the two lines a human
// reads as "the same line, edited" even when the block is unbalanced (5 removed /
// 2 added) or a line was inserted mid-block and shifts the alignment. Returns
// [deletionIndex, additionIndex] pairs; lines with no good match are omitted.
export function pairLines(dels: string[], adds: string[]): Array<[number, number]> {
  const m = dels.length
  const n = adds.length
  if (m === 0 || n === 0) return []
  if (m === 1 && n === 1) return lineSimilarity(dels[0], adds[0]) >= MIN_PAIR_SIM ? [[0, 0]] : []
  if (m * n > MAX_PAIR_CELLS) {
    const out: Array<[number, number]> = []
    for (let k = 0; k < Math.min(m, n); k++) out.push([k, k])
    return out
  }

  // sim[i*n+j] cached so the backtrack doesn't recompute. Needleman-Wunsch that
  // maximises the total similarity of chosen pairs; a gap (leaving a line
  // unpaired) scores 0, and a below-threshold pair is disallowed so it is never
  // chosen over leaving both lines unpaired.
  const sim = new Float64Array(m * n)
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) sim[i * n + j] = lineSimilarity(dels[i], adds[j])
  }
  const w = n + 1
  const dp = new Float64Array((m + 1) * w)
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const s = sim[i * n + j]
      const match = s >= MIN_PAIR_SIM ? s + dp[(i + 1) * w + (j + 1)] : -Infinity
      dp[i * w + j] = Math.max(match, dp[(i + 1) * w + j], dp[i * w + (j + 1)])
    }
  }
  const out: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    const s = sim[i * n + j]
    const match = s >= MIN_PAIR_SIM ? s + dp[(i + 1) * w + (j + 1)] : -Infinity
    if (match >= dp[(i + 1) * w + j] && match >= dp[i * w + (j + 1)]) { out.push([i, j]); i++; j++ }
    else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) i++
    else j++
  }
  return out
}

// isWhitespaceOnlyChange reports whether two lines differ only in whitespace -
// same characters once every space/tab is stripped, but not byte-identical. That
// covers a re-indent, an internal realignment, and a trailing-space edit alike.
// Not consumed today (a whole-row dim treatment was tried and removed as too
// heavy); kept for a future, subtler de-emphasis of whitespace-only rows.
export function isWhitespaceOnlyChange(a: string, b: string): boolean {
  return a !== b && a.replace(/\s+/g, '') === b.replace(/\s+/g, '')
}

// buildWordRangeMaps walks a flat run of diff lines and, for each block of
// consecutive deletions followed by consecutive additions, aligns the removed
// and added lines by similarity (see pairLines) and computes the word diff of
// each matched pair. Returns per-line-number range maps keyed by old_line_num
// (deletions) and new_line_num (additions), matching how the highlight maps are
// keyed.
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
      for (const [di, ai] of pairLines(dels.map((d) => d.content), adds.map((a) => a.content))) {
        const d = dels[di]
        const a = adds[ai]
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

// Intra-line "word diff" marks. A changed line already carries a faint whole-row
// tint (bg-*-50); these stronger spans mark the exact characters that differ so
// the eye lands on the actual edit rather than re-reading the whole line. The
// mark preserves syntax colours except for the small dark-mode comment adjustment
// in index.css. Deletions read red, additions green - the same red/green language
// as the row. Shared by the diff viewer and the chat's Edit card so an edit is
// marked up identically wherever it is read.
export const WORD_DEL_CLASS = 'diff-word-del rounded-[2px] bg-red-300/70 dark:bg-red-400/40'
export const WORD_ADD_CLASS = 'diff-word-add rounded-[2px] bg-green-300/70 dark:bg-green-400/40'

// applyWordRanges overlays <span class="..."> wrappers around the given
// character ranges of already syntax-highlighted line HTML. It walks the HTML
// counting plain-text characters (an entity like &amp; counts as one), so the
// ranges - which index the raw content - line up. The highlight span is kept
// strictly innermost and is never allowed to straddle a token <span>/</span>
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
