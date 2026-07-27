// Moved-block detection over an already-parsed diff, a client-side reimagining
// of `git diff --color-moved=zebra --color-moved-ws=allow-indentation-change`.
// A line removed in one place and added (identically) in another is not really a
// deletion + addition - it moved - and painting both halves red/green hides that.
// This finds those blocks so the viewer can tint them a distinct zebra colour and
// link each half to its counterpart. It runs across *all* files in the response
// (a block moved between files is the interesting case, and toggling it never
// needs a refetch).
//
// The algorithm mirrors git/diff.c: intern each changed line by content (leading
// whitespace stripped when indentation changes are allowed), then greedily grow
// the longest block of consecutive additions whose contents match a run of
// consecutive deletions, keeping only blocks with enough substance
// (COLOR_MOVED_MIN_ALNUM_COUNT) so a lone moved `}` isn't flagged.
import type { DiffFile } from '../api'

export interface MoveInfo {
  parity: 0 | 1        // zebra shade - alternates between adjacent moved blocks
  partnerPath: string  // file the counterpart half lives in
  partnerLine: number  // counterpart line number (new-side for a deletion's partner)
}

export interface FileMoves {
  del: Map<number, MoveInfo> // keyed by old_line_num
  add: Map<number, MoveInfo> // keyed by new_line_num
}

export type MoveMap = Map<string, FileMoves>

export interface MoveOptions {
  // Ignore leading-whitespace differences when matching, then require a *constant*
  // indent delta across the block - so a function extracted into a new `if` (every
  // line one level deeper) still reads as a single move. On by default.
  allowIndentChange?: boolean
}

// git's COLOR_MOVED_MIN_ALNUM_COUNT: a block must carry at least this many
// alphanumeric characters to count, filtering out noise like a moved brace.
const MIN_ALNUM = 20
// Don't attempt detection on pathologically large diffs - the greedy growth is
// cheap but not worth it, and such a diff is machine-generated churn anyway.
const MAX_CHANGED_LINES = 20_000

interface Ref {
  path: string
  line: number
  key: string | null // null = blank/whitespace-only, never a match anchor
  indent: number     // tab-expanded visual width of the leading whitespace
  alnum: number      // count of [0-9A-Za-z] in the content
}

function visualIndent(content: string): number {
  let w = 0
  for (const ch of content) {
    if (ch === '\t') w += 8 - (w % 8)
    else if (ch === ' ') w += 1
    else break
  }
  return w
}

function countAlnum(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) n++
  }
  return n
}

function makeRef(path: string, line: number, content: string, allowIndent: boolean): Ref {
  const norm = allowIndent ? content.replace(/^\s+/, '') : content
  const key = norm.trim() === '' ? null : norm
  return { path, line, key, indent: visualIndent(content), alnum: countAlnum(content) }
}

// contiguous[i] is true when refs[i] directly follows refs[i-1] in its file (same
// path, adjacent line number) - i.e. no context line or file boundary between
// them, so a moved block may span the two.
function contiguity(refs: Ref[]): boolean[] {
  const out = new Array<boolean>(refs.length).fill(false)
  for (let i = 1; i < refs.length; i++) {
    out[i] = refs[i].path === refs[i - 1].path && refs[i].line === refs[i - 1].line + 1
  }
  return out
}

export function detectMoves(files: DiffFile[], opts: MoveOptions = {}): MoveMap {
  const allowIndent = opts.allowIndentChange ?? true
  const adds: Ref[] = []
  const dels: Ref[] = []
  for (const f of files) {
    for (const h of f.hunks ?? []) {
      for (const l of h.lines) {
        if (l.type === 'addition' && l.new_line_num != null) adds.push(makeRef(f.path, l.new_line_num, l.content, allowIndent))
        else if (l.type === 'deletion' && l.old_line_num != null) dels.push(makeRef(f.path, l.old_line_num, l.content, allowIndent))
      }
    }
  }
  const map: MoveMap = new Map()
  if (adds.length + dels.length > MAX_CHANGED_LINES || adds.length === 0 || dels.length === 0) return map

  // Deletion start-indices grouped by content, in order, for candidate lookup.
  const delsByKey = new Map<string, number[]>()
  dels.forEach((d, i) => {
    if (d.key == null) return
    const arr = delsByKey.get(d.key)
    if (arr) arr.push(i)
    else delsByKey.set(d.key, [i])
  })

  const addContig = contiguity(adds)
  const delContig = contiguity(dels)
  const addTaken = new Array<boolean>(adds.length).fill(false)
  const delTaken = new Array<boolean>(dels.length).fill(false)

  // Grow the longest matching block starting at (ai, di); returns its length and
  // the constant indent delta, honouring contiguity and the indent constraint.
  const grow = (ai: number, di: number): number => {
    let k = 0
    let wsd = 0
    while (ai + k < adds.length && di + k < dels.length) {
      const a = adds[ai + k]
      const d = dels[di + k]
      if (addTaken[ai + k] || delTaken[di + k]) break
      if (a.key == null || d.key == null || a.key !== d.key) break
      if (allowIndent) {
        const delta = a.indent - d.indent
        if (k === 0) wsd = delta
        else if (delta !== wsd) break
      }
      if (k > 0 && (!addContig[ai + k] || !delContig[di + k])) break
      k++
    }
    return k
  }

  let group = 0
  for (let ai = 0; ai < adds.length; ai++) {
    if (addTaken[ai] || adds[ai].key == null) continue
    const cands = delsByKey.get(adds[ai].key!) ?? []
    let bestDi = -1
    let bestLen = 0
    for (const di of cands) {
      if (delTaken[di]) continue
      const len = grow(ai, di)
      if (len > bestLen) { bestLen = len; bestDi = di }
    }
    if (bestDi < 0) continue

    let alnum = 0
    for (let k = 0; k < bestLen; k++) alnum += adds[ai + k].alnum
    if (alnum < MIN_ALNUM) continue

    const parity = (group % 2) as 0 | 1
    group++
    for (let k = 0; k < bestLen; k++) {
      const a = adds[ai + k]
      const d = dels[bestDi + k]
      addTaken[ai + k] = true
      delTaken[bestDi + k] = true
      fileMoves(map, a.path).add.set(a.line, { parity, partnerPath: d.path, partnerLine: d.line })
      fileMoves(map, d.path).del.set(d.line, { parity, partnerPath: a.path, partnerLine: a.line })
    }
  }
  return map
}

function fileMoves(map: MoveMap, path: string): FileMoves {
  let fm = map.get(path)
  if (!fm) { fm = { del: new Map(), add: new Map() }; map.set(path, fm) }
  return fm
}

export const EMPTY_FILE_MOVES: FileMoves = { del: new Map(), add: new Map() }
