type ErrorRecord = Record<string, unknown>

function asRecord(value: unknown): ErrorRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ErrorRecord) : null
}

function parsedJSON(value: string): unknown | undefined {
  const text = value.trim()
  if (!(text.startsWith('{') || text.startsWith('['))) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// providerErrorText unwraps the nested error envelopes emitted by Codex
// app-server and other providers. In particular, app-server can put a JSON
// error response inside error.message; showing only the outer object either
// produced [object Object] or lost the useful API error completely.
export function providerErrorText(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = parsedJSON(value)
    return parsed === undefined ? value.trim() : providerErrorText(parsed)
  }
  if (Array.isArray(value)) {
    return value.map(providerErrorText).filter(Boolean).join('\n')
  }

  const outer = asRecord(value)
  if (!outer) return value == null ? '' : String(value)

  const nested = asRecord(outer.error)
  const detail = nested ?? outer
  const rawMessage = detail.message ?? (nested ? outer.message : undefined)
  const message = providerErrorText(rawMessage)
  const type = typeof detail.type === 'string' && detail.type !== 'error' ? detail.type : ''
  const status = typeof outer.status === 'number' || typeof outer.status === 'string'
    ? String(outer.status)
    : typeof detail.status === 'number' || typeof detail.status === 'string'
      ? String(detail.status)
      : ''

  if (message) {
    const context = [type, status ? `HTTP ${status}` : ''].filter(Boolean).join(', ')
    return context ? `${context}: ${message}` : message
  }

  const fallback = Object.fromEntries(
    Object.entries(outer).filter(([, entry]) => entry != null && entry !== ''),
  )
  return Object.keys(fallback).length ? JSON.stringify(fallback, null, 2) : ''
}
