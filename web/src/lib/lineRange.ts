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
