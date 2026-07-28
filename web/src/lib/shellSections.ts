// Attribute a shell script's OUTPUT back to the commands that produced it.
//
// Agents write investigation scripts, not commands: a `cd`, three greps, a
// `tail`, and an `echo "=== heading ==="` between each so the reader can tell
// the pieces apart. What comes back is one undifferentiated wall of terminal
// text - even though the script says exactly which file every stretch of it
// came from, and often which line of that file.
//
// This module reads that structure back out. It splits the script into steps,
// takes the constant `echo`s as anchors, finds those anchor lines in the output,
// and hands the lines between them to the one command that printed them. The
// chat card then renders each section as what it is: a file's own lines with a
// line-number gutter and its language's highlighting, a grep's matches with the
// file line numbers it printed, and the separators as the strings they are.
//
// The neighbouring lib/fileViewCommand answers a STRICTER version of the same
// question - "is this whole script nothing but reads?", which promotes the card
// to a Read - and is all-or-nothing: one unrecognised step and it declines. This
// one has to cope with the ordinary case where most of a script is opaque, so it
// is lenient by design and degrades per section: a stretch it cannot attribute
// renders as plain terminal text, and the sections around it still don't.
//
// What it will not do is guess. A step whose output length it cannot bound, a
// pipeline that transforms what it read, an `echo` carrying a variable - each
// one makes its section (only its section) plain, because a file name and line
// numbers attached to text from somewhere else would be worse than no
// highlighting at all.
import { parseView, type FileView } from './fileViewCommand'

// A grep-shaped step: output that is a set of lines from one or more files,
// non-contiguous, optionally carrying its own line numbers.
export interface MatchesView {
  // The file operands, as written, when every one of them is a literal path.
  // Empty when the search could have covered anything (a glob, a `-r` over a
  // directory, a variable) - the output's own `path:` prefixes then say which
  // file each line came from.
  paths: string[]
  // `-n` was given, so each line is prefixed with its number in the file.
  numbered: boolean
}

export type ScriptStep =
  // A constant `echo`: prints a known string, so it anchors the output.
  | { kind: 'marker'; text: string }
  // A contiguous slice of one file (`sed -n 40,110p f`, `head -50 f`, `cat f`).
  | { kind: 'view'; view: FileView }
  // Lines matched out of one or more files.
  | { kind: 'matches'; match: MatchesView; command: string }
  // Prints nothing, so it takes no output (`cd`, an assignment, a redirect).
  | { kind: 'silent' }
  // Prints something this module cannot describe.
  | { kind: 'unknown'; command: string }

export type ScriptSection =
  | { kind: 'marker'; lines: string[] }
  | { kind: 'view'; view: FileView; lines: string[] }
  | { kind: 'matches'; match: MatchesView; command: string; lines: string[] }
  | { kind: 'plain'; lines: string[] }

// Steps beyond this are not a script anyone is reading the output of, and the
// marker search below is O(steps x lines).
const MAX_STEPS = 64

// Output beyond this is left alone. Sectioning it means highlighting every line
// of it on the main thread, and nobody is reading a 2,000-line dump of a script
// line by line anyway - that is what the Raw view is for.
const MAX_LINES = 2000

// The shortest `echo` text taken as an anchor. A one- or two-character marker
// ("-", "==") turns up inside real file content far too often to be searched for
// blindly; three is where agents' own separators start (`---`).
const MIN_MARKER_LEN = 3

// --- Lexing -------------------------------------------------------------------

interface Word {
  // The word with its quotes removed - what the shell would pass as an argument.
  text: string
  // Its value depends on the shell (an expansion, a glob, a brace list), so
  // nothing below will read a filename or a flag out of it.
  dynamic: boolean
  // Some part of it was quoted, so it is data rather than a command name.
  quoted: boolean
}

interface Command {
  words: Word[]
  raw: string
  // stdout goes somewhere other than the transcript, so this prints nothing.
  redirected: boolean
}

