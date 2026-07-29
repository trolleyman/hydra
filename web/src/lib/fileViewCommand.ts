// A shell command an agent runs to LOOK at a file - `sed -n 40,110p f`,
// `cat f`, `head -50 f`, `tail -n +200 f` - is a Read by another name. Every
// agent reaches for one (Codex reads files this way exclusively), and the chat
// card showed the result as an anonymous wall of terminal output: no
// highlighting, no line numbers, no clue which file it came from without
// re-reading the command.
//
// parseFileViewScript recognises that shape so the card can render the same
// file/lines header and numbered, syntax-highlighted body a real Read gets, and
// splitFileViewOutput cuts one command's combined output back into the pieces
// each file view produced.
//
// Deliberately strict: a pipe, a redirect, a glob, a variable, a second sed
// command, an unrecognised flag - anything that could make the output something
// other than a verbatim slice of one named file - parses to null and the card
// stays an ordinary Bash card. Attaching a filename and line numbers to text
// that is not that file's would be far worse than no highlighting at all.

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
  // The step as written, shown as the caption above the content it produced.
  command: string
}

export type FileViewStep = { kind: 'view'; view: FileView } | { kind: 'echo'; text: string }

// A slice of a command's output plus the view that produced it.
export interface FileViewSection extends FileView {
  lines: string[]
}

// Steps beyond this are a script, not a look at some files - and the output
// split below is O(steps x lines).
const MAX_STEPS = 24

interface RawStep {
  words: string[]
  raw: string
}

// Characters that would make the command mean something other than "print this
// file": redirections and pipes, command/parameter substitution, background and
// subshells, and glob metacharacters (a glob can name more than one file, so the
// operand would no longer identify what was printed).
const SHELL_METACHARS = new Set(['|', '&', '<', '>', '(', ')', '`', '$', '*', '?', '[', ']', '{', '}'])

