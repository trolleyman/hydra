import { useToastStore } from '../stores/toastStore'

// copyBranchName writes a branch name to the clipboard and confirms with a
// toast, GitLab-style. Used by the "B" shortcut and the BranchTag copy action.
export function copyBranchName(branch: string) {
  if (!branch) return
  navigator.clipboard
    ?.writeText(branch)
    .then(() => useToastStore.getState().show({ message: `Copied branch name "${branch}"`, type: 'success', duration: 2000 }))
    .catch(() => useToastStore.getState().show({ message: 'Failed to copy branch name', type: 'error' }))
}
