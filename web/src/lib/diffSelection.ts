// Selecting a line of a diff, and what a selected line IS.
//
// The rule the whole module exists to hold: a row is ONE thing with two numbers
// on it. Selecting it used to light only the number you happened to click, so
// the same row read differently depending on which gutter your pointer was over,
// and a context line - which carries both - had two addresses for one line of
// code. Now either gutter selects the row, both numbers light, the whole row
// lights, and there is one link.
//
// It lives here rather than in DiffViewer.tsx because the repository browser's
// compare-diff needs the identical rule, and DiffViewer may only export
// components (react-refresh/only-export-components).

export type DiffSide = 'old' | 'new'
export type DiffLineSelection = { side: DiffSide; start: number; end: number }

export function selectionHas(sel: DiffLineSelection | null | undefined, side: DiffSide, num: number | null | undefined): boolean {
  return !!sel && num != null && sel.side === side && num >= sel.start && num <= sel.end
}

// rowSelected: is this row in the selection, by either of its numbers?
export function rowSelected(sel: DiffLineSelection | null | undefined, oldNum: number | null | undefined, newNum: number | null | undefined): boolean {
  return selectionHas(sel, 'old', oldNum) || selectionHas(sel, 'new', newNum)
}

// rowAddress is a row's canonical side and number: the NEW number when it has one
// (an addition or a context line), the old one otherwise (a deletion). The same
// rule a comment on that row already follows, so a line link and a comment on the
// same line agree about which line they mean.
export function rowAddress(oldNum: number | null | undefined, newNum: number | null | undefined): { side: DiffSide; line: number } | null {
  if (newNum != null) return { side: 'new', line: newNum }
  if (oldNum != null) return { side: 'old', line: oldNum }
  return null
}

// selectRow computes the next selection from a click on a row, given both of the
// row's numbers and the shift-anchor.
//
// Shift+click extends along the ANCHOR's side, taking whichever of the clicked
// row's numbers is on that side - which is what makes a drag work across the two
// gutters, and across the two columns of the side-by-side view. A row with no
// number on the anchor's side (shift-clicking a pure deletion while anchored on
// the new side) cannot extend the range, so it starts a fresh selection there
// rather than silently doing nothing.
//
// Returns null when the row has no number at all (the empty half of a
// side-by-side pair), and a non-null `anchor` only when the caller should move
// the shift-anchor - an extend leaves it where it was.
export function selectRow(
  prev: DiffLineSelection | null,
  anchor: { side: DiffSide; line: number } | null,
  oldNum: number | null | undefined,
  newNum: number | null | undefined,
  extend: boolean,
): { sel: DiffLineSelection; anchor: { side: DiffSide; line: number } | null } | null {
  if (extend && prev) {
    const n = prev.side === 'new' ? newNum : oldNum
    if (n != null) {
      const from = anchor?.side === prev.side ? anchor.line : prev.start
      return { sel: { side: prev.side, start: Math.min(from, n), end: Math.max(from, n) }, anchor: null }
    }
  }
  const addr = rowAddress(oldNum, newNum)
  if (!addr) return null
  return { sel: { side: addr.side, start: addr.line, end: addr.line }, anchor: addr }
}

// ── The address of a line, for the URL ────────────────────────────────────────
// The agent diff has no per-file route, so a line's address has to name the file
// as well: `<path>:<L|R><start>[-<end>]`, carried in `?line=`. L/R is the same
// side spelling the repository browser's hash uses, and it stays in the address
// even though the two gutters no longer produce different links - a deletion and
// an addition can share a number, and the reader needs to land on the right one.
//
// The path is taken up to the LAST colon, so a path containing one still parses.

export function formatLineParam(path: string, sel: DiffLineSelection): string {
  const s = sel.side === 'new' ? 'R' : 'L'
  return `${path}:${s}${sel.start}${sel.end !== sel.start ? `-${sel.end}` : ''}`
}

export function parseLineParam(value: string | null | undefined): { path: string; sel: DiffLineSelection } | null {
  if (!value) return null
  const cut = value.lastIndexOf(':')
  if (cut <= 0) return null
  const path = value.slice(0, cut)
  const m = /^([LR])(\d+)(?:-(\d+))?$/.exec(value.slice(cut + 1))
  if (!m) return null
  const start = Number(m[2])
  const end = m[3] ? Number(m[3]) : start
  if (!start) return null
  return { path, sel: { side: m[1] === 'R' ? 'new' : 'old', start: Math.min(start, end), end: Math.max(start, end) } }
}
