// Helpers for rendering an image diff inside the file (code) diff viewer, reusing
// the artifacts panel's ImageDiffView. An in-tree image that's added or modified
// shows the same before/after comparison control (and obeys the same image-diff
// mode setting) the artifacts panel uses, instead of the plain "Binary file
// changed" placeholder.

// Image extensions we render as an image diff. Mirrors the repository browser's
// IMAGE_EXT_RE so the file viewer and the diff viewer agree on what's an image.
// SVGs are listed too, but the diff viewer only swaps in the image differ for
// files git reports as binary - a modified SVG (text) keeps its normal text diff.
const IMAGE_DIFF_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i

export function isImagePath(p: string): boolean {
  return IMAGE_DIFF_EXT_RE.test(p)
}

// repoBlobUrl points at the raw bytes of a repo file at a git ref - the same
// endpoint the repository browser uses for image previews. Used by the
// branch-compare diff, where both sides are real refs.
export function repoBlobUrl(projectId: string, filePath: string, ref: string): string {
  return `/repository/projects/${encodeURIComponent(projectId)}/blob?path=${encodeURIComponent(filePath)}&ref=${encodeURIComponent(ref)}`
}

// agentBlobUrl points at the raw bytes of a file as seen in an agent's diff.
// Pass a ref to read a committed blob (base_ref / a head commit), or
// worktree=true to read the file straight from the agent's worktree - which is
// how the diff's uncommitted/untracked images (head_ref === "") are served.
export function agentBlobUrl(
  projectId: string,
  agentId: string,
  filePath: string,
  opts: { ref?: string; worktree?: boolean },
): string {
  const base = `/repository/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/blob?path=${encodeURIComponent(filePath)}`
  if (opts.worktree) return `${base}&worktree=true`
  return `${base}&ref=${encodeURIComponent(opts.ref ?? '')}`
}
