// A shell command an agent runs to LOOK at a file - `sed -n 40,110p f`,
// `cat f`, `nl -ba f`, `head -50 f`, `tail -n +200 f` - is a Read by another name. Every
// agent reaches for one (Codex reads files this way exclusively), and its output
// reached the chat card as an anonymous wall of terminal text: no highlighting,
// no line numbers, no clue which file it came from without re-reading the
// command.
//
// parseView recognises that shape - which file, and which of its lines - so
// lib/shellSections can give the output back the file's own numbering and
// language. The CARD stays a Bash card: it shows the command that ran, with the
// content rendered as source underneath. (It used to rename itself "Read" and
// tuck the command away in a caption, which hid the thing that actually ran.)
//
// Deliberately strict: a pipe, a redirect, a glob, a variable, a second sed
// command, an unrecognised flag - anything that could make the output something
// other than a verbatim slice of one named file - parses to null, and that
// stretch of output stays plain terminal text. Attaching a filename and line
// numbers to text that is not that file's would be far worse than no
// highlighting at all.

// A stretch of a file, by line number. `end` is null when the command asked for
// everything from `start` on (`cat`, `sed -n '40,$p'`).
export interface ViewRange {
  start: number
  end: number | null
}

export interface FileView {
  // The file operand exactly as the command wrote it (relative, ~-prefixed, ...).
  path: string
  // 1-based line the output starts at, or null when the command cannot say
  // (a plain `tail`, which counts backwards from an unknown end).
  start: number | null
  // 1-based last line the command asked for, or null when open-ended (`cat`,
  // `sed -n '40,$p'`).
  end: number | null
  // The stretches the command printed, when there is more than one - a
  // `sed -n '10,14p;80,84p'`, which agents write to quote several places in one
  // file at once. `start`/`end` then span the LOT (first start, last end), and
  // are no longer a count of what was printed: viewLimit is.
  //
  // Absent for the ordinary single-range read, so nothing that only understands
  // `start`/`end` has to learn about this.
  ranges?: ViewRange[]
  // The output already carries its own line numbers (`cat -n`), so the renderer
  // must read them out of the text rather than count from `start`.
  numbered: boolean
  // The step as written, for a caller that wants to name what produced the
  // lines it is holding.
  command: string
  // Several adjacent reads had no recoverable boundary, but every path names
  // the same language. The renderer may colour the combined stretch from this
  // view's extension, but must not attribute its rows to this one path.
  languageOnly?: boolean
}

// parseSedRange reads the one accepted sed script: a print of a contiguous line
// range with no other command attached. `40p`, `40,110p`, `40,$p`.
//
// Exported for lib/shellSections, where the same script with no file operand is
// a filter that narrows what the command before it printed.
export function parseSedRange(expr: string): ViewRange | null {
  const m = /^(\d+)(?:,(\d+|\$))?p$/.exec(expr)
  if (!m) return null
  const start = Number(m[1])
  if (start < 1) return null
  if (m[2] === undefined) return { start, end: start }
  if (m[2] === '$') return { start, end: null }
  const end = Number(m[2])
  return end >= start ? { start, end } : null
}

// parseSedRanges reads a whole sed script of prints - `10,14p;80,84p;96,100p`,
// which is how an agent quotes several places in one file in one command.
//
// sed streams the file once and prints a line as it reaches it, so the output is
// these stretches in FILE order however they were written. That only stays
// knowable while they are disjoint and ascending: overlapping ranges print the
// line they share twice (once per `p`), and a range that opens before the one
// written above it prints its lines earlier than its position here suggests. So
// anything but strictly ascending and non-touching is refused rather than
// guessed at.
export function parseSedRanges(expr: string): ViewRange[] | null {
  const ranges: ViewRange[] = []
  for (const part of expr.split(';')) {
    const range = parseSedRange(part.trim())
    if (!range) return null
    const prev = ranges[ranges.length - 1]
    // Only the last range may run to the end of the file - one that does
    // swallows everything after it.
    if (prev && (prev.end === null || range.start <= prev.end)) return null
    ranges.push(range)
  }
  return ranges.length > 0 ? ranges : null
}