// lexSteps splits a script into `;` / `&&` / newline separated steps of words,
// with quotes removed (they only affect what the word IS, never what it means
// here). Returns null for anything it will not interpret - see the header.
function lexSteps(script: string): RawStep[] | null {
  const steps: RawStep[] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  let start = 0

  const endWord = () => {
    if (hasWord) {
      words.push(word)
      word = ''
      hasWord = false
    }
  }
  const endStep = (end: number) => {
    endWord()
    if (words.length > 0) steps.push({ words, raw: script.slice(start, end).trim() })
    words = []
  }

  for (let i = 0; i < script.length; i++) {
    const ch = script[i]
    if (ch === "'") {
      const close = script.indexOf("'", i + 1)
      if (close < 0) return null
      word += script.slice(i + 1, close)
      hasWord = true
      i = close
      continue
    }
    if (ch === '"') {
      const close = script.indexOf('"', i + 1)
      if (close < 0) return null
      const body = script.slice(i + 1, close)
      // Inside double quotes a `$`, a backtick or a backslash still means
      // something we decline to evaluate.
      if (/[$`\\]/.test(body)) return null
      word += body
      hasWord = true
      i = close
      continue
    }
    if (ch === '\\') {
      // A line continuation is whitespace; any other escape is a quoting form
      // this lexer will not guess at.
      if (script[i + 1] === '\n') {
        endWord()
        i++
        continue
      }
      return null
    }
    if (ch === ';' || ch === '\n') {
      endStep(i)
      start = i + 1
      continue
    }
    if (ch === '&' && script[i + 1] === '&') {
      endStep(i)
      i++
      start = i + 1
      continue
    }
    if (/\s/.test(ch)) {
      endWord()
      continue
    }
    if (SHELL_METACHARS.has(ch)) return null
    word += ch
    hasWord = true
  }
  endStep(script.length)
  return steps
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
// Exported for lib/shellSections, which asks the same question of a step inside
// a script it will NOT promote to a Read card. The lexing differs (that module
// tolerates pipes and unknown commands); what counts as a file view must not.
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
    // output is no longer one file's text.
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

// parseEcho returns the text an `echo` step prints, or null when the step is not
// a bare echo. Flags are refused: `-n` drops the trailing newline (so the next
// command's output continues on the same line) and `-e` expands escapes, and
// either would make the output split below wrong.
function parseEcho(words: string[]): string | null {
  if (words[0] !== 'echo') return null
  if (words.slice(1).some((w) => /^-[neE]+$/.test(w))) return null
  return words.slice(1).join(' ')
}

// parseFileViewScript reads a whole Bash command as a sequence of file views and
// the `echo` separators an agent puts between them. Null unless EVERY step is
// one of those and at least one is a view.
export function parseFileViewScript(script: string): FileViewStep[] | null {
  const steps = lexSteps(script)
  if (!steps || steps.length === 0 || steps.length > MAX_STEPS) return null
  const out: FileViewStep[] = []
  let views = 0
  for (const step of steps) {
    const echo = parseEcho(step.words)
    if (echo !== null) {
      out.push({ kind: 'echo', text: echo })
      continue
    }
    const view = parseView(step.words, step.raw)
    if (!view) return null
    views++
    out.push({ kind: 'view', view })
  }
  return views > 0 ? out : null
}

function matchesAt(lines: string[], pos: number, expected: string[]): boolean {
  if (pos < 0 || pos + expected.length > lines.length) return false
  return expected.every((line, i) => lines[pos + i].trimEnd() === line.trimEnd())
}

// splitFileViewOutput cuts a command's combined output back into one slice per
// file view. Boundaries come from the `echo` markers an agent writes between
// reads, falling back to the line count the range itself implies; a view with
// neither (two open-ended reads back to back) is unsplittable and gives up.
//
// Every disagreement between the script and the output - a marker that never
// appears, more lines than the range could have produced, anything left over at
// the end - returns null so the card falls back to showing the raw output. The
// whole point is that a section only ever carries lines it can prove came from
// that file.
export function splitFileViewOutput(steps: FileViewStep[], output: string): FileViewSection[] | null {
  const body = output.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (!body.trim()) return null
  const lines = body.split('\n')
  const sections: FileViewSection[] = []
  let pos = 0
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (step.kind === 'echo') {
      const expected = step.text.split('\n')
      if (!matchesAt(lines, pos, expected)) return null
      pos += expected.length
      continue
    }
    const view = step.view
    const limit = viewLimit(view)
    const next = steps[i + 1]
    let extent: number
    if (next?.kind === 'echo') {
      const expected = next.text.split('\n')
      // Prefer the marker exactly where a full range would put it: a file whose
      // own text contains the separator (`---` is a real line in plenty of
      // files) must not cut the section short.
      let at = limit != null && matchesAt(lines, pos + limit, expected) ? pos + limit : -1
      for (let j = pos; at < 0 && j + expected.length <= lines.length; j++) {
        if (matchesAt(lines, j, expected)) at = j
      }
      if (at < 0) return null
      extent = at - pos
    } else if (!next) {
      extent = lines.length - pos
    } else {
      // Back-to-back views with no marker: the only boundary is the number of
      // lines the range asked for.
      if (limit == null) return null
      extent = limit
    }
    // A range can come up SHORT (the file ended first), never long - more lines
    // than that means this output is not what the parse thinks it is.
    if (extent < 0 || pos + extent > lines.length || (limit != null && extent > limit)) return null
    sections.push({ ...view, lines: lines.slice(pos, pos + extent) })
    pos += extent
  }
  if (pos !== lines.length) return null
  return sections.length > 0 ? sections : null
}

// fileViewLineInfo phrases a view's range for the card header, matching the
// wording a real Read's offset/limit gets ("lines 40-110", "from line 40").
export function fileViewLineInfo(view: Pick<FileView, 'start' | 'end' | 'ranges'>): string {
  // Several stretches: naming each one would run past the header, so it says how
  // many there are and how far they reach - the numbers themselves are in the
  // gutter beside the lines they belong to.
  if (view.ranges && view.ranges.length > 1) {
    const last = view.ranges[view.ranges.length - 1]
    const span = last.end == null ? `from line ${view.ranges[0].start}` : `lines ${view.ranges[0].start}-${last.end}`
    return `${view.ranges.length} ranges, ${span}`
  }
  if (view.start != null && view.end != null) {
    return view.start === 1 ? `first ${view.end} lines` : `lines ${view.start}-${view.end}`
  }
  if (view.start != null && view.start > 1) return `from line ${view.start}`
  return ''
}
