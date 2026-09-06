// Fits a display path (already "~"-abbreviated by the server, see
// ProjectInfo.display_path) into limited horizontal space by progressively
// dropping detail. `fits` is injected so the caller decides what "fits" means:
// the UI measures rendered text width (canvas measureText); tests use a plain
// character budget, which makes every stage easy to audit.
//
// Stages, in order - the first candidate that fits wins:
//   1. The path as-is:                     ~/code/hydra/deep/dir
//   2. Middle elision: replace the leading components (after the "~/" or "/"
//      anchor) with a single ".." marker, dropping one more component each
//      step but always keeping the tail:   ~/../hydra/deep/dir
//                                          ~/../deep/dir
//                                          ~/../dir
//   3. Drop the anchor too:                ../dir
//   4. Clip the start, longest first:      .../dir  ...dir  ...ir  ...r
//
// The final fallback ("..." or the last candidate) is returned even if it does
// not fit - the caller's container clips/ellipsises whatever remains.
export function fitPath(displayPath: string, fits: (candidate: string) => boolean): string {
  const path = displayPath.replace(/\/+$/, '') || displayPath // drop a trailing slash ("/" survives)
  if (fits(path)) return path

  // Split off the anchor ("~/" or "/"); everything else is components.
  const anchor = path.startsWith('~/') ? '~/' : path.startsWith('/') ? '/' : ''
  const components = path.slice(anchor.length).split('/').filter(Boolean)

  // Nothing to elide (bare "~", "/", or a single-component path): go straight
  // to start-clipping.
  let last = path
  if (components.length > 1) {
    // Stage 2: keep the anchor, replace 1..n-1 leading components with "..".
    for (let drop = 1; drop < components.length; drop++) {
      last = `${anchor}../${components.slice(drop).join('/')}`
      if (fits(last)) return last
    }
    // Stage 3: drop the anchor as well.
    last = `../${components[components.length - 1]}`
    if (fits(last)) return last
  }

  // Stage 4: clip the start of whatever is left, preserving the filename suffix.
  // This is the last-resort shape for a very narrow diff header; showing the end
  // still distinguishes `.ts` from `.go`, while `name...` throws that away.
  for (let start = 1; start < last.length; start++) {
    const candidate = `...${last.slice(start)}`
    if (fits(candidate)) return candidate
  }
  return '...'
}
