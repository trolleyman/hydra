import { ReviewImageAnchor } from '../api'

// Where a pin on a picture points, derived from the picture itself.
//
// An artifact blob is addressed by (script, key, file) - see blobURL in
// internal/http/artifacts.go - and that triple is exactly what a review comment's
// image anchor has to record: `script` and `file` say WHICH picture, and `key`
// ("commit/<sha>" or "worktree/<content-hash>") says which version of the tree it
// was rendered from, which is the question that decides whether an observation
// still stands.
//
// It is read back out of the URL the <img> is actually loading rather than
// threaded down beside it as separate props. That is not a shortcut: the two
// cannot then disagree. A parallel field could go stale against the bytes on
// screen - a pin recorded against the side you were NOT looking at is a comment
// pointing at the wrong picture, and nothing downstream could detect it.

/** The identity of one artifact blob: which script produced it, which version of
 *  the tree it was rendered from, and which file within that entry. */
export interface ArtifactRef {
  script: string
  key: string
  file: string
}

// The triple lives in the PATH, laid out to mirror the entry on disk
// (out/<script>/<kind>/<id>/), so both of these are pure path work:
//
//   /api/projects/{project}/artifacts/{script}/{kind}/{id}/files/{file...}
//
// `files/` is what separates the contents from the sibling `log` route, and the
// file may itself contain slashes - hence the greedy tail rather than one
// segment.
const ARTIFACT_BLOB_PATH_RE = /^\/api\/projects\/[^/]+\/artifacts\/([^/]+)\/(commit|worktree)\/([^/]+)\/files\/(.+)$/

/** Parses an artifact blob URL back into the triple that addresses it. Returns
 *  null for anything that is not one (an upload, a data: URL, an agent file) -
 *  those have no artifact identity, so they cannot carry a pin. */
export function artifactRefFromUrl(url: string | null | undefined): ArtifactRef | null {
  if (!url) return null
  // Relative URLs are the norm here, so parse against the document's origin; the
  // base is discarded, only the path matters.
  let path: string
  try {
    path = new URL(url, window.location.origin).pathname
  } catch {
    return null
  }
  const m = ARTIFACT_BLOB_PATH_RE.exec(path)
  if (!m) return null
  // Each segment is escaped on the way out, so decode on the way back in. The
  // file's separators are structural and must survive, so it is decoded
  // per-segment rather than in one go - otherwise an encoded %2F inside a
  // filename would come back as a path separator.
  try {
    return {
      script: decodeURIComponent(m[1]),
      key: `${m[2]}/${decodeURIComponent(m[3])}`,
      file: m[4].split('/').map(decodeURIComponent).join('/'),
    }
  } catch {
    return null // malformed percent-encoding
  }
}

/** The blob URL that serves the picture an anchor points at - the inverse of
 *  artifactRefFromUrl, and the reason a card can show the spot from the LIVE
 *  file: the cache entry a comment references is pinned against pruning
 *  server-side, so this keeps resolving for as long as the comment exists. */
