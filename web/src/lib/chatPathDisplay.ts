// trimWorktreePaths rewrites absolute paths under the head's worktree to
// worktree-relative ones for display. Review agents run in a separate detached
// checkout, so that checkout is also treated as a display root. Raw tool JSON
// never goes through this helper.
export function trimWorktreePaths(text: string, worktree: string | null): string {
  let out = text
  if (worktree) {
    const prefix = worktree.endsWith('/') ? worktree : worktree + '/'
    out = out.split(prefix).join('').split(worktree).join('.')
  }

  return out.replace(
    /\/(?:home|Users)\/[^/\s"']+\/[^\s"']*?\.hydra\/local\/review-checkouts\/[^/\s"']+(\/)?/g,
    (_root, trailingSlash: string | undefined) => (trailingSlash ? '' : '.'),
  )
}

// Claude writes oversized tool output to a transcript-side spill file and may
// then Read it back. Its project slug and UUID are implementation detail; keep
// enough of the path to explain what the reviewer opened.
export function toolResultName(path: string): string | null {
  const m = /(?:^|\/)tool-results\/([^/]+)$/i.exec(path)
  return m ? m[1] : null
}
