import type { DiffFile } from '../api/models/DiffFile'
import type { DiffHunk } from '../api/models/DiffHunk'

// Fast content signatures for diff files, used to tell whether a file's rendered
// content changed between refreshes. A full_context diff carries each file's
// ENTIRE content inline (up to thousands of lines/file), and a background
// refresh hands back an all-new file array even when nothing changed. The old
// approach - JSON.stringify(file) - allocated a multi-MB string per file on the
// main thread on every refresh (and every git command an agent runs triggers
// one), which is a prime cause of the periodic 1-2s hangs.
//
// These hashers fold the same bytes into two 32-bit integers (cyrb53) with no
// intermediate string and near-zero GC - an order of magnitude cheaper. They
// are a change DETECTOR, not a checksum: a collision would show a stale file,
// but at 53 effective bits that is astronomically unlikely for our inputs, and
// the fields we mix cover everything that affects rendering. String fields are
// length-prefixed so "ab"+"c" cannot collide with "a"+"bc".

class Hasher {
  private h1 = 0xdeadbeef
  private h2 = 0x41c6ce57

  num(n: number): void {
    // Coerce to a 32-bit int; NaN/undefined fold to a stable sentinel.
    const v = Number.isFinite(n) ? n | 0 : 0x7fffffff
    this.h1 = Math.imul(this.h1 ^ v, 2654435761)
    this.h2 = Math.imul(this.h2 ^ v, 1597334677)
  }

  str(s: string): void {
    // Length-prefix so concatenation-ambiguous inputs can't collide.
    this.num(s.length)
    let h1 = this.h1
    let h2 = this.h2
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i)
      h1 = Math.imul(h1 ^ ch, 2654435761)
      h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    this.h1 = h1
    this.h2 = h2
  }

  digest(): string {
    let h1 = this.h1
    let h2 = this.h2
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    // 53-bit result as a compact base-36 string.
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
  }
}

function foldHunks(h: Hasher, hunks: DiffHunk[] | undefined): void {
  h.num(hunks ? hunks.length : 0)
  if (!hunks) return
  for (const hunk of hunks) {
    h.str(hunk.header)
    h.num(hunk.old_start)
    h.num(hunk.new_start)
    h.num(hunk.lines.length)
    for (const l of hunk.lines) {
      // The type enum's first char is unique (context/addition/deletion/
      // no_newline), so a single code point discriminates it without hashing
      // the whole word per line.
      h.num(l.type.charCodeAt(0))
      h.str(l.content)
      h.num(l.old_line_num ?? -1)
      h.num(l.new_line_num ?? -1)
    }
  }
}

// Signature of a whole diff file - everything that affects how it renders.
export function hashDiffFile(f: DiffFile): string {
  const h = new Hasher()
  h.str(f.path)
  h.str(f.old_path ?? '')
  h.str(f.change_type)
  h.num(f.additions)
  h.num(f.deletions)
  h.num(f.binary ? 1 : 0)
  h.num(f.expanded ? 1 : 0)
  foldHunks(h, f.hunks)
  return h.digest()
}

// Signature of just a file's hunks (the visible/rendered content).
export function hashHunks(hunks: DiffHunk[] | undefined): string {
  const h = new Hasher()
  foldHunks(h, hunks)
  return h.digest()
}
