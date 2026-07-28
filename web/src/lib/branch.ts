import { copyWithToast } from './copyToast'

// copyBranchName writes a branch name to the clipboard and confirms with the
// shared copy toast (title "Copied branch name", the branch itself in the code
// block below it). Used by the "B" shortcut and the BranchTag copy action.
// Resolves to whether the copy landed, so the BranchTag button can flash a
// tick or an X to match (the "B" shortcut ignores it and relies on the toast).
export function copyBranchName(branch: string): Promise<boolean> {
  if (!branch) return Promise.resolve(false)
  return copyWithToast(branch, { what: 'branch name' })
}
