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

export interface FileView {
  // The file operand exactly as the command wrote it (relative, ~-prefixed, ...).
  path: string
  // 1-based line the output starts at, or null when the command cannot say
  // (a plain `tail`, which counts backwards from an unknown end).
  start: number | null
  // 1-based last line the command asked for, or null when open-ended (`cat`,
  // `sed -n '40,$p'`).
  end: number | null
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
function parseSedRange(expr: string): { start: number; end: number | null } | null {
  const m = /^(\d+)(?:,(\d+|\$))?p$/.exec(expr)
  if (!m) return null
  const start = Number(m[1])
  if (start < 1) return null
  if (m[2] === undefined) return { start, end: start }
  if (m[2] === '$') return { start, end: null }
  const end = Number(m[2])
  return end >= start ? { start, end } : null
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
    const range = parseSedRange(rest[0])
    if (!range) return null
    return { ...base, path: rest[1], start: range.start, end: range.end }
  }

  if (tool === 'cat') {
    const files = args.filter(isOperand)
    const flags = args.filter((a) => !isOperand(a))
    // `-n` numbers the output itself; anything else (`-A`, `-v`, `-s`) changes
    // the bytes printed.
    if (files.length !== 1 || flags.some((f) => f !== '-n' && f !== '--number')) return null
    return { ...base, path: files[0], start: 1, end: null, numbered: flags.length > 0 }
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
    const limit = view.start != null && view.end != null ? view.end - view.start + 1 : null
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
export function fileViewLineInfo(view: { start: number | null; end: number | null }): string {
  if (view.start != null && view.end != null) {
    return view.start === 1 ? `first ${view.end} lines` : `lines ${view.start}-${view.end}`
  }
  if (view.start != null && view.start > 1) return `from line ${view.start}`
  return ''
}
