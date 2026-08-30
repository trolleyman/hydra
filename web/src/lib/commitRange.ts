import type { CommitInfo } from '../api'

export type LeftSel = { type: 'base'; sha?: string } | { type: 'latest' } | { type: 'commit'; sha: string }
export type RightSel = { type: 'uncommitted' } | { type: 'latest' } | { type: 'commit'; sha: string }

export function commitIdx(sha: string, commits: CommitInfo[]): number {
  return commits.findIndex((commit) => commit.sha === sha)
}

// The commit list is newest-first, so a commit's parent is normally the next
// row. The oldest listed commit has no next row: keep its actual first-parent
// SHA on the branch-point selection instead of resolving the moving base branch
// name later. That makes an isolated oldest-commit diff immutable as main moves.
export function commitParentSelection(sha: string, commits: CommitInfo[]): LeftSel | null {
  const idx = commitIdx(sha, commits)
  if (idx === -1) return null
  if (idx + 1 < commits.length) return { type: 'commit', sha: commits[idx + 1].sha }
  return { type: 'base', sha: commits[idx].parent_sha }
}

// Keep an existing multi-commit range when its left endpoint is older than the
// newly selected right endpoint. If the new right endpoint is at or behind the
// left one, move left to its parent so the click remains valid and shows exactly
// that commit. "Latest commit" follows the same rule when left is already HEAD.
export function reconcileRightSelection(left: LeftSel, right: RightSel, commits: CommitInfo[]): { left: LeftSel; right: RightSel } {
  if (right.type === 'latest' && left.type === 'latest' && commits.length > 0) {
    return { left: commitParentSelection(commits[0].sha, commits) ?? left, right }
  }
  if (right.type !== 'commit') return { left, right }
  const rightIdx = commitIdx(right.sha, commits)
  if (rightIdx === -1 || left.type === 'base') return { left, right }
  const leftIdx = left.type === 'latest' ? -1 : commitIdx(left.sha, commits)
  if (leftIdx !== -1 && leftIdx > rightIdx) return { left, right }
  return { left: commitParentSelection(right.sha, commits) ?? left, right }
}
