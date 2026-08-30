// A regular head browses the isolated branch it owns. A focused head is
// deliberately branchless and works in the registered project checkout, so its
// links follow that checkout's HEAD instead of inventing a hydra/<id> ref that
// Git cannot resolve.
export function chatRepositoryRef(branchName: string | null | undefined): string {
  return branchName ?? 'HEAD'
}