export function artifactBlobUrl(projectId: string | null, a: ReviewImageAnchor): string | null {
  if (!projectId || !a.script || !a.key || !a.file) return null
  // The key is "<kind>/<id>" and contributes two segments; anything else could
  // never resolve, so emit nothing rather than a half-formed URL.
  const slash = a.key.indexOf('/')
  if (slash <= 0 || slash === a.key.length - 1) return null
  const kind = a.key.slice(0, slash)
  const id = a.key.slice(slash + 1)
  // The file goes last so the URL ends in the real filename - which is what a
  // browser's "Save image as..." offers. Escaped per segment, keeping the
  // separators, since an artifact's contents can nest.
  const file = a.file.replace(/^\//, '').split('/').map(encodeURIComponent).join('/')
  return `/api/projects/${encodeURIComponent(projectId)}/artifacts/`
    + `${encodeURIComponent(a.script)}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/files/${file}`
}

/** Which half of a comparison a URL is, given the pair. Null when the picture is
 *  single-sided (a repository-view artifact), where "left" and "right" mean
 *  nothing and claiming one would be a fiction. */
export function sideOfUrl(url: string, left?: string | null, right?: string | null): ReviewImageAnchor.side | undefined {
  if (right && url === right) return ReviewImageAnchor.side.RIGHT
  if (left && url === left) return ReviewImageAnchor.side.LEFT
  return undefined
}

/** Builds the anchor to store for a pin placed at `x`,`y` (fractions of the
 *  picture) on the blob at `url`.
 *
 *  `natural` is the picture's own pixel size when known. It is what lets the
 *  fractions be turned back into the pixels an agent is told about, so it is
 *  passed through when available and simply omitted when it is not - a guessed
 *  size would produce confidently wrong coordinates. */
export function buildImageAnchor(opts: {
  url: string
  x: number
  y: number
  w?: number
  h?: number
  natural?: { w: number; h: number } | null
  side?: ReviewImageAnchor.side
  /** For a recording, the moment the pin was placed at, in seconds. */
  t?: number
}): ReviewImageAnchor | null {
  const ref = artifactRefFromUrl(opts.url)
  if (!ref) return null
  const anchor: ReviewImageAnchor = {
    script: ref.script,
    key: ref.key,
    file: ref.file,
    x: clamp01(opts.x),
    y: clamp01(opts.y),
  }
  if (opts.side) anchor.side = opts.side
  if (opts.w && opts.h) {
    anchor.w = clamp01(opts.w)
    anchor.h = clamp01(opts.h)
  }
  if (opts.natural && opts.natural.w > 0 && opts.natural.h > 0) {
    anchor.natural_w = opts.natural.w
    anchor.natural_h = opts.natural.h
  }
  if (opts.t && opts.t > 0) anchor.t = opts.t
  return anchor
}

/** Whether two anchors point at the same picture - the same file of the same
 *  script at the same version. Used to pick out the pins that belong on the
 *  picture currently open, so a comment left on the "before" side does not
 *  appear over the "after" one. */
export function sameArtifactPicture(a: ReviewImageAnchor | undefined, ref: ArtifactRef | null, side?: ReviewImageAnchor.side): boolean {
  if (!a || !ref) return false
  if (a.script !== ref.script || a.key !== ref.key || a.file !== ref.file) return false
  // A pin recorded before sides were distinguished has no side; show it rather
  // than hide it, since the alternative is a comment nobody can find again.
  if (a.side && side && a.side !== side) return false
  return true
}

/** The pin's position in the picture's own pixels, for display. Null when the
 *  natural size was never recorded, in which case there is no honest pixel
 *  answer and the percentage is what should be shown. */
export function anchorPixels(a: ReviewImageAnchor): { x: number; y: number; w: number; h: number } | null {
  if (!a.natural_w || !a.natural_h) return null
  return {
    x: Math.round(a.x * a.natural_w),
    y: Math.round(a.y * a.natural_h),
    w: Math.round((a.w ?? 0) * a.natural_w),
    h: Math.round((a.h ?? 0) * a.natural_h),
  }
}

/** How the pin's position reads in a caption: pixels when they are known,
 *  percentages when they are not. */
export function anchorPositionLabel(a: ReviewImageAnchor): string {
  const px = anchorPixels(a)
  const where = !px
    ? (a.w && a.h ? `${pct(a.x)},${pct(a.y)} · ${pct(a.w)} × ${pct(a.h)}` : `${pct(a.x)},${pct(a.y)}`)
    : (px.w && px.h ? `${px.x},${px.y} · ${px.w} × ${px.h} px` : `${px.x},${px.y} px`)
  // A moment in a recording is part of the position, not a separate fact:
  // "34%,71%" of a clip means nothing without the frame it is 34%,71% of.
  return a.t ? `${where} @ ${formatTimecode(a.t)}` : where
}

/** The pin's spot alone, for sitting inline after a filename the way a line
 *  number does. The full form (size, version) belongs where there is room for it
 *  - here it would crowd out the name it is qualifying. */
export function anchorPointLabel(a: ReviewImageAnchor): string {
  const px = anchorPixels(a)
  const where = px ? `${px.x},${px.y}` : `${pct(a.x)},${pct(a.y)}`
  // For a recording the MOMENT is the part worth the space: two clips' worth of
  // frames share the same coordinates, and only the timecode separates them.
  return a.t ? `${where} @ ${formatTimecode(a.t)}` : where
}

/** A moment in a clip, as m:ss.t - the same form the agent is given. Deliberately
 *  not h:mm:ss: these are UI recordings of a few seconds, and padding every one
 *  with an hour field costs more than the rare long clip saves. Mirrors
 *  reviewstore.FormatTimecode in Go. */
export function formatTimecode(sec: number): string {
  // Round to tenths FIRST, then split. Splitting first and rounding the seconds
  // afterwards lets the rounding carry past 60 without the minute ever seeing it,
  // so 59.96s renders as "0:60.0" instead of "1:00.0".
  const tenths = Math.round(Math.max(0, sec) * 10)
  const s = Math.floor((tenths % 600) / 10)
  return `${Math.floor(tenths / 600)}:${String(s).padStart(2, '0')}.${tenths % 10}`
}

/** Which version of the tree the picture was rendered from, in words that say
 *  what may be done with it. A working-tree render is never given a sha - it
 *  never had one - because a reader who goes looking for that commit finds code
 *  that was not what they were looking at. Mirrors ImageAnchor.Version in Go. */
export function anchorVersionLabel(a: ReviewImageAnchor): string {
  const key = a.key ?? ''
  const slash = key.indexOf('/')
  if (slash < 0) return key
  const kind = key.slice(0, slash)
  const id = key.slice(slash + 1, slash + 13)
  if (kind === 'commit') return id
  if (kind === 'worktree') return `uncommitted working tree (${id})`
  return key
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
