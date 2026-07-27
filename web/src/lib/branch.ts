import { useToastStore } from '../stores/toastStore'
import { copyText } from './clipboard'

// copyBranchName writes a branch name to the clipboard and confirms with a
// toast, GitLab-style. Used by the "B" shortcut and the BranchTag copy action.
// Goes through copyText so it also works on insecure LAN origins, where
// navigator.clipboard is undefined and the old ?.writeText silently no-opped.
export function copyBranchName(branch: string) {
  if (!branch) return
  void copyText(branch).then((ok) =>
    useToastStore.getState().show(
      ok
        ? { message: `Copied branch name "${branch}"`, type: 'success', duration: 2000 }
        : { message: 'Failed to copy branch name', type: 'error' },
    ),
  )
}