interface Pipeline {
  cmds: Command[]
  raw: string
}

// Characters that end an unquoted word.
const WORD_END = /[\s;|&<>()]/

// closingDouble returns the index of the `"` that closes the one at `at`, or -1
// when the string is unterminated. A backslash escapes the next character.
function closingDouble(code: string, at: number): number {
  for (let i = at + 1; i < code.length; i++) {
    if (code[i] === '\\') { i++; continue }
    if (code[i] === '"') return i
  }
  return -1
}

// skipExpansion returns the index just past the expansion starting at `at` -
// `$(...)` (paren-balanced, so `$(( ))` is covered), `${...}`, `$NAME` or a
// backquoted command. Its VALUE is never wanted; only its extent is.
function skipExpansion(code: string, at: number): number {
  const n = code.length
  if (code[at] === '`') {
    const close = code.indexOf('`', at + 1)
    return close === -1 ? n : close + 1
  }
  if (code[at + 1] === '(') {
    let depth = 0
    for (let i = at + 1; i < n; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')' && --depth === 0) return i + 1
    }
    return n
  }
  if (code[at + 1] === '{') {
    const close = code.indexOf('}', at + 1)
    return close === -1 ? n : close + 1
  }
  const name = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(code.slice(at))
  return at + (name ? name[0].length : 1)
}

