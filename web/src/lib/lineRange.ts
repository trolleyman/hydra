// Line-range selection shared by the repository file view and the diff viewer:
// a URL hash like #L5 (one line) or #L5-L10 (a range), GitHub-style. start is
// always <= end.

export type LineRange = { start: number; end: number }

// parseLineRange reads a range out of a URL fragment: "#L5", "L5", "#L5-L10",
// "L5-L10" (a bare "#L5-10" second number is tolerated too). Returns null when
// there's no line ref. The result is normalized so start <= end.
export function parseLineRange(hash: string): LineRange | null {
  const m = /^#?L(\d+)(?:-L?(\d+))?/.exec(hash || '')
  if (!m) return null
  const a = parseInt(m[1], 10)
  const b = m[2] ? parseInt(m[2], 10) : a
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

// formatLineHash renders a range back to a hash fragment body (no leading '#'):
// "L5" for a single line, "L5-L10" for a range.
export function formatLineHash(start: number, end: number): string {
  return start === end ? `L${start}` : `L${Math.min(start, end)}-L${Math.max(start, end)}`
}

// inRange reports whether a 1-based line falls within a (possibly null) range.
export function inRange(line: number, range: LineRange | null | undefined): boolean {
  return !!range && line >= range.start && line <= range.end
}

// ── Diff line ranges (side-aware) ─────────────────────────────────────────────
// A diff line reference also carries a side: the old/base (left) column or the
// new/head (right) column. GitHub-style, the left side is prefixed 'L' and the
// right side 'R' (e.g. #L5, #R5, #R5-R10). 'old' == left == 'L', 'new' == right
// == 'R'. Used by the repository compare-diff, whose single-file view is
// URL-addressable; the plain #L<n> file-view range above has no side.

export type DiffLineSide = 'old' | 'new'
export type DiffLineRange = { side: DiffLineSide; start: number; end: number }

// parseDiffLineRange reads a side-aware diff range out of a URL fragment: "#L5"
// (old side, line 5), "#R5-R10" (new side, 5..10), tolerating a bare second
// number ("#R5-10"). The side is fixed by the first prefix; a differing second
// prefix is ignored. Returns null when there's no diff line ref. Normalized so
// start <= end.
export function parseDiffLineRange(hash: string): DiffLineRange | null {
  const m = /^#?([LR])(\d+)(?:-[LR]?(\d+))?/.exec(hash || '')
  if (!m) return null
  const side: DiffLineSide = m[1] === 'L' ? 'old' : 'new'
  const a = parseInt(m[2], 10)
  const b = m[3] ? parseInt(m[3], 10) : a
  return { side, start: Math.min(a, b), end: Math.max(a, b) }
}

// formatDiffLineHash renders a side-aware diff range back to a hash fragment
// body (no leading '#'): "L5"/"R5" for one line, "L5-L10"/"R5-R10" for a range.
export function formatDiffLineHash(side: DiffLineSide, start: number, end: number): string {
  const p = side === 'old' ? 'L' : 'R'
  const lo = Math.min(start, end)
  const hi = Math.max(start, end)
  return lo === hi ? `${p}${lo}` : `${p}${lo}-${p}${hi}`
}