// viewLimit is how many lines a view can have printed, or null when nothing in
// the command bounds it (a `cat`, a `sed -n '40,$p'`). It is the sum over the
// ranges, which for the ordinary single-range read is `end - start + 1`.
export function viewLimit(view: Pick<FileView, 'start' | 'end' | 'ranges'>): number | null {
  const ranges = view.ranges ?? (view.start != null ? [{ start: view.start, end: view.end }] : [])
  let total = 0
  for (const r of ranges) {
    if (r.end == null) return null
    total += r.end - r.start + 1
  }
  return ranges.length > 0 ? total : null
}

// viewLineNumbers gives the file line number each line of a view's output
// carries, as strings for the gutter, or [] when they cannot be known.
//
// A single range numbers straight from its start, and keeps doing so when the
// output comes up SHORT - the file ended first, and only the tail is missing.
// Several ranges cannot: a short read there means one of the stretches ended
// early, and nothing in the output says which, so every number after it would be
// wrong. They are numbered only when the line count proves every range printed
// in full - and the alternative, when it does not, is no gutter rather than a
// gutter that lies.
export function viewLineNumbers(view: Pick<FileView, 'start' | 'end' | 'ranges'>, count: number): string[] {
  const ranges = view.ranges
  if (!ranges) {
    if (view.start == null) return []
    return Array.from({ length: count }, (_, i) => String(view.start! + i))
  }
  if (viewLimit(view) !== count) return []
  return ranges.flatMap((r) =>
    Array.from({ length: (r.end ?? r.start) - r.start + 1 }, (_, i) => String(r.start + i)))
}

// parseCount reads head/tail's line count off its flags. Returns the count and
// whether it was the `+N` form (tail counting FORWARD from line N), or null for
// any flag this does not understand - `-c` (bytes), `-f` (follow), `-q`, ...
function parseCount(flags: string[]): { count: number; fromStart: boolean } | null {
  let spec: string | null = null
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]
    if (flag === '-n' || flag === '--lines') {
      if (spec !== null || i + 1 >= flags.length) return null
      spec = flags[++i]
      continue
    }
    const inline = /^(?:-n|--lines=)(.+)$/.exec(flag) ?? /^-(\d+)$/.exec(flag)
    if (!inline || spec !== null) return null
    spec = inline[1]
  }
  if (spec === null) return { count: 10, fromStart: false }
  const m = /^(\+?)(\d+)$/.exec(spec)
  if (!m) return null
  return { count: Number(m[2]), fromStart: m[1] === '+' }
}

function isOperand(word: string): boolean {
  return word !== '' && !word.startsWith('-')
}

// parseGitBlob reads `git show <rev>:<path>`, which is the odd one out among git
// commands: it prints a FILE - the blob at that revision, byte for byte - and
// not a report about the repository. So it is a read of `<path>`, and wants that
// file's language and line numbers rather than lib/gitOutput's colours.
//
// The revision itself is dropped. It says which VERSION was printed, which the
// command line above the content already shows, and the one thing the renderer
// needs from a path - what language it is - is the same at every revision.
function parseGitBlob(words: string[]): string | null {
  // git's own options come before the subcommand; `-C` and `-c` take the word
  // after them, and none of them change what `show` prints.
  let i = 1
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '-C' || words[i] === '-c') i++
    i++
  }
  if (words[i] !== 'show') return null
  const args = words.slice(i + 1)
  // Exactly one operand, and no flags: a `--stat` or a second revision would
  // make this something other than one file's contents.
  if (args.length !== 1 || !isOperand(args[0])) return null
  const at = args[0].indexOf(':')
  const path = at < 0 ? '' : args[0].slice(at + 1)
  // `git show :file` (the index) is a blob too; `git show rev:` is not a file.
  return path === '' || path.startsWith('-') ? null : path
}