// readWordAt consumes one shell word. Null when a quote never closes (the script
// is truncated or means something we are not modelling).
function readWordAt(code: string, at: number): (Word & { end: number }) | null {
  const n = code.length
  let i = at
  let text = ''
  let dynamic = false
  let quoted = false
  while (i < n) {
    const ch = code[i]
    if (WORD_END.test(ch)) break
    if (ch === '\\') {
      if (i + 1 >= n) { i++; break }
      text += code[i + 1]
      quoted = true
      i += 2
      continue
    }
    if (ch === "'") {
      const close = code.indexOf("'", i + 1)
      if (close === -1) return null
      text += code.slice(i + 1, close)
      quoted = true
      i = close + 1
      continue
    }
    if (ch === '"') {
      const close = closingDouble(code, i)
      if (close === -1) return null
      const body = code.slice(i + 1, close)
      // Inside double quotes a `$` or a backtick still expands.
      if (/[$`]/.test(body)) dynamic = true
      text += body
      quoted = true
      i = close + 1
      continue
    }
    if (ch === '$' || ch === '`') {
      const end = skipExpansion(code, i)
      text += code.slice(i, end)
      dynamic = true
      i = end
      continue
    }
    // Glob and brace metacharacters: the word can name files this parser has no
    // way to enumerate.
    if (ch === '*' || ch === '?' || ch === '[' || ch === '{') {
      dynamic = true
      text += ch
      i++
      continue
    }
    text += ch
    i++
  }
  return { end: i, text, dynamic, quoted }
}

// lexPipelines cuts a script into the pipelines the shell runs one after
// another - the pieces separated by `;`, `&&`, `||` and newlines - each split
// into its `|`-separated commands. Null for a script whose shape this cannot
// model at all (a subshell, a heredoc, a backgrounded command).
function lexPipelines(script: string): Pipeline[] | null {
  const pipelines: Pipeline[] = []
  let cmds: Command[] = []
  let words: Word[] = []
  let redirected = false
  let cmdStart = 0
  let pipeStart = 0
  let lastEnd = -1
  let i = 0
  const n = script.length

  const endCmd = (at: number) => {
    if (words.length > 0) cmds.push({ words, raw: script.slice(cmdStart, at).trim(), redirected })
    words = []
    redirected = false
  }
  const endPipeline = (at: number, next: number) => {
    endCmd(at)
    if (cmds.length > 0) pipelines.push({ cmds, raw: script.slice(pipeStart, at).trim() })
    cmds = []
    pipeStart = next
    cmdStart = next
  }

  while (i < n) {
    const ch = script[i]
    if (ch === '\n' || ch === ';') { endPipeline(i, i + 1); i++; continue }
    if (ch === '&') {
      if (script[i + 1] === '&') { endPipeline(i, i + 2); i += 2; continue }
      // A backgrounded command's output arrives whenever it arrives, so no
      // ordering below would hold.
      return null
    }
    if (ch === '|') {
      if (script[i + 1] === '|') { endPipeline(i, i + 2); i += 2; continue }
      endCmd(i)
      cmdStart = i + 1
      i++
      continue
    }
    // A subshell reorders nothing but nests, and its `(` would be read as a word
    // boundary rather than a group.
    if (ch === '(' || ch === ')') return null
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue }
    // A `#` opens a comment only at the start of a word, which is where we are.
    if (ch === '#') {
      const nl = script.indexOf('\n', i)
      i = nl === -1 ? n : nl
      continue
    }
    if (ch === '<' || ch === '>') {
      // A heredoc body is data, and lexing it as shell would turn a file's worth
      // of text into commands.
      if (script.startsWith('<<', i)) return null
      // `2>` redirects a stream: the digit belongs to the operator, not to the
      // command's arguments. Only when it is written flush against it.
      let fd = ''
      const prev = words[words.length - 1]
      if (prev && lastEnd === i && !prev.quoted && /^[0-9]$/.test(prev.text)) {
        fd = prev.text
        words.pop()
      }
      // Only stdout carries the output being split up here.
      if (ch === '>' && fd !== '2') redirected = true
      i++
      if (script[i] === '>' || script[i] === '&') i++
      while (script[i] === ' ' || script[i] === '\t') i++
      // The target - another stream (`&1`) or a file - is consumed and dropped.
      if (/^[0-9-]$/.test(script[i] ?? '')) { while (i < n && /[0-9-]/.test(script[i])) i++; continue }
      const target = readWordAt(script, i)
      if (!target) return null
      i = target.end > i ? target.end : i + 1
      continue
    }
    const word = readWordAt(script, i)
    if (!word) return null
    if (word.end === i) return null // defensive: never fail to advance
    i = word.end
    lastEnd = i
    words.push(word)
  }
  endPipeline(n, n)
  return pipelines
}

// --- Classifying --------------------------------------------------------------

// Commands that print nothing on success. Deliberately short: misjudging one as
// silent hands its output to the next section, while leaving a genuinely silent
// command out only costs a section its highlighting (the gap it sits in gets
// more than one producer, and falls back to plain text).
const SILENT = new Set(['cd', 'export', 'unset', 'set', 'shift', 'umask', 'pushd', 'popd', 'true', 'false', ':'])

const GREP_TOOLS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack'])

// grep flags that take a separate argument, so the word after them is not an
// operand.
const GREP_ARG_FLAGS = new Set([
  '-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '--after-context',
  '-B', '--before-context', '-C', '--context', '-d', '--devices', '--binary-files',
  '--include', '--exclude', '--exclude-dir', '--color', '--colour', '-g', '--glob',
  '-t', '--type', '-T', '--type-not', '--max-columns', '--sort', '--iglob',
])

// grep flags that make a printed line something other than a line of a file:
// counts, bare filenames, only the matched substring, nothing at all.
const GREP_SHAPE_FLAGS = new Set([
  '-c', '--count', '-l', '--files-with-matches', '-L', '--files-without-match',
  '-o', '--only-matching', '-q', '--quiet', '--silent', '--vimgrep', '--json',
  '-Z', '--null', '-z', '--null-data', '--files',
])
// The same, as single letters inside a cluster (`-rn`, `-icl`).
const GREP_SHAPE_LETTERS = new Set(['c', 'l', 'L', 'o', 'q', 'Z', 'z'])
// Cluster letters whose argument follows the cluster (`-m5` is not modelled).
const GREP_ARG_LETTERS = new Set(['e', 'f', 'm', 'A', 'B', 'C', 'd', 'g', 't', 'T'])

// parseMarker returns the text a bare `echo` prints, or null when the step is
// not one whose output is known in advance. Flags are refused: `-n` drops the
// trailing newline (so the next command continues on the same line) and `-e`
// expands escapes - either makes the printed text something other than this.
function parseMarker(words: Word[]): string | null {
  if (words[0].text !== 'echo' || words[0].quoted) return null
  const args = words.slice(1)
  if (args.some((w) => w.dynamic || /^-[neE]+$/.test(w.text))) return null
  const text = args.map((w) => w.text).join(' ')
  return text.trim().length >= MIN_MARKER_LEN ? text : null
}

// parseMatches reads a grep-family search: which files it could have printed
// lines from, and whether those lines carry their numbers.
function parseMatches(words: Word[]): MatchesView | null {
  if (!GREP_TOOLS.has(words[0].text) || words[0].quoted) return null
  const args = words.slice(1)
  const operands: Word[] = []
  let numbered = false
  // `-e`/`-f` name the pattern explicitly, so every operand is then a file.
  let patternGiven = false
  for (let i = 0; i < args.length; i++) {
    const w = args[i]
    if (w.quoted || !w.text.startsWith('-') || w.text === '-') { operands.push(w); continue }
    const [flag, inlineValue] = splitAt(w.text, '=')
    if (GREP_SHAPE_FLAGS.has(flag)) return null
    if (flag === '-n' || flag === '--line-number') { numbered = true; continue }
    if (flag === '-e' || flag === '--regexp' || flag === '-f' || flag === '--file') patternGiven = true
    if (GREP_ARG_FLAGS.has(flag)) {
      if (inlineValue === null) i++
      continue
    }
    if (flag.startsWith('--')) continue
    // A short cluster: `-rn`, `-in`, `-iE`. The whole cluster is refused if any
    // letter reshapes the output, and a trailing argument-taking letter eats the
    // next word.
    if (!/^-[A-Za-z]+$/.test(flag)) return null
    const letters = flag.slice(1).split('')
    if (letters.some((c) => GREP_SHAPE_LETTERS.has(c))) return null
    if (letters.includes('n')) numbered = true
    if (letters.some((c) => c === 'e' || c === 'f')) patternGiven = true
    const last = letters[letters.length - 1]
    if (GREP_ARG_LETTERS.has(last)) i++
  }
  // The first bare operand is the pattern unless `-e` already gave one.
  const files = patternGiven ? operands : operands.slice(1)
  return { paths: files.some((f) => f.dynamic) ? [] : files.map((f) => f.text), numbered }
}

function splitAt(word: string, sep: string): [string, string | null] {
  const at = word.indexOf(sep)
  return at === -1 ? [word, null] : [word.slice(0, at), word.slice(at + 1)]
}

// isFilter reports whether a command only trims what the command before it in
// the pipeline printed - `| head`, `| tail -20` with no file of its own.
function isFilter(cmd: Command): 'head' | 'tail' | null {
  const name = cmd.words[0].text
  if (name !== 'head' && name !== 'tail') return null
  return cmd.words.slice(1).every((w) => w.text.startsWith('-') && !w.quoted) ? name : null
}

// classify decides what one pipeline contributes to the output.
function classify(p: Pipeline): ScriptStep {
  // Trailing filters truncate what the command before them printed; they do not
  // change what it IS, so `grep -n x f | head` is still that grep's matches.
  let cmds = p.cmds
  let trimmedFrom: 'head' | 'tail' | null = null
  while (cmds.length > 1) {
    const filter = isFilter(cmds[cmds.length - 1])
    if (!filter) break
    trimmedFrom = filter
    cmds = cmds.slice(0, -1)
  }
  if (cmds.length !== 1) return { kind: 'unknown', command: p.raw }
  const cmd = cmds[0]
  if (cmd.words.length === 0) return { kind: 'silent' }
  const name = cmd.words[0]
  // stdout went to a file, so nothing of this reaches the transcript.
  if (cmd.redirected) return { kind: 'silent' }
  if (!name.quoted && (SILENT.has(name.text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(name.text))) return { kind: 'silent' }

  const marker = parseMarker(cmd.words)
  if (marker !== null && !trimmedFrom) return { kind: 'marker', text: marker }

  const matches = parseMatches(cmd.words)
  if (matches) return { kind: 'matches', match: matches, command: p.raw }

  if (!cmd.words.some((w) => w.dynamic)) {
    const view = parseView(cmd.words.map((w) => w.text), p.raw)
    if (view) {
      // A `| head` keeps the start of what was printed and drops the end; a
      // `| tail` keeps an end this parser cannot number.
      if (trimmedFrom === 'head') return { kind: 'view', view: { ...view, end: null } }
      if (trimmedFrom === 'tail') return { kind: 'view', view: { ...view, start: null, end: null } }
      return { kind: 'view', view }
    }
  }
  return { kind: 'unknown', command: p.raw }
}

// parseScriptSteps reads a whole Bash command as the sequence of steps it runs.
// Null when the script has nothing this module could describe - no marker, no
// file read, no search - so the caller keeps its plain output panel.
export function parseScriptSteps(script: string): ScriptStep[] | null {
  const pipelines = lexPipelines(script)
  if (!pipelines || pipelines.length === 0 || pipelines.length > MAX_STEPS) return null
  const steps = pipelines.map(classify)
  return steps.some((s) => s.kind === 'marker' || s.kind === 'view' || s.kind === 'matches') ? steps : null
}

// --- Splitting the output -----------------------------------------------------

function matchesAt(lines: string[], pos: number, expected: string[]): boolean {
  if (pos < 0 || pos + expected.length > lines.length) return false
  return expected.every((line, i) => lines[pos + i].trimEnd() === line.trimEnd())
}

// stepLimit is the most lines a step can have printed, or null when it is not
// bounded by anything the script says.
function stepLimit(step: ScriptStep): number | null {
  if (step.kind !== 'view') return null
  const { start, end } = step.view
  return start != null && end != null ? end - start + 1 : null
}

// distribute hands a stretch of output to the producers that ran inside it.
// Null when the boundaries between them are not knowable - which is the common
// case for more than one producer, and is why agents' separator `echo`s matter.
function distribute(producers: ScriptStep[], slice: string[]): string[][] | null {
  if (producers.length === 0) return null
  if (producers.length === 1) return [slice]
  const out: string[][] = []
  let pos = 0
  for (let i = 0; i < producers.length; i++) {
    if (i === producers.length - 1) { out.push(slice.slice(pos)); break }
    const limit = stepLimit(producers[i])
    if (limit == null) return null
    const take = Math.min(limit, slice.length - pos)
    out.push(slice.slice(pos, pos + take))
    pos += take
  }
  return out
}

// splitScriptOutput cuts a command's output into one section per step that
// printed it. Null when nothing came back worth sectioning.
//
// The `echo`s are the anchors: each one's text is looked for in what is left of
// the output, and the lines before it belong to whatever ran in between. An
// anchor that never appears is skipped rather than fatal - a separator behind a
// `||` only prints when the command before it failed, and an agent writes those
// constantly - so a missing one costs a section its highlighting, not the split.
export function splitScriptOutput(steps: ScriptStep[], output: string): ScriptSection[] | null {
  const body = output.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (!body.trim()) return null
  const lines = body.split('\n')
  if (lines.length > MAX_LINES) return null
  const sections: ScriptSection[] = []
  let pending: ScriptStep[] = []
  let pos = 0

  const flush = (end: number) => {
    const slice = lines.slice(pos, end)
    pos = end
    if (slice.length === 0) { pending = []; return }
    const parts = distribute(pending, slice)
    if (!parts) {
      sections.push({ kind: 'plain', lines: slice })
      pending = []
      return
    }
    parts.forEach((part, i) => {
      if (part.length === 0) return
      const step = pending[i]
      const limit = stepLimit(step)
      // More lines than the range could have produced (an error, a banner, a
      // marker that did not fire) means this is not what the parse thinks it is.
      if (step.kind === 'view' && (limit == null || part.length <= limit)) {
        sections.push({ kind: 'view', view: step.view, lines: part })
      } else if (step.kind === 'matches') {
        sections.push({ kind: 'matches', match: step.match, command: step.command, lines: part })
      } else {
        sections.push({ kind: 'plain', lines: part })
      }
    })
    pending = []
  }

  for (const step of steps) {
    if (step.kind === 'silent') continue
    if (step.kind !== 'marker') { pending.push(step); continue }
    const expected = step.text.split('\n')
    // Prefer the marker exactly where the steps before it would put it: a file
    // whose own text contains the separator (`---` is a real line in plenty of
    // files) must not cut its section short.
    const total = pending.reduce<number | null>((sum, s) => {
      const limit = stepLimit(s)
      return sum == null || limit == null ? null : sum + limit
    }, 0)
    let at = total != null && matchesAt(lines, pos + total, expected) ? pos + total : -1
    for (let j = pos; at < 0 && j + expected.length <= lines.length; j++) {
      if (matchesAt(lines, j, expected)) at = j
    }
    if (at < 0) continue // this one never printed
    flush(at)
    sections.push({ kind: 'marker', lines: lines.slice(at, at + expected.length) })
    pos = at + expected.length
  }
  flush(lines.length)

  return sections.some((s) => s.kind !== 'plain') ? sections : null
}

// --- Reading a grep's own line prefixes ---------------------------------------

// One line of a search's output, with whatever the search itself said about
// where it came from split back off the front.
export interface MatchLine {
  // The file it came from, when the output named one ('' otherwise).
  path: string
  // Its number in that file ('' when the search printed none).
  num: string
  // The line's text.
  text: string
  // A `--` between context groups: not a line of any file.
  separator: boolean
}

// grep writes `NNN:` before a matched line and `NNN-` before a context line
// (-A/-B/-C), and puts `path:` in front of both when it searched more than one
// file.
const NUMBERED = /^(\d+)[:-](.*)$/
const PATH_NUMBERED = /^([^:\s][^:]*):(\d+)[:-](.*)$/
const PATH_ONLY = /^([\w./~@+-]*[/.][\w./~@+-]*):(.*)$/

// parseMatchLines reads the prefixes off a search's output. The SHAPE is taken
// from the lines themselves rather than from the flags, because the same tool
// prints different ones (`rg` numbers its output for a terminal and not for a
// pipe) and because a wrong guess here is visible: the number in the gutter
// would not be the number in the file.
//
// A majority has to agree on one shape before it is applied - the odd line that
// does not fit (a truncation notice, a warning on stderr) then renders bare
// rather than dragging the whole section down with it.
export function parseMatchLines(lines: string[], paths: string[]): MatchLine[] {
  const bare = (text: string): MatchLine => ({ path: '', num: '', text, separator: false })
  const body = lines.filter((l) => l.trim() !== '--' && l !== '')
  const majority = (re: RegExp) => body.length > 0 && body.filter((l) => re.test(l)).length > body.length / 2

  const shape = majority(NUMBERED)
    ? NUMBERED
    : majority(PATH_NUMBERED)
      ? PATH_NUMBERED
      : paths.length !== 1 && majority(PATH_ONLY)
        ? PATH_ONLY
        : null
  if (!shape) return lines.map(bare)

  return lines.map((line) => {
    if (line.trim() === '--') return { path: '', num: '', text: line, separator: true }
    const m = shape.exec(line)
    if (!m) return bare(line)
    if (shape === NUMBERED) return { path: '', num: m[1], text: m[2], separator: false }
    if (shape === PATH_NUMBERED) return { path: m[1], num: m[2], text: m[3], separator: false }
    return { path: m[1], num: '', text: m[2], separator: false }
  })
}
