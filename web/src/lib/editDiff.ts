// Turns an Edit tool call into diff rows for the chat's tool card.
//
// Two sources, one row shape:
//
//  1. The CLI's own `structuredPatch` (relayed as the tool_completed event's
//     `patch`), which is a real unified diff computed against the file on
//     disk - so it carries the file's REAL line numbers and a few lines of
//     surrounding context the agent never put in old_string.
//  2. Failing that (the call is still running, an older CLI, a provider that
//     sends no patch), a line diff of old_string against new_string. Lines
//     present in both are context; the rest are -/+. No line numbers, because
//     nothing here says where in the file the fragment sits.
//
// Intra-line highlighting is the diff viewer's (lib/wordDiff), so an Edit card
// and the diff tab mark changed characters the same way.
import { computeWordDiff, pairLines, type WordRange } from './wordDiff'

// One hunk of the CLI's structuredPatch: 1-based start lines plus the unified
// ` `/`-`/`+`-prefixed lines. Field names are the provider's, kept verbatim.
export interface EditHunk {
  oldStart: number
  newStart: number
  lines: string[]
}

// 'gap' is the "..." separator between two hunks (a replace_all edit that hit
// several places in the file), and carries no content of its own.
export type EditRowType = 'context' | 'del' | 'add' | 'gap'

export interface EditRow {
  type: EditRowType
  content: string
  // File line numbers, or null when unknown (a string diff) or not applicable
  // (the old side of an addition).
  oldNum: number | null
  newNum: number | null
  // Changed character ranges within this row, when it pairs with a row on the
  // other side (see wordDiff).
  ranges?: WordRange[]
}

// parseEditPatch validates a wire `patch` value into hunks, returning null for
// anything that isn't the expected shape - the caller then falls back to
// diffing the strings, which is always possible.
export function parseEditPatch(value: unknown): EditHunk[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const out: EditHunk[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null
    const h = raw as { oldStart?: unknown; newStart?: unknown; lines?: unknown }
    if (typeof h.oldStart !== 'number' || typeof h.newStart !== 'number') return null
    if (!Array.isArray(h.lines) || h.lines.some((l) => typeof l !== 'string')) return null
    out.push({ oldStart: h.oldStart, newStart: h.newStart, lines: h.lines as string[] })
  }
  return out
}

// An empty string is zero lines, not one blank line - an Edit that only adds
// text has an empty old_string and must not render a phantom deleted row.
function splitLines(s: string): string[] {
  return s === '' ? [] : s.split('\n')
}

function rowsFromHunks(hunks: EditHunk[]): EditRow[] {
  const rows: EditRow[] = []
  for (const hunk of hunks) {
    if (rows.length) rows.push({ type: 'gap', content: '', oldNum: null, newNum: null })
    let oldNum = hunk.oldStart
    let newNum = hunk.newStart
    for (const line of hunk.lines) {
      const marker = line.charAt(0)
      const content = line.slice(1)
      // "\ No newline at end of file" is a note about the previous line, not a
      // line of the file.
      if (marker === '\\') continue
      if (marker === '-') rows.push({ type: 'del', content, oldNum: oldNum++, newNum: null })
      else if (marker === '+') rows.push({ type: 'add', content, oldNum: null, newNum: newNum++ })
      else rows.push({ type: 'context', content, oldNum: oldNum++, newNum: newNum++ })
    }
  }
  return rows
}

// MAX_LCS_CELLS bounds the line-alignment grid. Beyond it the edit is big
// enough that a whole-block "all removed, then all added" reads fine anyway,
// and the word-diff pass still pairs the lines up visually.
const MAX_LCS_CELLS = 250_000