// parseView turns one step into the file view it performs, or null when the
// step is not a plain read of a single named file.
//
// Takes the step already lexed (lib/shellSections does the lexing, since it has
// to cope with pipes and commands this knows nothing about), so what counts as a
// file view lives in one place.
export function parseView(words: string[], raw: string): FileView | null {
  const base = { path: '', start: null as number | null, end: null as number | null, numbered: false, command: raw }
  const tool = words[0]
  const args = words.slice(1)

  if (tool === 'sed') {
    // Only the quiet-print form. `sed -i` edits, `sed -E s/../../` transforms -
    // neither prints the file as it stands.
    if (args[0] !== '-n') return null
    const rest = args[1] === '-e' ? args.slice(2) : args.slice(1)
    if (rest.length !== 2 || !isOperand(rest[1])) return null
    const ranges = parseSedRanges(rest[0])
    if (!ranges) return null
    const last = ranges[ranges.length - 1]
    return {
      ...base,
      path: rest[1],
      start: ranges[0].start,
      end: last.end,
      ranges: ranges.length > 1 ? ranges : undefined,
    }
  }

  if (tool === 'cat') {
    const files = args.filter(isOperand)
    const flags = args.filter((a) => !isOperand(a))
    // `-n` numbers the output itself; anything else (`-A`, `-v`, `-s`) changes
    // the bytes printed.
    if (files.length !== 1 || flags.some((f) => f !== '-n' && f !== '--number')) return null
    return { ...base, path: files[0], start: 1, end: null, numbered: flags.length > 0 }
  }

  if (tool === 'nl') {
    const files = args.filter(isOperand)
    const flags = args.filter((a) => !isOperand(a))
    // GNU/BSD nl differ in their defaults for blank lines, and flags can change
    // the separator or number format. Accept only the common spelling agents use
    // to number every line with nl's standard tab separator.
    if (files.length !== 1 || flags.length !== 1 || (flags[0] !== '-ba' && flags[0] !== '--body-numbering=a')) return null
    return { ...base, path: files[0], start: 1, end: null, numbered: true }
  }

  if (tool === 'git') {
    const path = parseGitBlob(words)
    return path === null ? null : { ...base, path, start: 1, end: null }
  }

  if (tool === 'head' || tool === 'tail') {
    const files = args.filter(isOperand)
    // A `-n 50`'s count is an operand-shaped word: drop the one that follows an
    // `-n` before deciding which words name files.
    const flags: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (isOperand(args[i])) continue
      flags.push(args[i])
      if ((args[i] === '-n' || args[i] === '--lines') && i + 1 < args.length) {
        flags.push(args[i + 1])
        files.splice(files.indexOf(args[i + 1]), 1)
        i++
      }
    }
    // Several files make head/tail interleave `==> name <==` banners, so the
    // output is no longer ONE file's text - see parseBannerView, which reads
    // that shape off the output instead.
    if (files.length !== 1) return null
    const count = parseCount(flags)
    if (!count) return null
    if (tool === 'head') {
      // `head -n +N` is just `head -n N`.
      return { ...base, path: files[0], start: 1, end: count.count }
    }
    // `tail -n +N` prints from line N onwards; a plain `tail` counts back from
    // an end this parser cannot know, so the content gets no line numbers.
    return count.fromStart
      ? { ...base, path: files[0], start: count.count, end: null }
      : { ...base, path: files[0], start: null, end: null }
  }

  return null
}

// The banner `head`/`tail` print in front of each file when they were given
// more than one. It is the only thing that says where a stretch came from, and
// it says it better than the command does: the operands may be a glob, or a
// hundred files long.
export const FILE_BANNER = /^==> (.*) <==$/

// A read of SEVERAL files, whose output is those files' contents with a banner
// between them. The paths are deliberately not returned - the banners carry
// them, including for the `head -30 web/src/*.ts` an operand list could not
// enumerate - so this answers only how each stretch is numbered.
export interface BannerView {
  // 1-based line each stretch starts at, or null when the command cannot say
  // (a plain `tail`).
  start: number | null
  // 1-based last line of each stretch, or null when open-ended.
  end: number | null
}

// parseBannerView reads a `head`/`tail` over more than one file. Null when the
// command is not one, or names only one file (that is a plain view, above).
//
// `fileCount` is how many operands the caller could see; a glob or a variable
// makes it unknowable, and since a banner is printed whenever MORE than one file
// is read, an unknowable count is taken as "possibly several" - the output's own
// banners then settle it, and an output with none is one file's text and stays
// a plain view.
export function parseBannerView(words: string[], fileCount: number | null): BannerView | null {
  const tool = words[0]
  if (tool !== 'head' && tool !== 'tail') return null
  if (fileCount !== null && fileCount < 2) return null
  const args = words.slice(1)
  const flags: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (isOperand(args[i])) continue
    flags.push(args[i])
    if ((args[i] === '-n' || args[i] === '--lines') && i + 1 < args.length) flags.push(args[++i])
  }
  const count = parseCount(flags)
  if (!count) return null
  if (tool === 'head') return { start: 1, end: count.count }
  return count.fromStart ? { start: count.count, end: null } : { start: null, end: null }
}
