// Recognise terminal output that is JSON rather than prose.
//
// A command may print one pretty-printed value, or several compact values one
// per line (two curl calls chained together is the common case). Do not hunt
// for brace-shaped fragments inside logs: every nonblank line has to be a
// complete object/array unless the whole output parses as one value.

function structured(value: unknown): boolean {
  return value !== null && typeof value === 'object'
}

function parsesStructured(text: string): boolean {
  try {
    return structured(JSON.parse(text))
  } catch {
    return false
  }
}

export function isJsonOutput(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (parsesStructured(trimmed)) return true
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  return lines.length > 1 && lines.every((line) => parsesStructured(line))
}
