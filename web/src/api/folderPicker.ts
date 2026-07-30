// Native OS folder picker.
//
// The daemon runs on the same machine as the browser (localhost-only UI), so it
// can pop a real OS folder dialog on the user's screen and return the chosen
// absolute path. These are documented in api/openapi.yaml (tag: manual) but
// hand-served, so they are fetched directly rather than through the generated
// client - the POST blocks for as long as the dialog is open. Both are
// localhost-gated server-side; availability is false for remote clients or
// systems with no dialog tool.

import type { FolderPickerOpenResponse } from './models/FolderPickerOpenResponse'

// The generated shape, not a hand-copied one: these routes are described in the
// spec, so the payload type comes from there and a spec change is a type error
// here. The REQUESTS stay hand-written - the generated client throws ApiError on
// a non-2xx, and both of these want their own handling (availability fails closed
// so the button hides; open surfaces the server's own text in a toast).
export type FolderPickResult = FolderPickerOpenResponse

/** Whether the UI should show a native "Browse..." button. */
export async function folderPickerAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/api/folder-picker/available')
    if (!res.ok) return false
    const body = (await res.json()) as { available?: boolean }
    return body.available === true
  } catch {
    return false
  }
}

/**
 * Opens the native folder dialog and resolves once the user picks or cancels.
 * The request blocks for the whole time the dialog is on screen.
 */
export async function openFolderPicker(): Promise<FolderPickResult> {
  const res = await fetch('/api/folder-picker/open', { method: 'POST' })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text.trim() || `folder picker failed (${res.status})`)
  }
  return (await res.json()) as FolderPickResult
}
