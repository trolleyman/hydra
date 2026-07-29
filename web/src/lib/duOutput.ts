// Colour what `du` prints: a size, then the thing that is that big.
//
//   du -sh ~/.cache/* | sort -rh | head -8
//   18G     /home/callum/.cache/go
//   2.5G    /home/callum/.cache/Google
//
// An agent runs this to find out what is eating a disk, and the answer is a
// two-column table arriving as one flat grey block - where the column that
// carries the whole point (which of these is big) reads exactly like the column
// that does not. So the size is marked and the path keeps the panel's colour,
// which is the same split lib/gitOutput draws in a diffstat.
//
// Like that module there is no grammar to point at: `du`'s line is a fixed
// shape, and this is only ever given output lib/shellSections already
// recognised as a `du`, which is what makes a shape this loose safe to key on.
import type { OutputSpan } from './outputSpan'

const SIZE = 'text-amber-600 dark:text-amber-400'
const DIM = 'text-stone-400 dark:text-stone-500'

// A `du` line: a size, whitespace (a tab, or the spaces `du` pads with), then
// the path it measured. The size is a count of blocks (`4096`), or the
// human-readable form `-h`/`-H`/`--si` print - a number, optionally fractional,
// with a unit suffix (`2.5G`, `658M`, `1.0KiB`). A comma decimal separator is
// what a non-English locale prints.
const DU_LINE = /^(\s*)(\d+(?:[.,]\d+)?[KMGTPEZY]?(?:i?B)?)(\s+)(.+)$/

// duOutputSpans colours a whole `du` listing, one span list per line. A line
// that fits no shape - a `du: cannot read directory ...` on stderr, a banner -
// comes back exactly as it arrived.
export function duOutputSpans(lines: string[]): OutputSpan[][] {
  return lines.map((line) => {
    const m = DU_LINE.exec(line)
    if (!m) return [{ text: line, cls: '' }]
    const [, indent, size, gap, path] = m
    return [
      { text: indent, cls: '' },
      { text: size, cls: SIZE },
      { text: gap, cls: '' },
      // The total a `-c` adds up is a label, not a path: it names no file, and
      // it is the one row you already know the meaning of.
      { text: path, cls: path === 'total' ? DIM : '' },
    ].filter((s) => s.text !== '')
  })
}
