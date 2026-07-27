// The repository browser packs a git ref and a file path together into one
// catch-all URL splat under /repository/ (the part after
// /project/<id>/repository/). Both a branch name and a file path can contain
// '/', so joining them with a bare '/' is ambiguous: `hydra/foo/bar.go` could be
// the branch `hydra` browsing file `foo/bar.go`, or the branch `hydra/foo`
// browsing file `bar.go`. We separate the two halves with an explicit '/-/'
// sentinel (the same separator GitLab uses in its blob/tree URLs) so the split
// is exact and self-describing - no branch list needed to disambiguate.
//
// Only the FIRST '/-/' separates ref from path, so a literal '/-/' inside the
// file path survives; a git ref cannot legally contain a bare '-' path component
// framed by slashes, so a branch name never collides with the sentinel.

import type { RepositoryBranch } from '../api'

export const REPO_SPLAT_SEP = '/-/'

// buildRepoSplat joins a ref and (optional) file path into a URL splat. A
// single-segment ref at its root needs nothing (`main`); a slashed ref at its
// root still gets a trailing sentinel (`hydra/foo/-/`) so the boundary stays
// unambiguous; any ref with a path gets `ref/-/path`.
export function buildRepoSplat(ref: string, path?: string | null): string {
  if (path) return `${ref}${REPO_SPLAT_SEP}${path}`
  return ref.includes('/') ? `${ref}${REPO_SPLAT_SEP}` : ref
}

// parseRepoSplat is the inverse of buildRepoSplat. It splits on the '/-/'
// sentinel; `branches` is consulted only to parse LEGACY sentinel-free splats
// (old bookmarks / persisted last-view paths written before the sentinel
// existed) via the former longest-matching-branch-name-prefix heuristic.
export function parseRepoSplat(
  splat: string,
  branches: RepositoryBranch[] | null,
): { ref: string | null; path: string | null } {
  const s = splat || ''
  if (!s) return { ref: null, path: null }
  const idx = s.indexOf(REPO_SPLAT_SEP)
  if (idx >= 0) {
    const ref = s.slice(0, idx)
    const path = s.slice(idx + REPO_SPLAT_SEP.length)
    return { ref: ref || null, path: path || null }
  }
  // Legacy sentinel-free form: recover the ref as the longest known-branch-name
  // prefix, else assume the first segment is the ref (a commit SHA or a
  // single-segment branch not in the list).
  const segs = s.split('/').filter(Boolean)
  if (segs.length === 0) return { ref: null, path: null }
  const names = (branches ?? []).map((b) => b.name)
  for (let i = segs.length; i >= 1; i--) {
    const cand = segs.slice(0, i).join('/')
    if (names.includes(cand)) return { ref: cand, path: segs.slice(i).join('/') || null }
  }
  return { ref: segs[0], path: segs.slice(1).join('/') || null }
}

// splatNeedsBranchList reports whether a splat can only be parsed with the
// branch list loaded - true only for the legacy sentinel-free multi-segment
// form. Sentinel splats (and single-segment ones) parse without it.
export function splatNeedsBranchList(splat: string): boolean {
  return !!splat && !splat.includes(REPO_SPLAT_SEP) && splat.includes('/')
}
