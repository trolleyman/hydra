// Colour what a tool says about files on disk: how big, how many, whose, when.
//
//   du -sh ~/.cache/* | sort -rh    18G     /home/callum/.cache/go
//   df -h                           /dev/nvme0n1p2  1.8T  1.2T  522G  70% /
//   ls -l internal/http             -rw-rw-r-- 1 callum callum  87K Jul 29 16:57 simulation_chat.go
//   stat web/dist                     Size: 4096      Blocks: 8
//
// Each of these is a table whose whole point is ONE column - which of these is
// big, how full is it, which is newest - arriving as one flat grey block where
// that column reads exactly like the mode bits and the owner beside it. So the
// measurement is marked and the name it belongs to keeps the panel's colour,
// the same split lib/gitOutput draws between a path and the `|` of a diffstat.
//
// Like that module there is no grammar to point at: each line is a fixed shape,
// and this is only ever given output lib/shellSections already recognised as
// one of these commands, which is what makes shapes this loose safe to key on.
import type { OutputSpan } from './outputSpan'

// The tools whose listings this colours. The caller says which ran - the shapes
// overlap far too much to tell apart from the text (a `du` line and an `ls -s`
// line are both "a number, then a name").
export type DiskTool = 'du' | 'df' | 'ls' | 'stat'

const SIZE = 'text-amber-600 dark:text-amber-400'
const FULL = 'text-red-600 dark:text-red-400'
const DIM = 'text-stone-400 dark:text-stone-500'

// A size: a count of blocks (`4096`), or the human-readable form `-h`/`--si`
// print - a number, optionally fractional, with a unit suffix (`2.5G`, `658M`,
// `1.0KiB`). A comma decimal separator is what a non-English locale prints.
const SIZE_RE = '\\d+(?:[.,]\\d+)?[KMGTPEZY]?(?:i?B)?'

// A `du` line: a size, whitespace (a tab, or the spaces it pads with), the path.
const DU_LINE = new RegExp(`^(\\s*)(${SIZE_RE})(\\s+)(.+)$`)

// A `df` row: device, size, used, available, use%, mount point. The columns are
// space-separated and the device may itself contain spaces on a network mount,
// so this anchors on the four measurements at the END rather than counting from
// the left.
const DF_LINE = new RegExp(`^(\\S.*?)(\\s+)(${SIZE_RE})(\\s+)(${SIZE_RE})(\\s+)(${SIZE_RE})(\\s+)(\\d+%)(\\s+)(.*)$`)
// Its header names the columns rather than measuring anything - and does it in
// whatever language the shell is in, so it is recognised by carrying no number
// rather than by a word this would have to guess at.
const DF_HEAD = /^\D*$/

// An `ls -l` row: mode, link count, owner, group, size, date, name. The date is
// `Jul 29 16:57` or `2026-07-29 16:57` depending on the locale and `--full-time`.
const LS_LINE = new RegExp(
  `^([-bcdlpsD][-rwxSsTt]{9}[.+@]?)(\\s+\\d+\\s+\\S+\\s+\\S+\\s+)(${SIZE_RE})(\\s+)(\\S+\\s+\\S+\\s+\\S+)(\\s+)(.*)$`,
)
// The `total 48` line an `ls -l` opens a directory with.
const LS_TOTAL = /^(total\s+)(\d+)$/
// The `dir:` heading `ls -R` / `ls a b` writes before each directory's listing.
const LS_HEADING = /^(\S.*):$/

// A `stat` line is a run of `Label: value` pairs.
const STAT_FIELD = /\b(File|Size|Blocks|IO Block|Device|Inode|Links|Access|Modify|Change|Birth|Uid|Gid):/g

// A use% worth worrying about. Below this it is just a number; above it, it is
// the reason someone ran `df`.
const FULL_PERCENT = 90

function duSpans(line: string): OutputSpan[] {
  const m = DU_LINE.exec(line)
  if (!m) return [{ text: line, cls: '' }]
  const [, indent, size, gap, path] = m
  return [
    { text: indent, cls: '' },
    { text: size, cls: SIZE },
    { text: gap, cls: '' },
    // The total a `-c` adds up is a label, not a path: it names no file, and it
    // is the one row you already know the meaning of.
    { text: path, cls: path === 'total' ? DIM : '' },
  ]
}

function dfSpans(line: string): OutputSpan[] {
  if (DF_HEAD.test(line)) return [{ text: line, cls: DIM }]
  const m = DF_LINE.exec(line)
  if (!m) return [{ text: line, cls: '' }]
  const [, device, g1, size, g2, used, g3, avail, g4, percent, g5, mount] = m
  const pct = Number(percent.slice(0, -1))
  return [
    // The device is furniture: `df` is read by mount point, and a `/dev/nvme...`
    // says nothing the mount point does not.
    { text: device, cls: DIM },
    { text: g1, cls: '' },
    { text: size, cls: DIM },
    { text: g2, cls: '' },
    { text: used, cls: SIZE },
    { text: g3, cls: '' },
    { text: avail, cls: SIZE },
    { text: g4, cls: '' },
    { text: percent, cls: pct >= FULL_PERCENT ? FULL : SIZE },
    { text: g5, cls: '' },
    { text: mount, cls: '' },
  ]
}

function lsSpans(line: string): OutputSpan[] {
  const total = LS_TOTAL.exec(line)
  if (total) return [{ text: total[1], cls: DIM }, { text: total[2], cls: DIM }]
  const m = LS_LINE.exec(line)
  if (m) {
    const [, mode, middle, size, g1, date, g2, name] = m
    return [
      // The mode bits, the link count and the owner are the same on nearly every
      // row of a listing; the size, the date and the name are what differ.
      { text: mode, cls: DIM },
      { text: middle, cls: DIM },
      { text: size, cls: SIZE },
      { text: g1, cls: '' },
      { text: date, cls: DIM },
      { text: g2, cls: '' },
      { text: name, cls: '' },
    ]
  }
  const heading = LS_HEADING.exec(line)
  if (heading) return [{ text: line, cls: DIM }]
  return [{ text: line, cls: '' }]
}

function statSpans(line: string): OutputSpan[] {
  const spans: OutputSpan[] = []
  let at = 0
  STAT_FIELD.lastIndex = 0
  for (const field of line.matchAll(STAT_FIELD)) {
    spans.push({ text: line.slice(at, field.index), cls: '' })
    spans.push({ text: field[0], cls: DIM })
    at = field.index + field[0].length
  }
  if (spans.length === 0) return [{ text: line, cls: '' }]
  spans.push({ text: line.slice(at), cls: '' })
  return spans
}

// diskOutputSpans colours a whole listing, one span list per line. A line that
// fits no shape - a `du: cannot read directory ...` on stderr, a banner - comes
// back exactly as it arrived.
export function diskOutputSpans(tool: DiskTool, lines: string[]): OutputSpan[][] {
  const spansFor = tool === 'du' ? duSpans : tool === 'df' ? dfSpans : tool === 'ls' ? lsSpans : statSpans
  return lines.map((line) => spansFor(line).filter((s) => s.text !== ''))
}
