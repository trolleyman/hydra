// Native OS folder picker.
//
// The daemon runs on the same machine as the browser (localhost-only UI), so it
// can pop a real OS folder dialog on the user's screen and return the chosen
// absolute path — which the generated JSON client can't model (the POST blocks
// for as long as the dialog is open). These hit the raw /folder-picker routes
// directly, same as uploads. Both are localhost-gated server-side; availability
// is false for remote clients or systems with no dialog tool.

export interface FolderPickResult {
  /** Absolute path the user chose, or undefined if they cancelled. */
  path?: string
  /** True when the user dismissed the dialog without choosing. */
  cancelled?: boolean
}

/** Whether the UI should show a native "Browse…" button. */
export async function folderPickerAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/folder-picker/available')
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
  const res = await fetch('/folder-picker/open', { method: 'POST' })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text.trim() || `folder picker failed (${res.status})`)
  }
  return (await res.json()) as FolderPickResult
}
