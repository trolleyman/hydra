import { formatError } from '../api/format_error'
import { useToastStore } from '../stores/toastStore'

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

// Run an async API action, surfacing failures as an error toast via formatError.
// Centralizes the try/catch→toast shape so call sites stop hand-rolling it
// (PLAN.md #61a). The caller keeps ownership of its busy flag and success path:
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
    const message = opts.errorPrefix ? `${opts.errorPrefix}: ${formatError(error)}` : formatError(error)
    useToastStore.getState().show({ message, type: 'error' })
    return { ok: false, error }
  }
}
