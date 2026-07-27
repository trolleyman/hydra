import { useToastStore } from '../stores/toastStore'
import { copyText } from './clipboard'

// copyBranchName writes a branch name to the clipboard and confirms with a
// toast, GitLab-style. Used by the "B" shortcut and the BranchTag copy action.
// Goes through copyText so it also works on insecure LAN origins, where
// navigator.clipboard is undefined and the old ?.writeText silently no-opped.
// Resolves to whether the copy landed, so the BranchTag button can flash a
// tick or an X to match (the "B" shortcut ignores it and relies on the toast).
export function copyBranchName(branch: string): Promise<boolean> {
  if (!branch) return Promise.resolve(false)
  return copyText(branch).then((ok) => {
    useToastStore.getState().show(
      ok
        ? { message: `Copied branch name "${branch}"`, type: 'success', duration: 2000 }
        : { message: 'Failed to copy branch name', type: 'error' },
    )
    return ok
  })
}
