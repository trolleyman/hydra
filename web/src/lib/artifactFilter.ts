// Tag/type/change filtering and free-text search for artifact files, shared by the
// diff viewer's ArtifactsPanel (before/after sets) and the repository browser's
// RepositoryArtifactsView (single-ref output). Both render a tag filter bar and the
// same masonry of media, so this is the one place the filtering/search rules live.
//
// A file's tags come from a sibling JSON sidecar (<file>.meta) the artifact script
// writes; the backend normalizes them (see internal/artifacts). A "category::value"
// tag is a GitLab-style scoped label - at most one value per category on a given
// file. Every value's checkbox is ON by default (show all); the filter records only
// what the user turns OFF, hiding files that carry a hidden value. A plain tag (no
// "::") is free-form and works the same way.

import { ARTIFACT_CHANGE_CATEGORY as CHANGE_CATEGORY, clampChangeThreshold, type ArtifactTagFilter } from './artifactPrefs'

// Extensions routed to the video viewer instead of the image one.
export function isVideoArtifact(name: string): boolean {
  return /\.webm$/i.test(name)
}

// A PDF, which the artifact pipeline collects (it is in the backend's mediaExts)
// but which is not a picture: an <img> renders nothing for it. It gets a compact
// tile that opens the browser's PDF viewer in the lightbox - see LightboxPdf.
export function isPdfArtifact(name: string): boolean {
  return /\.pdf$/i.test(name)
}

// Files with no inline preview at all: the download-class packages above plus
// PDFs, which are shown as a card in the grid and only rendered full-size in the
// lightbox. These share a tile, are excluded from dimension probing, and lay out
// at a fixed flat aspect rather than one measured off media they don't have.
export function isFileTileArtifact(name: string): boolean {
  return isDownloadArtifact(name) || isPdfArtifact(name)
}

// Extensions rendered as download tiles (name + size + save link) instead of
// media - packages and archives an artifact script may emit (e.g. an Android
// build's .apk). Mirrors the backend's downloadExts allowlist
// (internal/artifacts), which serves these with Content-Disposition: attachment.
export function isDownloadArtifact(name: string): boolean {
  return /\.(apk|aab|ipa|zip|jar|tar|gz|tgz|whl|deb)$/i.test(name)
}

// The minimal shape the filter/search needs from a file: its name (for the built-in
// type filter and search), its tags, and - for before/after sets - its change_type
// (plus change_ratio, how much of it differs, for the "% changed" threshold). Both
// ArtifactFile and RepositoryArtifactFile satisfy this structurally; the latter has
// no change_type/change_ratio (a single ref has no diff), so they're optional here.
export type FilterableArtifact = {
  name: string
  tags?: string[] | null
  change_type?: string | null
  change_ratio?: number | null
}

// effectiveChangeType applies the change-type filter's "% changed" threshold: a file
// the backend reported 'modified' counts as 'unchanged' when the fraction of it that
// differs (change_ratio: pixels for images, frames for video) is below the
// threshold. So a 1px tweak no longer "counts" as a change once the user raises the
// gate. Every other change type - and modified files with no change_ratio (e.g.
// byte-compared video), or files with no change_type at all (single-ref output) -
// passes through unchanged. With threshold 0 (the default) this is a no-op. Used
// everywhere a file's change state drives the UI so the threshold is applied
// consistently (filtering, counts, the row badge).
export function effectiveChangeType(file: FilterableArtifact, thresholdPct: number): string {
  const ct = (file.change_type ?? '') as string
  if (ct !== 'modified' || thresholdPct <= 0) return ct
  const ratio = file.change_ratio
  if (ratio == null) return ct
  return ratio * 100 < thresholdPct ? 'unchanged' : ct
}

// parseScopedTag splits "category::value" into its parts, or returns null for a
// free-form tag. Mirrors the backend's split (first "::", non-empty halves).
export function parseScopedTag(tag: string): { cat: string; val: string } | null {
  const i = tag.indexOf('::')
  if (i <= 0) return null
  const cat = tag.slice(0, i)
  const val = tag.slice(i + 2)
  if (!cat || !val) return null
  return { cat, val }
}

