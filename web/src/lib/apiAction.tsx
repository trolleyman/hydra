import { ApiError } from '../api'
import { apiErrorBody, formatError } from '../api/format_error'
import { useToastStore } from '../stores/toastStore'
import { pillText } from './branchPills'

// Discriminated result so callers can branch on success even when the action
// resolves to `undefined`/`void` (e.g. a fire-and-forget POST) - a bare
// `T | undefined` return couldn't tell "succeeded with no value" from "failed".
export type ToastResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

export interface RunWithToastOptions {
  // Shown as a success toast when the action resolves (omit for none).
  success?: string
  // Prefixes the error toast: `${errorPrefix}: ${formatError(err)}` (omit to
  // show the bare formatted message).
  errorPrefix?: string
}

// Heuristic: does this error detail read as raw code/data (a JSON error body, a
// stack trace, a long technical dump) rather than a short human sentence? A
// code-like detail is shown verbatim in a monospace code block in the toast
// instead of being run into the headline sentence.
function looksLikeCode(detail: string): boolean {
  return detail.includes('{') || detail.includes('\n') || detail.length > 120
}

// Break an ApiError's HTTP status and response body out for a richer error
// toast: a short status pill for the headline ("501 Not Implemented") and the
// raw body as its own code block - pretty-printed and tagged 'json' when it is
// (or parses as) a JSON object, otherwise shown verbatim and untagged. A
// non-ApiError, or an empty body, yields no code.
interface ErrorCodeParts {
  status?: string
  code?: string
  lang?: string
}
function apiErrorCodeParts(error: unknown): ErrorCodeParts {
  if (!(error instanceof ApiError)) return {}
  const status = error.status
    ? `${error.status}${error.statusText ? ` ${error.statusText}` : ''}`
    : undefined
  const body: unknown = error.body
  if (body != null && typeof body === 'object') {
    return { status, code: JSON.stringify(body, null, 2), lang: 'json' }
  }
  if (typeof body === 'string' && body.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(body)
      if (parsed != null && typeof parsed === 'object') {
        return { status, code: JSON.stringify(parsed, null, 2), lang: 'json' }
      }
    } catch {
      // Body isn't JSON - fall through and show it verbatim.
    }
    return { status, code: body }
  }
  return { status }
}

// Run an async API action, surfacing failures as an error toast via formatError.
// Centralizes the try/catch→toast shape so call sites stop hand-rolling it
// The caller keeps ownership of its busy flag and success path:
//
//   const res = await runWithToast(() => api.default.updateAgent(...), { errorPrefix: 'Failed to rename agent' })
//   if (res.ok) updateAgentInStore(res.value)
//
// Handlers that surface errors through a dialog rather than a toast (kill,
// merge, update-from-base) intentionally keep their own try/catch.
export async function runWithToast<T>(
  action: () => Promise<T>,
  opts: RunWithToastOptions = {},
): Promise<ToastResult<T>> {
  try {
    const value = await action()
    if (opts.success) useToastStore.getState().show({ message: opts.success, type: 'success' })
    return { ok: true, value }
  } catch (error) {
    const detail = formatError(error)
    // A human-readable `details` (the API's own error sentence) always wins and
    // stays inline as prose - the raw body is only worth a code block when the
    // failure gave us nothing friendlier to say.
    const humanDetail = apiErrorBody(error)?.details?.trim()
    const { status, code, lang } = apiErrorCodeParts(error)
    if (opts.errorPrefix && code && !humanDetail) {
      // Structured HTTP body: show it as a (JSON) code block and pin the status
      // into the headline - "Failed to switch mode `501 Not Implemented`". The
      // status pill is its own visual chip, so it carries no brackets.
      // The status text is the server's, so it goes through pillText too - the
      // backticks around it are ours and still make the chip.
      const message = status ? pillText`${opts.errorPrefix} \`${status}\`` : opts.errorPrefix
      useToastStore.getState().show({ message, code, codeLang: lang, type: 'error' })
    } else if (opts.errorPrefix && !humanDetail && looksLikeCode(detail)) {
      // No structured body, but the raw detail reads as code (e.g. a stack trace).
      useToastStore.getState().show({ message: opts.errorPrefix, code: detail, type: 'error' })
    } else {
      // pillText, not a plain string: `detail` is the server's own error text
      // and a backtick in it would otherwise open a branch pill mid-sentence.
      // The prefix is ours, so its backticks still render as pills.
      const message = opts.errorPrefix ? pillText`${opts.errorPrefix}: ${detail}` : pillText`${detail}`
      useToastStore.getState().show({ message, type: 'error' })
    }
    return { ok: false, error }
  }
}
