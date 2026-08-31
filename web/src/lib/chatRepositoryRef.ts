// A worktree Head browses the isolated branch it owns. A project-directory Head is
// deliberately branchless and works in the registered project directory, so its
// links follow that checkout's HEAD instead of inventing a hydra/<id> ref that
// Git cannot resolve.
export function chatRepositoryRef(branchName: string | null | undefined): string {
  return branchName ?? 'HEAD'
}