// The built-in "type" filter scope. Unlike the user-defined tag scopes (which come
// from each file's .meta sidecar), this one is intrinsic - derived from the file's
// extension - so it's offered whenever any media is present. The name is reserved: a
// user `type::...` tag is ignored so it can't collide with the built-in.
export const TYPE_CATEGORY = 'type'
// The order the built-in "changes" filter offers change_type values in (CHANGE_CATEGORY
// lives in lib/artifactPrefs, which also seeds 'unchanged' hidden by default).
export const CHANGE_TYPE_ORDER = ['added', 'removed', 'modified', 'unchanged']

// fileMediaType classifies a file for the built-in type filter, matching how the
// viewers route it (isVideoArtifact → the video viewer, isPdfArtifact → the PDF
// viewer, isDownloadArtifact → a download tile). A value only ever appears in the
// filter bar when some file carries it, so 'pdf' is invisible in the common case.
export function fileMediaType(file: FilterableArtifact): string {
  if (isVideoArtifact(file.name)) return 'video'
  if (isPdfArtifact(file.name)) return 'pdf'
  if (isDownloadArtifact(file.name)) return 'download'
  return 'image'
}

export type CollectedTags = {
  scoped: { cat: string; values: string[] }[]
  free: string[]
}

// collectTags gathers every tag across the given files into the scoped categories
// (with their distinct values) and free-form tags that the filter bar offers. The
// optional `pending` list folds in tags a side that settled early exposes while the
// other side is still generating (the diff panel's pending_tags) - so the filter
// appears as soon as we know what tags there are likely to be.
export function collectTags(files: FilterableArtifact[], pending?: string[]): CollectedTags {
  const scoped = new Map<string, Set<string>>()
  const free = new Set<string>()
  const add = (t: string) => {
    const p = parseScopedTag(t)
    if (p) {
      if (p.cat === TYPE_CATEGORY || p.cat === CHANGE_CATEGORY) return // reserved for the built-in filters
      if (!scoped.has(p.cat)) scoped.set(p.cat, new Set())
      scoped.get(p.cat)!.add(p.val)
    } else {
      free.add(t)
    }
  }
  for (const t of pending ?? []) add(t)
  for (const f of files) {
    for (const t of f.tags ?? []) add(t)
  }
  return {
    scoped: [...scoped.entries()]
      .map(([cat, vals]) => ({ cat, values: [...vals].sort() }))
      .sort((a, b) => a.cat.localeCompare(b.cat)),
    free: [...free].sort(),
  }
}

// filterIsActive reports whether the filter would hide anything - i.e. any scoped
// category or the free-form group has at least one value turned off.
export function filterIsActive(filter: ArtifactTagFilter): boolean {
  // A non-zero change threshold can reclassify 'modified' files to 'unchanged'
  // (and unchanged is hidden by default), so it too can hide files.
  return Object.values(filter.scoped).some((off) => off.length > 0) || filter.free.length > 0 || clampChangeThreshold(filter.changeThreshold) > 0
}

// fileMatchesFilter reports whether a file passes the filter. Each array lists the
// values turned OFF. For a scoped category, the file is dropped if its value for
// that category is hidden - files lacking the category carry none of the hidden
// values, so they're unaffected. For free-form tags, the file is dropped only if
// every free tag it carries is hidden (a file tagged both an on and an off tag
// stays; an untagged file is never dropped on this axis).
export function fileMatchesFilter(file: FilterableArtifact, filter: ArtifactTagFilter): boolean {
  const tags = file.tags ?? []
  for (const [cat, off] of Object.entries(filter.scoped)) {
    if (off.length === 0) continue
    // The built-in "type" scope matches the file's intrinsic media type, not a tag
    // it carries; like every other scope, the file is dropped when its value for
    // that category is turned off.
    if (cat === TYPE_CATEGORY) {
      if (off.includes(fileMediaType(file))) return false
    } else if (cat === CHANGE_CATEGORY) {
      // The built-in change-type scope matches the file's change_type (added/
      // removed/modified/unchanged) - its intrinsic state, not a tag it carries -
      // after the "% changed" threshold may have downgraded a modified file to
      // unchanged (see effectiveChangeType). A file with no change_type (single-ref
      // output) carries none of the hidden values, so it's unaffected.
      if (off.includes(effectiveChangeType(file, clampChangeThreshold(filter.changeThreshold)))) return false
    } else if (off.some((v) => tags.includes(`${cat}::${v}`))) {
      return false
    }
  }
  if (filter.free.length > 0) {
    const freeTags = tags.filter((t) => !parseScopedTag(t))
    if (freeTags.length > 0 && freeTags.every((t) => filter.free.includes(t))) return false
  }
  return true
}