// lcsRows diffs two line arrays into context/del/add rows. Common leading and
// trailing lines are peeled off first: they are the bulk of a typical Edit
// (the agent quotes surrounding lines to anchor the match), and shrinking the
// grid by them is what keeps the LCS affordable on a large edit.
function lcsRows(oldLines: string[], newLines: string[]): EditRow[] {
  const rows: EditRow[] = []
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++
  let tail = 0
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail++
  for (let i = 0; i < head; i++) rows.push({ type: 'context', content: oldLines[i], oldNum: null, newNum: null })

  const a = oldLines.slice(head, oldLines.length - tail)
  const b = newLines.slice(head, newLines.length - tail)
  const m = a.length
  const n = b.length
  if (m === 0 || n === 0 || m * n > MAX_LCS_CELLS) {
    for (const line of a) rows.push({ type: 'del', content: line, oldNum: null, newNum: null })
    for (const line of b) rows.push({ type: 'add', content: line, oldNum: null, newNum: null })
  } else {
    // dp[i][j] = length of the longest common subsequence of a[i:] and b[j:].
    const w = n + 1
    const dp = new Int32Array((m + 1) * w)
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i * w + j] = a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (a[i] === b[j]) {
        rows.push({ type: 'context', content: a[i], oldNum: null, newNum: null })
        i++
        j++
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        // Deletions before additions, so a replaced block reads as one run of
        // "-" lines followed by its run of "+" lines (what pairLines expects).
        rows.push({ type: 'del', content: a[i++], oldNum: null, newNum: null })
      } else {
        rows.push({ type: 'add', content: b[j++], oldNum: null, newNum: null })
      }
    }
    while (i < m) rows.push({ type: 'del', content: a[i++], oldNum: null, newNum: null })
    while (j < n) rows.push({ type: 'add', content: b[j++], oldNum: null, newNum: null })
  }

  for (let k = newLines.length - tail; k < newLines.length; k++) {
    rows.push({ type: 'context', content: newLines[k], oldNum: null, newNum: null })
  }
  return rows
}

// annotateWordRanges fills in each changed row's intra-line ranges, pairing
// runs of deletions with the additions that replaced them exactly as the diff
// viewer does.
function annotateWordRanges(rows: EditRow[]): EditRow[] {
  let i = 0
  while (i < rows.length) {
    if (rows[i].type !== 'del') {
      i++
      continue
    }
    const dels: EditRow[] = []
    const adds: EditRow[] = []
    while (i < rows.length && rows[i].type === 'del') dels.push(rows[i++])
    while (i < rows.length && rows[i].type === 'add') adds.push(rows[i++])
    for (const [di, ai] of pairLines(dels.map((d) => d.content), adds.map((a) => a.content))) {
      const { old: oldR, new: newR } = computeWordDiff(dels[di].content, adds[ai].content)
      if (oldR.length) dels[di].ranges = oldR
      if (newR.length) adds[ai].ranges = newR
    }
  }
  return rows
}

// buildEditRows renders an Edit as diff rows - from the CLI's patch when it
// arrived with the result, else from the two strings alone.
export function buildEditRows(oldStr: string, newStr: string, hunks?: EditHunk[] | null): EditRow[] {
  const rows = hunks && hunks.length
    ? rowsFromHunks(hunks)
    : lcsRows(splitLines(oldStr), splitLines(newStr))
  return annotateWordRanges(rows)
}

// hasLineNumbers reports whether any row is numbered, i.e. whether the rows
// came from a real patch. The card hides its gutter columns when they aren't.
export function hasLineNumbers(rows: EditRow[]): boolean {
  return rows.some((r) => r.oldNum != null || r.newNum != null)
}

// numberRows fills in 1..N line numbers for a WHOLE-file diff - two complete
// files compared against each other, where a row's position IS its line number
// on the side it belongs to.
//
// buildEditRows leaves them null because its usual caller diffs an Edit's
// fragment, and numbering a fragment 1..N would claim it starts at the top of
// the file. That doesn't apply when both entire files are in hand: the lightbox
// compares a changed text artifact's before and after, so the numbers are real
// and are what let you say where the change is.
export function numberRows(rows: EditRow[]): EditRow[] {
  let oldNum = 1
  let newNum = 1
  return rows.map((row) => {
    if (row.type === 'gap') return row
    const numbered = {
      ...row,
      oldNum: row.type === 'add' ? null : oldNum,
      newNum: row.type === 'del' ? null : newNum,
    }
    if (row.type !== 'add') oldNum++
    if (row.type !== 'del') newNum++
    return numbered
  })
}