// fuzzyScore does a subsequence fuzzy match of `needle` within `haystack` (both
// already lowercased by the caller). It returns a positive score - higher means a
// closer match, with bonuses for characters that land at a word boundary, in a
// consecutive run, or as a whole substring - or null when `needle` isn't a
// subsequence of `haystack` at all.
function fuzzyScore(needle: string, haystack: string): number | null {
  if (!needle) return 0
  let score = 0
  let from = 0
  let prev = -2
  for (const ch of needle) {
    const idx = haystack.indexOf(ch, from)
    if (idx === -1) return null
    let pts = 1
    if (idx === prev + 1) pts += 2 // part of a consecutive run
    if (idx === 0 || /[^a-z0-9]/.test(haystack[idx - 1])) pts += 3 // start of a word
    score += pts
    prev = idx
    from = idx + 1
  }
  if (haystack.includes(needle)) score += 4 // reward a clean substring hit
  return score
}

// searchScore ranks a file against a free-text search query. The query is split on
// whitespace into words, and every word must fuzzy-match the filename or one of the
// file's tags - if any word matches nothing, the file is excluded (null). The score
// sums each word's best field match, so files that hit more or closer fields rank
// higher. An empty query scores 0 (matches everything).
function searchScore(file: FilterableArtifact, query: string): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 0
  const fields = [file.name, ...(file.tags ?? [])].map((s) => s.toLowerCase())
  let total = 0
  for (const w of words) {
    let best: number | null = null
    for (const f of fields) {
      const s = fuzzyScore(w, f)
      if (s !== null && (best === null || s > best)) best = s
    }
    if (best === null) return null
    total += best
  }
  return total
}

// searchFiles drops files that don't match the query and sorts the rest by
// descending score (ties keep input order - Array.sort is stable). An empty query
// returns the list unchanged.
export function searchFiles<T extends FilterableArtifact>(files: T[], query: string): T[] {
  if (!query.trim()) return files
  return files
    .map((f, i) => ({ f, i, score: searchScore(f, query) }))
    .filter((x): x is { f: T; i: number; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.f)
}

// computeVisibleFiles is the single source of truth for which of a set's files are
// shown, and in what order: first the tag/type/change filter hides files, then the
// search query (when present) narrows + ranks them. Used by both the card (to
// render) and the panel (to decide whether a card has any match while searching).
export function computeVisibleFiles<T extends FilterableArtifact>(files: T[], filter: ArtifactTagFilter, search: string): T[] {
  const filtered = filterIsActive(filter) ? files.filter((f) => fileMatchesFilter(f, filter)) : files
  return search.trim() ? searchFiles(filtered, search) : filtered
}

// computeScopeCounts walks the files once, tallying per value how many items carry
// it (hasValue) under the current filters with this scope itself ignored - so a
// value's own toggle never changes its own row. Shown dimmed beside each checkbox.
export function computeScopeCounts(
  files: FilterableArtifact[],
  values: string[],
  hasValue: (f: FilterableArtifact, v: string) => boolean,
  shownFilter: ArtifactTagFilter,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const v of values) out[v] = 0
  for (const f of files) {
    if (!fileMatchesFilter(f, shownFilter)) continue
    for (const v of values) if (hasValue(f, v)) out[v]++
  }
  return out
}
