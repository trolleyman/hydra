// Attribute a shell script's OUTPUT back to the commands that produced it.
//
// Agents write investigation scripts, not commands: a `cd`, three greps, a
// `tail`, and an `echo "=== heading ==="` between each so the reader can tell
// the pieces apart. What comes back is one undifferentiated wall of terminal
// text - even though the script says exactly which file every stretch of it
// came from, and often which line of that file.
//
// This module reads that structure back out. It splits the script into steps,
// takes constant line-printers (`echo`, `printf '%s\n' '...'`) as anchors, finds
// those anchor lines in the output, and hands the lines between them to the one
// command that printed them. The chat card then renders each section as what it
// is: a file's own lines with a line-number gutter and its language's
// highlighting, a grep's matches with the file line numbers it printed, a git
// report in git's own colours (lib/
// gitOutput), and the separators as the strings they are.
//
// The neighbouring lib/fileViewCommand answers one question for it - "is this
// step a plain read of one named file, and which of its lines?" - and answers it
// strictly. This module is lenient by design around that: most of a real script
// is opaque, so it degrades per section, and a stretch it cannot attribute
// renders as plain terminal text while the sections around it still don't.
//
// What it will not do is guess. A step whose output length it cannot bound, a
// pipeline that transforms what it read, an `echo` carrying a variable - each
// one makes its section (only its section) plain, because a file name and line
// numbers attached to text from somewhere else would be worse than no
// highlighting at all.
//
// A command that FAILED is sectioned like any other, which it could not be while
// the stderr mixed into its output was indistinguishable from it. It is not: a
// tool's own error message names the tool that wrote it (`sed: can't read f: ...`),
// so those lines are lifted out before the split and put back after it - and the
// one that names a file some step was asked to read also says that step printed
// nothing, which is what stops a step that died from being handed the next one's
// lines. See diagnosticLines / failedSteps.
import { hasAnsi, stripAnsi } from './ansi'
import { CWD_RESET, EXIT_STATUS, NO_OUTPUT } from './buildOutput'
import type { DiskTool } from './diskOutput'
import { langFromPath } from './fileKind'
import type { SearchSummary } from './searchSummary'
import {
  parseBannerView, parseSedRange, parseView, viewLimit,
  type BannerView, type FileView,
} from './fileViewCommand'

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

// `cap` is the most lines a step's own script says it can print, whatever the
// step turns out to BE: a trailing `| tail -2` bounds a `mage build` this module
// can say nothing else about, and a `git log --oneline -3` bounds itself. It
// rides beside the kind rather than inside one of them because it is the one
// bound that does not come from knowing what the output is - which is exactly
// why it matters. An opaque step with no bound at all is a boundary nothing can
// place, and it costs every neighbour in the same stretch its attribution (see
// distribute); a bounded one costs nothing but its own lines.
//
// stepLimit takes the tighter of this and whatever the kind's own shape says.
export type ScriptStep = { cap?: number } & (
  // A constant line-printer: prints a known string, so it anchors the output.
  | { kind: 'marker'; text: string }
  // A constant line-printer whose text is too short to search the output for -
  // most often the bare `echo` agents put between their greps to space the
  // output out. It anchors nothing, but it still prints a known number of known
  // lines, which is enough to keep it from costing its neighbours attribution.
  | { kind: 'echo'; text: string }
  // A contiguous slice of one file (`sed -n 40,110p f`, `head -50 f`, `cat f`).
  | { kind: 'view'; view: FileView }
  // Lines matched out of one or more files.
  | { kind: 'matches'; match: MatchesView; command: string }
  // git reporting on the repository rather than printing a file: a status, a
  // commit header, a diffstat, a patch (see lib/gitOutput).
  | { kind: 'git'; command: string }
  // A listing of what is on disk - how big, how full, whose, when (see
  // lib/diskOutput).
  | { kind: 'disk'; tool: DiskTool; command: string }
  // A `git blame`: the named file's lines, each behind the commit that last
  // touched it (see gitOutput.parseBlameLine).
  | { kind: 'blame'; path: string; command: string }
  // What a search said ABOUT the files rather than what it found in them - a
  // `-c` count per file, or a `-l` list of the ones that matched (see
  // lib/searchSummary).
  | { kind: 'summary'; summary: SearchSummary; command: string }
  // Several files' contents, with the `==> name <==` banner head/tail print
  // between them saying which is which.
  | { kind: 'banners'; view: BannerView }
  // Prints nothing, so it takes no output (`cd`, an assignment, a redirect).
  | { kind: 'silent' }
  // Prints something this module cannot describe.
  | { kind: 'unknown'; command: string }
)

// Every section carries `lines` with any ANSI colour stripped out - that is what
// gets matched, attributed and highlighted, since an escape sequence in the
// middle of a line of Go is not part of the Go. `raw` is the same lines as they
// arrived, present only when the output actually carried colour, so a stretch
// that renders as terminal text can render as the terminal wrote it.
interface SectionLines {
  lines: string[]
  raw?: string[]
}

export type ScriptSection =
  | ({ kind: 'marker' } & SectionLines)
  // What the shell or one of its tools said about ITSELF: the `sed: can't read
  // f: No such file or directory` half of a failed command's output, and the
  // harness's `Exit code 2` above it. Not one line of any file (see
  // lib/buildOutput's diagnosticSpans).
  | ({ kind: 'error' } & SectionLines)
  | ({ kind: 'view'; view: FileView } & SectionLines)
  | ({ kind: 'matches'; match: MatchesView; command: string } & SectionLines)
  | ({ kind: 'git'; command: string } & SectionLines)
  | ({ kind: 'disk'; tool: DiskTool; command: string } & SectionLines)
  | ({ kind: 'blame'; path: string; command: string } & SectionLines)
  | ({ kind: 'summary'; summary: SearchSummary; command: string } & SectionLines)
  | ({ kind: 'banners'; view: BannerView } & SectionLines)
  | ({ kind: 'plain' } & SectionLines)

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
  // It BEGINS quoted, which is the stricter question to ask of something that
  // looks like a flag: `"-v"` is a pattern that happens to start with a dash,
  // but `--include="*.ts"` is a flag whose VALUE is quoted.
  quotedStart: boolean
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

// What has to follow a `{ ... }`/`( ... )` group for the group to be a step of
// the script in its own right rather than something being done to as a whole:
// the end of the script, or an operator that separates steps. A `|`, a `>` or a
// `&` there belongs to the group, not to the last command inside it.
const STEP_END = /^[ \t]*(?:$|[;\n]|&&|\|\|)/

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
  return { end: i, text, dynamic, quoted, quotedStart: /['"\\]/.test(code[at] ?? '') }
}

// A bare heredoc delimiter has to look like an identifier, which is what keeps
// an arithmetic left shift - `$(( 1 << 2 ))` - from being read as one.
const HEREDOC_DELIM = /^[A-Za-z_][A-Za-z0-9_.-]*$/

// readHeredoc parses a `<<`/`<<-` operator at `at` and finds where its body
// ends, so the lexer can step over a region that is DATA. Null when what follows
// is not a plausible heredoc.
//
// The body is skipped rather than modelled: it is stdin for the command the
// operator belongs to, so nothing in it is a command and nothing in it reaches
// the transcript. The one thing that matters is not lexing it as shell, which
// would turn a file's worth of text into commands.
function readHeredoc(script: string, at: number): { opEnd: number; delim: string; strip: boolean } | null {
  let i = at + 2
  const strip = script[i] === '-'
  if (strip) i++
  while (script[i] === ' ' || script[i] === '\t') i++
  let delim = ''
  const quote = script[i]
  if (quote === "'" || quote === '"') {
    const close = script.indexOf(quote, i + 1)
    if (close === -1) return null
    delim = script.slice(i + 1, close)
    i = close + 1
  } else {
    while (i < script.length && !WORD_END.test(script[i])) { delim += script[i]; i++ }
    if (!HEREDOC_DELIM.test(delim)) return null
  }
  return delim === '' ? null : { opEnd: i, delim, strip }
}

// skipHeredocBodies steps over the bodies queued on the line that just ended,
// returning where shell resumes. An unterminated body (a truncated script) runs
// to the end, which is what the shell would have done with it.
function skipHeredocBodies(script: string, from: number, pending: { delim: string; strip: boolean }[]): number {
  let pos = from
  for (const h of pending) {
    while (pos < script.length) {
      const nl = script.indexOf('\n', pos)
      const end = nl === -1 ? script.length : nl
      const raw = script.slice(pos, end)
      const body = h.strip ? raw.replace(/^\t+/, '') : raw
      pos = nl === -1 ? script.length : nl + 1
      if (body.replace(/\r$/, '') === h.delim) break
    }
  }
  return pos
}

// skipGroup steps over a `( ... )` (or `{ ...; }`) from its opening bracket,
// respecting quotes, and returns the index just past its close - or -1 when it
// never closes. The group is then one opaque command: it prints something this
// module cannot describe, which is what `unknown` is for, and refusing the whole
// script over it cost every OTHER step in the script its attribution.
function skipGroup(script: string, at: number): number {
  const open = script[at]
  const close = open === '(' ? ')' : '}'
  let depth = 0
  for (let i = at; i < script.length; i++) {
    const ch = script[i]
    if (ch === "'" || ch === '"') {
      const end = ch === '"' ? closingDouble(script, i) : script.indexOf("'", i + 1)
      if (end === -1) return -1
      i = end
      continue
    }
    if (ch === '\\') { i++; continue }
    if (ch === open) depth++
    else if (ch === close && --depth === 0) return i + 1
  }
  return -1
}

// lexPipelines cuts a script into the pipelines the shell runs one after
// another - the pieces separated by `;`, `&&`, `||` and newlines - each split
// into its `|`-separated commands. Null for a script whose shape this cannot
// model at all (a backgrounded command, an unterminated quote).
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
  // Heredocs opened on the line being lexed, whose bodies start after it.
  let heredocs: { delim: string; strip: boolean }[] = []

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
    if (ch === '\n' || ch === ';') {
      endPipeline(i, i + 1)
      i++
      // The bodies of any heredocs this line opened sit here, between the line
      // and the next command.
      if (heredocs.length > 0) {
        i = skipHeredocBodies(script, i, heredocs)
        heredocs = []
        pipeStart = i
        cmdStart = i
      }
      continue
    }
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
    if (ch === '(' || (ch === '{' && WORD_END.test(script[i + 1] ?? ' '))) {
      const end = skipGroup(script, i)
      if (end === -1) return null
      // A group that stands on its own as a step of the script prints exactly
      // what the commands inside it print, in that order - so its CONTENTS are
      // the steps, and the `echo` heading an agent wrapped up in one is an anchor
      // like any other. (Agents write `cd x && { a; echo ===; b; }` constantly,
      // to hang a run of steps off one `cd`; read as one opaque word, the group
      // cost every step in it its attribution.)
      //
      // Only when nothing is done to the group as a WHOLE: a `|` after it filters
      // the lot, a `>` redirects the lot, and either makes the group one producer
      // again. What follows has to be the end of the script or something that
      // separates steps.
      const inner = words.length === 0 && cmds.length === 0 && STEP_END.test(script.slice(end))
        ? lexPipelines(script.slice(i + 1, end - 1))
        : null
      if (inner) {
        pipelines.push(...inner)
        i = end
        lastEnd = i
        pipeStart = i
        cmdStart = i
        continue
      }
      // Otherwise it is ONE producer's worth of output that this module is not
      // going to describe, stepped over as a single opaque word rather than
      // costing the whole script its parse.
      words.push({ text: script.slice(i, end), dynamic: true, quoted: false, quotedStart: false })
      i = end
      lastEnd = i
      continue
    }
    if (ch === ')' || ch === '}') return null
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue }
    // A `#` opens a comment only at the start of a word, which is where we are.
    if (ch === '#') {
      const nl = script.indexOf('\n', i)
      i = nl === -1 ? n : nl
      continue
    }
    if (ch === '<' || ch === '>') {
      // A here-string's word is data on stdin: consumed and dropped, like a
      // redirect target.
      if (script.startsWith('<<<', i)) {
        i += 3
        while (script[i] === ' ' || script[i] === '\t') i++
        const target = readWordAt(script, i)
        if (!target) return null
        i = target.end > i ? target.end : i + 1
        continue
      }
      // A heredoc's BODY is data too, but it does not start until after this
      // line, so the operator is noted here and the body stepped over there.
      if (script.startsWith('<<', i)) {
        const doc = readHeredoc(script, i)
        if (!doc) return null
        heredocs.push({ delim: doc.delim, strip: doc.strip })
        i = doc.opEnd
        continue
      }
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

// grep flags that make the output a SUMMARY of the search rather than lines of a
// file: how many matched, or which files did. Each line is still about one file,
// so it is a shape of its own (see lib/searchSummary) rather than a refusal.
const GREP_COUNT_FLAGS = new Set(['-c', '--count'])
const GREP_FILES_FLAGS = new Set([
  '-l', '--files-with-matches', '-L', '--files-without-match', '--files',
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
// Of those, the two that summarise rather than reshape.
const GREP_COUNT_LETTERS = new Set(['c'])
const GREP_FILES_LETTERS = new Set(['l', 'L'])
// Cluster letters whose argument follows the cluster.
const GREP_ARG_LETTERS = new Set(['e', 'f', 'm', 'A', 'B', 'C', 'd', 'g', 't', 'T'])

// A short flag carrying its number inline - `-A35`, `-C3`, `-m10`, and the
// `-3` GNU grep takes as `-C 3`. Agents write the context flags this way as
// often as with a space, and reading one as an unknown cluster cost the whole
// step its shape: the output still came back as `NNN:` lines of a file, but with
// no step claiming them.
const GREP_INLINE_NUM = /^-([A-Za-z]*)(\d+)$/

// parseConstantLine returns the text a simple line-printer prints, or null when
// the step is not one whose output is known in advance.
//
// A bare `echo` prints one empty line, so it returns '' - not null. Whether the
// text is long enough to SEARCH for is a separate question, asked in classify.
//
// Codex commonly uses `printf '%s\n' '--- heading ---'` instead. That exact
// form is equivalent: one static format, one static value, one known output
// line. Other printf forms are deliberately refused - an extra value repeats
// the format, and any other format can transform the value or change its line
// count.
function parseConstantLine(words: Word[]): string | null {
  const name = words[0]
  if (name.quoted) return null
  if (name.text === 'echo') {
    const args = words.slice(1)
    // Flags are refused: `-n` drops the trailing newline and `-e` expands
    // escapes, either of which makes the printed text something else.
    if (args.some((w) => w.dynamic || /^-[neE]+$/.test(w.text))) return null
    return args.map((w) => w.text).join(' ')
  }
  if (name.text === 'printf' && words.length === 3) {
    const [, format, value] = words
    if (!format.dynamic && format.text === '%s\\n' && !value.dynamic) return value.text
  }
  return null
}

interface ParsedGrep extends MatchesView {
  // How many file operands the search names. Zero means it read stdin, which is
  // what makes it a filter on the command before it rather than a search of its
  // own - and is not the same as `paths` being empty, which also happens when a
  // named file's word is a glob or a variable.
  fileCount: number
  // The search printed a SUMMARY rather than lines: how many matched per file,
  // or which files did. Its `paths`/`numbered` then describe nothing.
  summary?: SearchSummary
}

// parseMatches reads a grep-family search: which files it could have printed
// lines from, and whether those lines carry their numbers.
function parseMatches(words: Word[]): ParsedGrep | null {
  if (!GREP_TOOLS.has(words[0].text) || words[0].quoted) return null
  const args = words.slice(1)
  const operands: Word[] = []
  let numbered = false
  // `-e`/`-f` name the pattern explicitly, so every operand is then a file.
  let patternGiven = false
  let summary: SearchSummary | undefined
  for (let i = 0; i < args.length; i++) {
    const w = args[i]
    // `quotedStart`, not `quoted`: `--include="*.ts"` is a flag carrying a
    // quoted value, and counting it as a file operand put a path that is not a
    // path into the section's file list.
    if (w.quotedStart || !w.text.startsWith('-') || w.text === '-') { operands.push(w); continue }
    const [flag, inlineValue] = splitAt(w.text, '=')
    if (GREP_COUNT_FLAGS.has(flag)) { summary = 'counts'; continue }
    if (GREP_FILES_FLAGS.has(flag)) { summary = 'files'; continue }
    if (GREP_SHAPE_FLAGS.has(flag)) return null
    if (flag === '-n' || flag === '--line-number') { numbered = true; continue }
    if (flag === '-e' || flag === '--regexp' || flag === '-f' || flag === '--file') patternGiven = true
    if (GREP_ARG_FLAGS.has(flag)) {
      if (inlineValue === null) i++
      continue
    }
    if (flag.startsWith('--')) continue
    // `-A35`, `-nC3`, `-3`: the number is the flag's own argument, so it does not
    // eat the next word - and a count of context lines only changes how many
    // lines come back, never what a line IS.
    const inline = GREP_INLINE_NUM.exec(flag)
    if (inline) {
      const letters = inline[1].split('')
      if (letters.some((c) => GREP_SHAPE_LETTERS.has(c))) return null
      // Only a flag that TAKES a number can carry one (`-i3` is not a spelling
      // of anything), and `-3` on its own carries it for grep's context.
      const last = letters[letters.length - 1]
      if (letters.length > 0 && !GREP_ARG_LETTERS.has(last)) return null
      if (letters.includes('n')) numbered = true
      if (letters.some((c) => c === 'e' || c === 'f')) patternGiven = true
      continue
    }
    // A short cluster: `-rn`, `-in`, `-iE`. The whole cluster is refused if any
    // letter reshapes the output, and a trailing argument-taking letter eats the
    // next word.
    if (!/^-[A-Za-z]+$/.test(flag)) return null
    const letters = flag.slice(1).split('')
    if (letters.some((c) => GREP_COUNT_LETTERS.has(c))) summary = 'counts'
    else if (letters.some((c) => GREP_FILES_LETTERS.has(c))) summary = 'files'
    // A cluster asking for BOTH a count and a file list, or for one of the
    // shapes above alongside it, prints something this cannot describe.
    if (letters.some((c) => GREP_SHAPE_LETTERS.has(c) && !GREP_COUNT_LETTERS.has(c) && !GREP_FILES_LETTERS.has(c))) return null
    if (summary && letters.filter((c) => GREP_COUNT_LETTERS.has(c) || GREP_FILES_LETTERS.has(c)).length > 1) return null
    if (letters.includes('n')) numbered = true
    if (letters.some((c) => c === 'e' || c === 'f')) patternGiven = true
    const last = letters[letters.length - 1]
    if (GREP_ARG_LETTERS.has(last)) i++
  }
  // The first bare operand is the pattern unless `-e` already gave one.
  const files = patternGiven ? operands : operands.slice(1)
  return {
    paths: files.some((f) => f.dynamic) ? [] : files.map((f) => f.text),
    numbered,
    fileCount: files.length,
    summary,
  }
}

function splitAt(word: string, sep: string): [string, string | null] {
  const at = word.indexOf(sep)
  return at === -1 ? [word, null] : [word.slice(0, at), word.slice(at + 1)]
}

// git subcommands whose output is a report on the repository - a status, a
// commit header, a diffstat, a patch, the rule that ignores a path - which are
// the shapes lib/gitOutput knows how to colour. Each of them prints one of those
// whatever it is asked for, so the refused flags below are the only thing that
// can turn one into something else.
const GIT_REPORTS = new Set([
  'status', 'show', 'log', 'diff', 'check-ignore', 'branch', 'remote', 'stash', 'shortlog',
])

// Three of those subcommands are only a REPORT in some of their spellings: the
// same word also deletes a branch, pops a stash and adds a remote. Each is held
// to the read-only spelling, because a card that colours `git stash` (which
// STASHES) as a listing is describing something that did not happen.
const GIT_READONLY: Record<string, (args: Word[]) => boolean> = {
  branch: (args) => !args.some((w) => /^(-d|-D|-m|-M|-c|-C|--delete|--move|--copy|--edit-description|--set-upstream(-to)?(=.*)?|--unset-upstream|-u)$/.test(w.text)),
  // `git stash` on its own is `git stash push`.
  stash: (args) => args.length > 0 && /^(list|show)$/.test(args[0].text),
  // `git remote add|rename|remove|set-url` all take a name after them, so the
  // read-only spellings are recognised by their FIRST word rather than by
  // ruling the others out.
  remote: (args) => args.length > 0 && /^(-v|--verbose|show|get-url)$/.test(args[0].text),
}

// Flags that make a git command print nothing and answer with its exit status
// alone - `git check-ignore -q "$f" && echo ...`, `git diff --quiet`. Their
// output is not "unattributable", it is empty, and saying so keeps the step from
// claiming lines its neighbours printed.
const GIT_QUIET = /^(-q|--quiet)$/

// Flags that make git print something OTHER than those shapes: a machine
// readable listing, a format chosen by the caller that could put anything on any
// line, a diff marked up inside the line rather than by it.
//
// `--graph` and `-p` are not among them: the first only puts the topology in the
// left margin and then prints the same lines, and the second prints a patch,
// which lib/gitOutput now reads.
const GIT_REFUSED = /^(--numstat|--name-only|--name-status|--raw|--pretty(=.*)?|--format(=.*)?|-z|--null|--porcelain=.*|--word-diff(=.*)?)$/

// parseGitReport says what a git call prints: one of the reports lib/gitOutput
// colours - a status, a commit header, a diffstat, a patch, an ignore rule -
// 'quiet' when it prints nothing at all, or null when it is neither.
//
// Narrow on purpose. Everything outside this set prints a listing or a format
// chosen by the caller, and a `--pretty` this module has not read can put
// anything on any line.
function parseGitReport(words: Word[]): 'report' | 'quiet' | null {
  if (words[0].text !== 'git' || words[0].quoted) return null
  // git's own options come before the subcommand; `-C` and `-c` take the word
  // after them, and none of them change what the subcommand prints.
  let i = 1
  while (i < words.length && !words[i].quoted && words[i].text.startsWith('-')) {
    if (words[i].text === '-C' || words[i].text === '-c') i++
    i++
  }
  const sub = words[i]
  if (!sub || sub.quoted || !GIT_REPORTS.has(sub.text)) return null
  const args = words.slice(i + 1).filter((w) => !w.quoted)
  if (args.some((w) => GIT_QUIET.test(w.text))) return 'quiet'
  if (args.some((w) => GIT_REFUSED.test(w.text))) return null
  const readonly = GIT_READONLY[sub.text]
  return !readonly || readonly(args) ? 'report' : null
}

// Flags that make one of the disk tools print something other than its ordinary
// table: a NUL-separated stream, an extra column, a list of names read from a
// file (which prints the same shape, but `--files0-from=-` makes the command a
// filter on the one before it rather than a measurement of its own), or - for
// `ls` - no long format at all, which is a bare list of names with nothing in it
// to colour.
//
// The `-0` is written as a cluster as often as on its own (`du -sh0`), so it is
// matched as a LETTER of one rather than as a word.
const DISK_REFUSED: Record<DiskTool, RegExp> = {
  du: /^(--null|--time(=.*)?|--files0-from(=.*)?)$|^-[A-Za-z0-9]*0/,
  df: /^(--output(=.*)?|-i|--inodes|--portability|-P)$/,
  ls: /^(--format=(?!long)|-m|-x|-C|-1|--zero|-Z|--context)$/,
  stat: /^(-c|--format(=.*)?|--printf(=.*)?|-t|--terse)$/,
  // `--files0-from` reads the list of files from somewhere else, so the operands
  // this can see no longer say what was counted; every other wc flag only picks
  // which counts each row carries, never that a row IS a count and a name.
  wc: /^(--files0-from(=.*)?)$/,
}

// `ls` only prints a table when asked for one; anything else is a list of names
// with no measurement in it.
const LS_LONG = /^--format=long$|^--full-time$|^-[A-Za-z]*l/

// diskTool reports which disk listing a command prints, or null when it prints
// none.
//
// The operands are not read, and may be anything - a glob, a variable, a `~`
// path. What these print does not depend on knowing WHICH directories they were
// given, only that each line is a measurement and a name, which is the opposite
// of a file view (where the path is the whole point, because it says what
// language the lines are).
function diskTool(words: Word[]): DiskTool | null {
  const name = words[0]
  if (name.quoted) return null
  const tool = (['du', 'df', 'ls', 'stat', 'wc'] as DiskTool[]).find((t) => t === name.text)
  if (!tool) return null
  const args = words.slice(1).filter((w) => !w.quoted)
  if (args.some((w) => DISK_REFUSED[tool].test(w.text))) return null
  if (tool === 'ls' && !args.some((w) => LS_LONG.test(w.text))) return null
  // A `wc` with no file operand counts its stdin - a single figure about the
  // command piped into it, not a "<count> <path>" listing of files on disk. So
  // it is a listing only when it names a file (`wc -l a b`), which is also the
  // only shape whose rows diskExtent can find in the output.
  if (tool === 'wc' && !words.slice(1).some((w) => w.quotedStart || (!w.text.startsWith('-') && w.text !== '-'))) return null
  return tool
}

// Flags that make `git blame` print something other than its ordinary
// annotated lines: the machine-readable formats, and the incremental stream.
const BLAME_REFUSED = /^(-p|--porcelain|--line-porcelain|--incremental|-z|--null)$/

// parseGitBlame reads a `git blame <file>` and returns the path it annotates, or
// null when the command is not one. A blame takes exactly one file - the flags
// around it (`-L`, `-w`, `-C`, `--date=`) change what it says about each line,
// never that each line IS a line of that file.
function parseGitBlame(words: Word[]): string | null {
  if (words[0].text !== 'git' || words[0].quoted) return null
  let i = 1
  while (i < words.length && !words[i].quoted && words[i].text.startsWith('-')) {
    if (words[i].text === '-C' || words[i].text === '-c') i++
    i++
  }
  if (words[i]?.text !== 'blame') return null
  const args = words.slice(i + 1)
  if (args.some((w) => !w.quoted && BLAME_REFUSED.test(w.text))) return null
  const operands: Word[] = []
  for (let j = 0; j < args.length; j++) {
    const w = args[j]
    if (!w.quotedStart && w.text.startsWith('-')) {
      // `-L` takes the range after it; the rest of blame's flags carry their
      // value inline or take none.
      if (w.text === '-L' || w.text === '--reverse' || w.text === '--contents') j++
      continue
    }
    operands.push(w)
  }
  // A revision before the path, and a path this parser cannot name, are both
  // shapes it declines: the path is the whole point (it says what language the
  // lines are).
  const file = operands[operands.length - 1]
  return operands.length >= 1 && !file.dynamic ? file.text : null
}

// A `head`/`tail` flag that takes its value as the next word (`head -n 5`),
// which is what keeps that bare `5` from being read as the file operand that
// would make this a read rather than a filter.
const TRIM_VALUE = /^(-n|-c|--lines|--bytes)=?(.*)$/
// The count both tools take when nothing says otherwise.
const TRIM_DEFAULT = 10

// isFilter reports whether a command only trims what the command before it in
// the pipeline printed - `| head`, `| tail -20` with no file of its own - and
// how many lines it can leave at most.
//
// The count is an upper bound, not a promise: `tail -20` of twelve lines prints
// twelve. That is all any caller wants from it.
//
// Null count for the spellings that bound nothing: `-c`/`--bytes` measures bytes,
// `-f` never ends, and a SIGNED count runs from the other end - `tail -n +5` is
// "line 5 onwards" and `head -n -5` is "all but the last five", both of which are
// as long as the stream is. Those still trim, which is all the callers below
// that ignore the count need.
function isFilter(cmd: Command): { end: 'head' | 'tail'; count: number | null } | null {
  const name = cmd.words[0]
  if (name.quoted || (name.text !== 'head' && name.text !== 'tail')) return null
  const args = cmd.words.slice(1)
  let count: number | null = TRIM_DEFAULT
  for (let i = 0; i < args.length; i++) {
    const w = args[i]
    // An operand: this is reading a file of its own, not the pipe.
    if (w.quoted || !w.text.startsWith('-')) return null
    const bare = /^-(\d+)$/.exec(w.text)
    if (bare) { count = Number(bare[1]); continue }
    const flag = TRIM_VALUE.exec(w.text)
    if (flag) {
      // `-n20` and `--lines=20` carry their value in the same word; `-n 20`
      // spends the word after, and `-n` at the end of the line has none at all.
      const value = flag[2] || args[++i]?.text
      const lines = flag[1] === '-n' || flag[1] === '--lines'
      count = lines && value !== undefined && /^\d+$/.test(value) ? Number(value) : null
      continue
    }
    // `-f`, `-v`, `-z`: still only a trim, but not one with a line count in it.
    count = null
  }
  return { end: name.text, count }
}

// isPassthrough reports whether a command hands on what it was given byte for
// byte: `| cat`, which agents append to a git call to stop it paging.
//
// Only a bare `cat` reading stdin. Every flag it takes rewrites the lines it
// prints (`-n` numbers them, `-s` squeezes blanks, `-A` spells out the
// invisible ones), and a `cat` naming a file of its own is printing that file
// rather than passing the pipe along.
function isPassthrough(cmd: Command): boolean {
  const name = cmd.words[0]
  if (name.text !== 'cat' || name.quoted) return false
  return cmd.words.slice(1).every((w) => !w.quoted && w.text === '-')
}

// isLineFilter reports whether a command only DROPS lines from what the command
// before it printed, leaving the ones it keeps byte for byte - `| grep -v test/`,
// `| grep import`. Agents write these constantly (`grep -rn X src | grep -v
// _test.go | head -20`), and each one used to cost the whole step its
// highlighting even though every line that survives is still a line of the file
// the search before it named.
//
// It is the same parse as a searching grep, held to one more condition: it names
// no file of its own, so what it read was the pipe. Whether it NUMBERS what it
// keeps is handed back rather than refused, because those numbers count lines of
// the STREAM - which is the file's own numbering when, and only when, the stream
// is a whole file (see classify).
function isLineFilter(cmd: Command): { numbered: boolean } | null {
  const grep = parseMatches(cmd.words)
  // A `| grep -c` counts what it was given rather than dropping lines from it,
  // and `| grep -l` names a file rather than keeping any of them.
  return grep !== null && grep.fileCount === 0 && !grep.summary ? { numbered: grep.numbered } : null
}

// `sort` flags that make it print something other than the lines it was given:
// a set (dropping duplicates), a verdict about the order, a NUL-separated
// stream, output redirected to a file.
const SORT_REFUSED = /^(-u|--unique|-c|-C|--check(=.*)?|-z|--zero-terminated|-o|--output(=.*)?|-m|--merge)$/

// isReorderFilter reads a `| sort -rh`: every line the command before it printed,
// byte for byte, in a different ORDER.
//
// That is only harmless for output whose lines stand on their own - which is
// exactly why it is refused below for a file view (line 3 of a sorted stream is
// not line 3 of anything) and for a git report (whose shapes are read in the
// order git wrote them), and allowed for a `du`, where each line already carries
// both of the things it is about, and for a search, where every line carries its
// own file and number.
//
// It must also name no file of its own: a `sort f` is reading that file rather
// than the pipe.
function isReorderFilter(cmd: Command): boolean {
  const name = cmd.words[0]
  if (name.text !== 'sort' || name.quoted) return false
  return cmd.words.slice(1).every((w) => !w.quotedStart && w.text.startsWith('-') && !SORT_REFUSED.test(w.text))
}

// isRangeFilter reads a `| sed -n '449,466p'`: a contiguous slice of what the
// command before it printed, taken by line number. Like isLineFilter, it must
// name no file of its own.
function isRangeFilter(cmd: Command): { start: number; end: number | null } | null {
  const name = cmd.words[0]
  if (name.text !== 'sed' || name.quoted) return null
  const args = cmd.words.slice(1)
  if (args[0]?.text !== '-n') return null
  const rest = args[1]?.text === '-e' ? args.slice(2) : args.slice(1)
  if (rest.length !== 1 || rest[0].dynamic) return null
  return parseSedRange(rest[0].text)
}

// wholeFile reports whether a view is the file from its first line with no end -
// a `cat f`, a `git show rev:f`. That is what makes a filter's own line numbers,
// or the range it slices out, line up with the file's.
function wholeFile(view: FileView): boolean {
  return view.start === 1 && view.end == null && !view.numbered && !view.ranges
}

// tighter is the smaller of two upper bounds, where null is "no bound".
function tighter(a: number | null, b: number | null): number | null {
  if (a == null) return b
  return b == null ? a : Math.min(a, b)
}

// pipelineCap is the most lines a pipeline can print when one of the filters at
// the end of it is a `head`/`tail` with a count - whatever the command at the
// FRONT of it was, and whether or not this module can say anything about it.
//
// This is the only bound there is for a step it cannot describe at all, and that
// is the whole reason it is worth having: a script ending
// `git log --oneline -3; mage build 2>&1 | tail -2` has no separator in it and
// no shape the split can find, so the two lines of build output at the bottom
// used to take the three commit lines above them down with them into one plain
// block. Two lines is all the split needed to know.
//
// The other filters drop lines without adding any, so a `| tail -5 | grep x`
// still prints at most five; anything that is not a filter ends the walk,
// because what it prints is its own.
function pipelineCap(cmds: Command[]): number | null {
  let cap: number | null = null
  for (let i = cmds.length - 1; i > 0; i--) {
    const trim = isFilter(cmds[i])
    if (trim) { cap = tighter(cap, trim.count); continue }
    if (!isPassthrough(cmds[i]) && !isLineFilter(cmds[i]) && !isRangeFilter(cmds[i]) && !isReorderFilter(cmds[i])) break
  }
  return cap
}

// Everything a `git log` prints MORE of per commit, which takes the count below
// back: a patch, a diffstat, a signature, the `--graph` topology (whose edges get
// lines of their own between the commits), the machine-readable listings.
const LOG_EXTRA = /^(-p|-u|--patch|--patch-with-stat|--stat(=.*)?|--shortstat|--graph|--cc|--numstat|--name-only|--name-status|--show-signature|--notes(=.*)?)$/
// `-3`, `-n3`, `--max-count=3`. The two-word spellings (`-n 3`,
// `--max-count 3`) are read beside this.
const LOG_COUNT = /^-(\d+)$|^-n(\d+)$|^--max-count=(\d+)$/

// gitReportLimit is the most lines a git call's own arguments say it can print.
//
// One shape qualifies: `git log --oneline -3`, which is one line per commit and
// at most three commits - the thing an agent puts at the top of a script to say
// where it is. Everything else git reports is as long as the repository makes
// it, and a count over a format that spends several lines on a commit bounds
// commits rather than lines.
function gitReportLimit(words: Word[]): number | null {
  let i = 1
  while (i < words.length && !words[i].quoted && words[i].text.startsWith('-')) {
    if (words[i].text === '-C' || words[i].text === '-c') i++
    i++
  }
  if (words[i]?.quoted || words[i]?.text !== 'log') return null
  const args = words.slice(i + 1)
  const flag = (w: Word) => (w.quoted ? '' : w.text)
  if (!args.some((w) => flag(w) === '--oneline')) return null
  if (args.some((w) => LOG_EXTRA.test(flag(w)))) return null
  let count: number | null = null
  for (let j = 0; j < args.length; j++) {
    const m = LOG_COUNT.exec(flag(args[j]))
    if (m) { count = Number(m[1] ?? m[2] ?? m[3]); continue }
    if (flag(args[j]) === '-n' || flag(args[j]) === '--max-count') {
      const value = args[++j]
      // A count this parser cannot read leaves the call unbounded rather than
      // bounded by whatever the LAST `-n` on the line happened to be.
      if (!value || value.dynamic || !/^\d+$/.test(value.text)) return null
      count = Number(value.text)
    }
  }
  return count
}

// classify decides what one pipeline contributes to the output, and how many
// lines the script says that can be (see ScriptStep.cap).
function classify(p: Pipeline): ScriptStep {
  const step = classifyKind(p)
  // A git report's own bound is only claimed when the step really is that
  // report: a `| sort` or a `| wc -l` in front of it makes the output something
  // else, and `classifyKind` has already said so by handing back a kind that is
  // not 'git'.
  const own = step.kind === 'git' ? gitReportLimit(p.cmds[0].words) : null
  const cap = tighter(pipelineCap(p.cmds), own)
  return cap == null ? step : { ...step, cap }
}

function classifyKind(p: Pipeline): ScriptStep {
  // Trailing filters cut lines out of what the command before them printed; they
  // do not change what the lines ARE, so `grep -n x f | grep -v y | head` is
  // still that grep's matches.
  let cmds = p.cmds
  let trimmedFrom: 'head' | 'tail' | null = null
  let filtered = false
  // A filter that numbered what it kept, or sliced a range out of it. Both only
  // mean anything against a whole-file producer, and are refused below when the
  // producer is not one.
  let numbered = false
  let sliced: { start: number; end: number | null } | null = null
  // A `| sort`: the same lines, in an order the producer did not choose.
  let reordered = false
  while (cmds.length > 1) {
    const last = cmds[cmds.length - 1]
    const trim = isFilter(last)
    const line = isLineFilter(last)
    const range = isRangeFilter(last)
    if (trim) trimmedFrom = trim.end
    else if (isReorderFilter(last)) reordered = true
    // A passthrough drops nothing, so it is not even a trim: `git log | cat`
    // is that log, and `sed -n 1,20p f | cat` is still lines 1 to 20 of f.
    else if (isPassthrough(last)) { /* nothing to record */ }
    else if (line) { filtered = true; numbered ||= line.numbered }
    // Only ever one of these, and nothing may follow it: a second range would
    // be counted against the first one's output rather than the file.
    else if (range && !sliced && !filtered && !trimmedFrom) sliced = range
    else break
    cmds = cmds.slice(0, -1)
  }
  if (cmds.length !== 1) return { kind: 'unknown', command: p.raw }
  const cmd = cmds[0]
  if (cmd.words.length === 0) return { kind: 'silent' }
  const name = cmd.words[0]
  // stdout went to a file, so nothing of this reaches the transcript.
  if (cmd.redirected) return { kind: 'silent' }
  if (!name.quoted && (SILENT.has(name.text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(name.text))) return { kind: 'silent' }

  const unknown: ScriptStep = { kind: 'unknown', command: p.raw }

  const echo = parseConstantLine(cmd.words)
  if (echo !== null && !trimmedFrom && !filtered && !sliced) {
    return echo.trim().length >= MIN_MARKER_LEN ? { kind: 'marker', text: echo } : { kind: 'echo', text: echo }
  }

  const matches = parseMatches(cmd.words)
  // A search's output is lines from all over a file, so a filter's own NUMBERS
  // describe the stream and nothing that could be pointed at. A range sliced out
  // of it is different: `rg -n pat f | sed -n 1,40p` only drops lines, and every
  // line that survives is still that file's, still carrying the number the
  // search printed in front of it.
  if (matches?.summary) {
    // Sorting or trimming a list of paths leaves each line saying exactly what
    // it said before; numbering it would put a count in front of a count.
    return numbered ? unknown : { kind: 'summary', summary: matches.summary, command: p.raw }
  }
  if (matches) {
    return numbered
      ? unknown
      : { kind: 'matches', match: { paths: matches.paths, numbered: matches.numbered }, command: p.raw }
  }

  // Every line of a disk listing stands on its own - a measurement and the thing
  // it measures - so it survives being sorted, trimmed and grepped. Only a
  // filter's own line numbers make it something else: they would ride in the
  // text as a `12:` prefix that lib/diskOutput has no shape for.
  const disk = diskTool(cmd.words)
  if (disk) return numbered ? unknown : { kind: 'disk', tool: disk, command: p.raw }

  // Everything below reads a FILE, or a report whose lines are read in the
  // order they were written; a sort makes neither of them what it says.
  if (reordered) return unknown

  // Asked BEFORE the git report below, because `git show <rev>:<path>` is the
  // one git command that prints a file rather than a report about one.
  if (!cmd.words.some((w) => w.dynamic)) {
    const view = parseView(cmd.words.map((w) => w.text), p.raw)
    if (view) {
      // A range sliced out of the stream is a range of the FILE - but only when
      // the stream WAS the whole file, since that is what makes line 449 of the
      // one line 449 of the other.
      if (sliced) {
        return wholeFile(view)
          ? { kind: 'view', view: { ...view, start: sliced.start, end: sliced.end } }
          : unknown
      }
      if (filtered) {
        // Grepped, so the lines that came through are no longer a contiguous
        // slice to number from `start` - but they are still that file's lines,
        // and still want its language.
        //
        // A `-n` on that grep numbered the stream, which is the file's own
        // numbering on a whole-file read and nothing at all otherwise. (`cat -n`
        // is the other way round: its numbers ride in the text, where nothing
        // downstream can read them back off.)
        if (view.numbered || (numbered && !wholeFile(view))) return unknown
        return { kind: 'matches', match: { paths: [view.path], numbered }, command: p.raw }
      }
      // A `| head` keeps the start of what was printed and drops the end; a
      // `| tail` keeps an end this parser cannot number. Against a view of
      // SEVERAL stretches neither can be numbered at all - which stretch the cut
      // fell in is exactly what is no longer knowable - so the step is one this
      // module declines to describe rather than one it describes wrongly.
      if (trimmedFrom && view.ranges) return unknown
      if (trimmedFrom === 'head') return { kind: 'view', view: { ...view, end: null } }
      if (trimmedFrom === 'tail') return { kind: 'view', view: { ...view, start: null, end: null } }
      return { kind: 'view', view }
    }
  }

  // A blame prints the file itself, one line at a time, behind a prefix saying
  // which commit last touched each - so it wants that file's language and its
  // own line numbers, not lib/gitOutput's report colours.
  if (!filtered && !sliced && !numbered) {
    const path = parseGitBlame(cmd.words)
    if (path !== null) return trimmedFrom ? unknown : { kind: 'blame', path, command: p.raw }
  }

  // Several files, whose banners say which stretch is which. Unlike a view this
  // tolerates a glob or a variable in the operands - what it needs is in the
  // OUTPUT - but not a filter, which could cut a stretch away from its banner.
  if (!trimmedFrom && !filtered && !sliced && !numbered) {
    const operands = cmd.words.slice(1).filter((w) => !w.text.startsWith('-') || w.quotedStart)
    const banner = parseBannerView(
      cmd.words.map((w) => w.text),
      cmd.words.some((w) => w.dynamic) ? null : operands.length,
    )
    if (banner) return { kind: 'banners', view: banner }
  }

  // A filter's line numbers would ride in the text as a `12:` prefix that
  // lib/gitOutput has no shape for.
  const git = parseGitReport(cmd.words)
  if (git === 'quiet') return { kind: 'silent' }
  if (git === 'report') return numbered ? unknown : { kind: 'git', command: p.raw }

  return unknown
}

// parseScriptSteps reads a whole Bash command as the sequence of steps it runs.
// Null when the script has nothing this module could describe - no marker, no
// file read, no search - so the caller keeps its plain output panel.
export function parseScriptSteps(script: string): ScriptStep[] | null {
  const pipelines = lexPipelines(script)
  if (!pipelines || pipelines.length === 0 || pipelines.length > MAX_STEPS) return null
  const steps = pipelines.map(classify)
  const describes = new Set(['marker', 'view', 'matches', 'git', 'disk', 'banners', 'blame', 'summary'])
  return steps.some((s) => describes.has(s.kind)) ? steps : null
}

// --- Diagnostics: the output no step printed ----------------------------------

// A tool complaining about what it was asked to do, in the shape the whole
// coreutils family writes it:
//
//   sed: can't read web/src/lib/fileIcons.ts: No such file or directory
//   rg: docs/missing.md: IO error for operation on docs/missing.md
//   /bin/bash: line 3: node: command not found
//
// These are the lines that make an errored command's output hard to attribute,
// and they are also the ones that can be told apart from it: they arrive on
// stderr wherever the failing command ran, they are no step's content, and the
// step that provoked one usually printed nothing else at all. So they are lifted
// OUT before the output is split up - which is what lets a command that failed be
// sectioned like any other - and rendered as the errors they are.
//
// The tool name is checked against the script's own commands, because the line
// alone cannot say: a `sed: ...` at the start of a line is a diagnostic under a
// script that ran sed and a line of somebody's YAML otherwise.
const DIAGNOSTIC = /^((?:[\w.+-]*\/)*([\w.+-]+))(?:: line \d+)?: \S/

// The shell is not one of the script's commands, but it is the thing that RAN
// them, and everything it says is about the script rather than about a file.
const SHELL = /^-?(?:bash|sh|dash|zsh|ksh|fish)$/

// stepTools collects the commands a script ran, by name, for the gate above.
// Every step carries the text it was parsed from, so this reads the name at the
// head of each `|`-separated piece of it - a diagnostic can come from any command
// in a pipeline, not just the one whose output was being described.
function stepTools(steps: ScriptStep[]): Set<string> {
  const out = new Set<string>()
  for (const step of steps) {
    const command = step.kind === 'view' ? step.view.command : 'command' in step ? step.command : ''
    for (const piece of command.split('|')) {
      // A leading `(`/`sudo `/`env X=1 ` is not what a diagnostic names itself
      // after; the first bare word is.
      const name = /^[\s(]*(?:(?:sudo|env|command|time|xargs)\s+)*([\w.+/-]+)/.exec(piece)?.[1]
      if (name) out.add(name.split('/').pop() ?? name)
    }
  }
  return out
}

// diagnosticLines marks which lines of the output are a tool talking about
// itself rather than a step's output.
//
// A line the script itself PRINTS is never one of them, however it reads: an
// `echo "sed: skipped"` is that echo, and taking it for stderr would cost the
// section it anchors its whole attribution.
function diagnosticLines(lines: string[], steps: ScriptStep[]): boolean[] {
  const tools = stepTools(steps)
  const printed = new Set(
    steps.flatMap((s) => (s.kind === 'marker' || s.kind === 'echo' ? s.text.split('\n') : [])).map((l) => l.trimEnd()),
  )
  return lines.map((line, i) => {
    if (printed.has(line.trimEnd())) return false
    // The harness's own notes (lib/buildOutput), each only where the tool result
    // puts it: the exit status above a failed command's output, the line that
    // stands in for output when there was none, and - after everything the
    // command printed - the note that the shell was put back where it started.
    if (i === 0 && (EXIT_STATUS.test(line) || (lines.length === 1 && NO_OUTPUT.test(line)))) return true
    if (i === lines.length - 1 && CWD_RESET.test(line)) return true
    const name = DIAGNOSTIC.exec(line)?.[2]
    return name != null && (tools.has(name) || SHELL.test(name))
  })
}

// failedSteps are the steps a diagnostic says printed nothing: it names the very
// file they were asked to read, so the file was not read.
//
// Without this a step that died is still expected to have printed something, and
// `distribute` hands it the lines of the step AFTER it - a `sed -n 1,60p missing`
// bounded to sixty lines takes the first sixty lines of whatever ran next, and
// renders them as a file they did not come from. That is the one way an errored
// output can be attributed WRONGLY rather than just plainly, so it is closed here
// rather than by declining to section the output at all.
//
// Only for a step that reads ONE named file. A search over two of them prints
// the matches from the one that exists and complains about the other, so the same
// diagnostic proves nothing about what it printed.
function failedSteps(steps: ScriptStep[], lines: string[], diag: boolean[]): Set<ScriptStep> {
  const said = lines.filter((_, i) => diag[i])
  const named = (path: string) => path !== '' && said.some((l) => l.includes(path))
  return new Set(steps.filter((step) => {
    if (step.kind === 'view') return named(step.view.path)
    if (step.kind === 'matches') return step.match.paths.length === 1 && named(step.match.paths[0])
    return false
  }))
}

// --- Splitting the output -----------------------------------------------------

function matchesAt(lines: string[], pos: number, expected: string[]): boolean {
  if (pos < 0 || pos + expected.length > lines.length) return false
  return expected.every((line, i) => lines[pos + i].trimEnd() === line.trimEnd())
}

// stepLimit is the most lines a step can have printed, or null when it is not
// bounded by anything the script says. A step the output says failed printed
// nothing, which is the tightest bound there is (see failedSteps).
//
// Two bounds meet here, and the tighter one wins: what the step's own KIND says
// (an `echo` prints its text, a `sed -n 1,20p` prints twenty lines), and what
// the script says about it from outside whatever it is (see ScriptStep.cap).
function stepLimit(step: ScriptStep, failed: ReadonlySet<ScriptStep>): number | null {
  if (failed.has(step)) return 0
  return tighter(step.cap ?? null, kindLimit(step))
}

function kindLimit(step: ScriptStep): number | null {
  if (step.kind === 'echo') return step.text.split('\n').length
  if (step.kind !== 'view') return null
  return viewLimit(step.view)
}

// echoLines is the exact output of a step whose text the script spells out, so
// the caller can check the lines it is about to hand over really are that step's.
function echoLines(step: ScriptStep): string[] | null {
  return step.kind === 'echo' ? step.text.split('\n') : null
}

// mergeStep is the ONE producer a neighbouring pair makes when the boundary
// between them is not knowable and no renderer wants it anyway - or null when the
// pair has to stay two.
//
// This is the difference between output whose every line stands on its own and
// output that is a stretch of a file. Two greps back to back are what an agent
// writes when the second asks a narrower question than the first, and every line
// either of them printed already says which file it came from (its own `path:`
// prefix, or the single file they named) - which is all the gutter and the
// highlighting read. The same holds for two git reports (lib/gitOutput reads the
// shape off the LINE - a status is a status wherever it was printed), for two
// measurements by the same tool, and for two searches summarising the same way.
// A file view is the opposite case: its lines are numbered from where the
// section starts, so merging two would number the second file's lines as the
// first one's.
//
// A search whose files this module could not enumerate (a glob, a variable)
// makes the merged path list unknown rather than contributing nothing: guessing
// the other's file for its lines would highlight them as the wrong language.
function mergeStep(prev: ScriptStep, step: ScriptStep): ScriptStep | null {
  if (prev.kind === 'matches' && step.kind === 'matches') {
    const known = prev.match.paths.length > 0 && step.match.paths.length > 0
    return {
      kind: 'matches',
      command: joinCommands(prev.command, step.command),
      match: {
        paths: known ? [...new Set([...prev.match.paths, ...step.match.paths])] : [],
        numbered: prev.match.numbered && step.match.numbered,
      },
    }
  }
  if (prev.kind === 'git' && step.kind === 'git') {
    return { kind: 'git', command: joinCommands(prev.command, step.command) }
  }
  // The tool is what says how to read a line of a listing, and the summary kind
  // what a number on one means, so those have to agree.
  if (prev.kind === 'disk' && step.kind === 'disk' && prev.tool === step.tool) {
    return { kind: 'disk', tool: prev.tool, command: joinCommands(prev.command, step.command) }
  }
  if (prev.kind === 'summary' && step.kind === 'summary' && prev.summary === step.summary) {
    return { kind: 'summary', summary: prev.summary, command: joinCommands(prev.command, step.command) }
  }
  return null
}

function joinCommands(prev: string, next: string): string {
  return `${prev}; ${next}`
}

// mergeProducers collapses each such run into one producer. Calling a pair like
// that unattributable cost BOTH of them their rendering over a boundary neither
// of them needed - a `git diff --stat` followed by a `git stash list` that found
// nothing had no boundary to find at all, and the diffstat lost git's colours.
//
// `failed` is the set of steps that printed nothing (see failedSteps), keyed by
// identity - so the merged step has to be entered into it, and only when BOTH
// halves died: one of them still printing something is a producer.
function mergeProducers(steps: ScriptStep[], failed: Set<ScriptStep>): ScriptStep[] {
  const out: ScriptStep[] = []
  for (const step of steps) {
    const prev = out[out.length - 1]
    const merged = prev ? mergeStep(prev, step) : null
    if (!merged) { out.push(step); continue }
    // The pair's bound is the two added up, and only when BOTH halves have one -
    // one unbounded half makes the pair unbounded, exactly as it would have on
    // its own.
    if (prev.cap != null && step.cap != null) merged.cap = prev.cap + step.cap
    if (failed.has(prev) && failed.has(step)) failed.add(merged)
    out[out.length - 1] = merged
  }
  return out
}

// searchExtent is how many lines at one END of a stretch carry the prefixes a
// search writes on its own output - `path:12:`, `12:`, `path:` - and so cannot
// have come from whatever ran on the other side of it.
//
// This is the one boundary in this module that comes from the OUTPUT's shape
// rather than from the script, and it is here because the script cannot say
// where it is: an `ls dir` followed by a `grep -rn x dir/*.ts` bounds neither
// producer, so both used to lose their attribution to one plain block even
// though every line of the search announces itself and no line of the `ls`
// does.
//
// Null when the search prints no prefix at all (one named file, no `-n`), which
// is exactly when there is nothing to tell the two apart by.
function searchExtent(step: ScriptStep, slice: string[], lo: number, hi: number, from: 'start' | 'end'): number | null {
  if (step.kind !== 'matches') return null
  const shapes: RegExp[] = []
  if (step.match.numbered) shapes.push(PATH_NUMBERED, NUMBERED)
  if (step.match.paths.length !== 1) shapes.push(PATH_ONLY)
  if (shapes.length === 0) return null
  // A `--` between context groups is the search's own, and carries no prefix.
  const owns = (line: string) => line.trim() === '--' || shapes.some((re) => re.test(line))
  let n = 0
  while (hi - lo - n > 0 && owns(slice[from === 'start' ? lo + n : hi - n - 1])) n++
  return n > 0 ? n : null
}

// A `wc` output row: right-aligned integer counts and a name. The counterpart of
// searchExtent's prefixes - a shape the OUTPUT carries that the script does not.
const WC_OUTPUT = /^\s*\d+(?:\s+\d+)*\s+\S/

// diskExtent is how many lines at one END of a stretch carry a disk listing's
// own shape - only `wc`'s, whose rows are plain integer counts and a name (the
// `total` among them). That is the wc counterpart of searchExtent: `wc -l a b`
// prints a row per file and a `total`, but a brace or glob operand hides HOW
// many files, so the script cannot bound it and the rows' own shape is what says
// where they stop and the next producer's output begins. Letting wc self-bound
// this way is also what pins the read after it (`wc ... && sed -n 1,60p f`), so
// that file gets its line-number gutter.
//
// The other disk tools are left out: a du size (`18G`), an ls mode line, a df
// row are looser shapes that a line of source can wander into, and they already
// have the merge and marker paths. A wc row's bare integers are tight enough,
// and the read that usually follows one is exactly what wants the boundary.
function diskExtent(step: ScriptStep, slice: string[], lo: number, hi: number, from: 'start' | 'end'): number | null {
  if (step.kind !== 'disk' || step.tool !== 'wc') return null
  let n = 0
  while (hi - lo - n > 0 && WC_OUTPUT.test(slice[from === 'start' ? lo + n : hi - n - 1])) n++
  return n > 0 ? n : null
}

// What one stretch of output was split into: the lines each producer printed,
// and - per producer - whether the FIRST of those lines is provably the first
// line it printed.
//
// The two are different questions, and only the second one licenses a gutter. A
// view is numbered from the start of the range it asked for, so a section that
// begins one line late numbers every line of a file wrongly and says so in the
// tooltip; the language it is highlighted as, by contrast, is the same either
// way. See `exact` below for what pins a start down.
interface Distribution {
  parts: string[][]
  pinned: boolean[]
  // Parts that must render as the plain terminal text they are: a run can be
  // bounded as a WHOLE while the boundaries inside it stay unknowable, and
  // saying so is what keeps a self-identifying neighbour (most often a trailing
  // `rg -n`) from being thrown away along with them.
  plain: Set<number>
  languageOnly: Set<number>
}

// All of these producers read source in one known language. Their boundary may
// be lost (most often because the result was truncated at the front), but
// colouring the combined text is still certain even though paths and gutters
// are not.
function commonViewLanguage(producers: ScriptStep[]): string | null {
  if (producers.length < 2 || producers.some((p) => p.kind !== 'view')) return null
  const languages = producers.map((p) => langFromPath((p as Extract<ScriptStep, { kind: 'view' }>).view.path))
  return languages[0] && languages.every((lang) => lang === languages[0]) ? languages[0] : null
}

function languageOnlyDistribution(producers: ScriptStep[], slice: string[]): Distribution | null {
  if (!commonViewLanguage(producers)) return null
  return {
    parts: producers.map((_, i) => i === 0 ? slice : []),
    pinned: producers.map(() => false),
    plain: new Set(),
    languageOnly: new Set([0]),
  }
}

// distribute hands a stretch of output to the producers that ran inside it.
// Null when the boundaries between them are not knowable.
//
// Producers whose output the script bounds are peeled off BOTH ends - a
// `sed -n 1,20p` prints at most twenty lines, an `echo` prints exactly the line
// it was given - which leaves the one open-ended producer in the middle with
// what is between them. Both ends matter: an agent writing a sectioned script
// puts a spacing `echo` after each search as often as before it, and taking the
// leading end only meant that blank line cost the search above it its whole
// attribution.
//
// A search at either end is bounded too, by its own prefixes rather than by a
// count - see searchExtent.
function distribute(producers: ScriptStep[], slice: string[], failed: ReadonlySet<ScriptStep>): Distribution | null {
  if (producers.length === 0) return null
  if (producers.length === 1) return { parts: [slice], pinned: [true], plain: new Set(), languageOnly: new Set() }

  // Peel a search-shaped suffix before using any file-view limit. A sed range is
  // an UPPER bound, not an exact count: a range past the end of the file emits
  // fewer lines, and greedily taking the maximum made a preceding sed claim the
  // `path:line:` rows of a later rg. Those rows identify themselves, so the one
  // boundary the output really does carry is kept even when everything before it
  // has to stay one plain run.
  const suffix = searchExtent(producers[producers.length - 1], slice, 0, slice.length, 'end')
  // When every row carries its OWN path, the whole stretch is safely a search
  // result even if an intervening command printed nothing. Which search printed
  // which row is immaterial: the prefix names the file that supplies both the
  // gutter and the language. Do not extend this to bare `12:text` rows - there
  // the script's operand is the only thing naming the file, so handing an
  // earlier search to the last one could colour it as the wrong language.
  if (suffix === slice.length && slice.every((line) => line.trim() === '--' || PATH_NUMBERED.test(line))) {
    const last = producers.length - 1
    return {
      parts: producers.map((_, i) => i === last ? slice : []),
      pinned: producers.map((_, i) => i === last),
      plain: new Set(),
      languageOnly: new Set(),
    }
  }
  if (suffix != null && suffix < slice.length) {
    const last = producers.length - 1
    const before = distribute(producers.slice(0, last), slice.slice(0, -suffix), failed)
    const parts = producers.map(() => [] as string[])
    const pinned = producers.map(() => false)
    const plain = new Set<number>()
    const languageOnly = new Set<number>()
    if (before) {
      before.parts.forEach((part, i) => { parts[i] = part })
      before.pinned.forEach((p, i) => { pinned[i] = p })
      before.plain.forEach((i) => plain.add(i))
      before.languageOnly.forEach((i) => languageOnly.add(i))
    } else {
      // Several consecutive reads with no headings between them have no
      // recoverable boundary at all. Their combined output goes on the first
      // slot, rendered as the terminal text it is.
      parts[0] = slice.slice(0, -suffix)
      plain.add(0)
    }
    parts[last] = slice.slice(-suffix)
    // Every line of a search says which file and line it is; nothing about it is
    // counted from where the section starts.
    pinned[last] = true
    return { parts, pinned, plain, languageOnly }
  }

  const out: string[][] = producers.map(() => [])
  let lo = 0
  let hi = slice.length

  const bounds = producers.map((p) => stepLimit(p, failed))
  // Consecutive finite ranges are only separable when they all reached the end
  // they asked for. If their combined output is SHORTER, at least one stopped at
  // the end of its file and nothing in the output says which - so assigning each
  // one its maximum from the left is exactly the false boundary this module
  // exists not to draw.
  const capped = bounds.reduce<number | null>((sum, b) => (sum == null || b == null ? null : sum + b), 0)
  if (capped != null && slice.length < capped) return languageOnlyDistribution(producers, slice)
  // Whether the counts leave no room for a producer to have fallen short of its
  // range: every one of them bounded, and the bounds adding up to exactly what
  // came back. Short of that, a `sed -n 1,20p f` prints twenty lines or however
  // many f has and nothing in the output says which, so the peel below is the
  // likeliest split rather than the only one.
  //
  // Which producers' line count the output itself vouches for. Everything the
  // script only bounds from above starts out unvouched-for, and is set below
  // where something settles it: an `echo` whose text was found where it should
  // be, a step a diagnostic says printed nothing, a search whose own `path:`
  // prefixes say how far it reaches.
  const exact = producers.map(() => capped === slice.length)

  // An `echo` whose line is not where it should be printed nothing - it sat
  // behind a `||`, or its trailing blank was trimmed off the end of the output.
  // Its neighbour keeps the line rather than losing one to it.
  const fits = (step: ScriptStep, at: number): boolean => {
    const expected = echoLines(step)
    return !expected || matchesAt(slice, at, expected)
  }
  // Whether what was just peeled off an end is a COUNT the output vouches for
  // rather than the range the script asked for.
  const vouched = (step: ScriptStep, bound: number | null) =>
    bound == null || step.kind === 'echo' || failed.has(step)

  let head = 0
  for (; head < producers.length; head++) {
    const limit = bounds[head]
      ?? searchExtent(producers[head], slice, lo, hi, 'start')
      ?? diskExtent(producers[head], slice, lo, hi, 'start')
    if (limit == null) break
    const n = Math.min(limit, hi - lo)
    // Printed nothing, which is a count like any other.
    if (!fits(producers[head], lo)) { exact[head] = true; continue }
    out[head] = slice.slice(lo, lo + n)
    lo += n
    if (vouched(producers[head], bounds[head])) exact[head] = true
  }
  let tail = producers.length - 1
  for (; tail > head; tail--) {
    const limit = bounds[tail]
      ?? searchExtent(producers[tail], slice, lo, hi, 'end')
      ?? diskExtent(producers[tail], slice, lo, hi, 'end')
    if (limit == null) break
    const n = Math.min(limit, hi - lo)
    if (!fits(producers[tail], hi - n)) { exact[tail] = true; continue }
    out[tail] = slice.slice(hi - n, hi)
    hi -= n
    if (vouched(producers[tail], bounds[tail])) exact[tail] = true
  }
  // More than one producer with no bound of its own leaves a boundary nothing
  // in the script pins down - the common case, and why those separators matter.
  if (head < tail) return languageOnlyDistribution(producers, slice)
  // What is left in the middle goes to that one open-ended producer. When every
  // producer was bounded there is no such gap, and any surplus (an error, a
  // banner) rides with the last one that could have printed something the script
  // does not spell out.
  let rest = head === tail ? head : producers.length - 1
  while (rest > 0 && producers[rest].kind === 'echo') rest--
  out[rest] = out[rest].concat(slice.slice(lo, hi))
  // Whatever is left over is what this one printed, so its count is settled once
  // every other producer's is.
  if (exact.every((e, i) => e || i === rest)) exact[rest] = true
  // A producer's first line is where it says it is only if everything printed
  // before it in this stretch is accounted for exactly. The stretch's own start
  // is pinned: it is the output's, or the separator the marker search matched.
  return {
    parts: out,
    pinned: producers.map((_, i) => exact.every((e, j) => j >= i || e)),
    plain: new Set(),
    languageOnly: new Set(),
  }
}

// splitScriptOutput cuts a command's output into one section per step that
// printed it. Null when nothing came back worth sectioning.
//
// The constant line-printers are the anchors: each one's text is looked for in
// what is left of the output, and the lines before it belong to whatever ran in
// between. An
// anchor that never appears is skipped rather than fatal - a separator behind a
// `||` only prints when the command before it failed, and an agent writes those
// constantly - so a missing one costs a section its highlighting, not the split.
//
// Everything the SHELL and its tools said about themselves is taken out of the
// way first (see diagnosticLines) and put back afterwards as the errors it is.
// That is what makes this work on a command that failed - which is exactly the
// output an agent stares at hardest - rather than only on one that did not: the
// stderr an error adds is the one part of the output that can be told apart from
// the rest, since it announces which tool wrote it.
export function splitScriptOutput(steps: ScriptStep[], output: string): ScriptSection[] | null {
  const body = output.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (!body.trim()) return null
  // Colour a tool wrote for a terminal is not part of what it said: an escape
  // in the middle of a `grep --color` match would be highlighted as if it were
  // Go, and a coloured heading would not match the `echo` that printed it. So
  // everything below reads the STRIPPED lines, and the originals ride along for
  // the stretches that render as terminal text rather than as code.
  const coloured = hasAnsi(body)
  const rawAll = body.split('\n')
  const all = coloured ? rawAll.map(stripAnsi) : rawAll
  if (all.length > MAX_LINES) return null
  // Attribution runs over the output MINUS the diagnostics; `keep` is where each
  // of the lines it sees sat in the real output, which is what puts them back.
  const diag = diagnosticLines(all, steps)
  const keep = all.map((_, i) => i).filter((i) => !diag[i])
  const lines = keep.map((i) => all[i])
  const failed = failedSteps(steps, all, diag)
  const sections: ScriptSection[] = []
  let pending: ScriptStep[] = []
  let pos = 0
  // The lines as they arrived, for the slice `lines.slice(from, to)` covers.
  const rawSlice = (from: number, to: number) => (coloured ? keep.slice(from, to).map((i) => rawAll[i]) : undefined)

  const flush = (end: number) => {
    const slice = lines.slice(pos, end)
    const start = pos
    pos = end
    if (slice.length === 0) { pending = []; return }
    const producers = mergeProducers(pending, failed)
    const split = distribute(producers, slice, failed)
    if (!split) {
      sections.push({ kind: 'plain', lines: slice, raw: rawSlice(start, end) })
      pending = []
      return
    }
    const { parts, pinned, plain, languageOnly } = split
    // The parts partition the slice in order, so walking them keeps each one's
    // offset into the output - which is what pairs it with its raw lines.
    let at = start
    parts.forEach((part, i) => {
      const from = at
      at += part.length
      if (part.length === 0) return
      const rawPart = rawSlice(from, at)
      const step = producers[i]
      const limit = stepLimit(step, failed)
      // A run whose internal boundaries are not knowable renders as the terminal
      // text it is, whatever the steps inside it were.
      if (plain.has(i)) {
        sections.push({ kind: 'plain', lines: part, raw: rawPart })
        return
      }
      // More lines than the range could have produced (an error, a banner, a
      // marker that did not fire) means this is not what the parse thinks it is.
      if (step.kind === 'view' && (limit == null || part.length <= limit)) {
        // These are that file's lines either way; WHICH of its lines they are is
        // only knowable when nothing before them in the stretch could have
        // printed one line more or fewer (see Distribution.pinned). So an
        // unpinned view keeps its language and gives up its gutter, rather than
        // numbering a file's lines from a start that is a guess.
        const view = pinned[i]
          ? step.view
          : { ...step.view, start: null, end: null, ranges: undefined, ...(languageOnly.has(i) && { numbered: false, languageOnly: true }) }
        sections.push({ kind: 'view', view, lines: part, raw: rawPart })
      } else if (step.kind === 'echo' && part.length <= (limit ?? 0)) {
        // The script says what these lines are, so they render as the string it
        // printed - the same as the separators long enough to anchor on.
        sections.push({ kind: 'marker', lines: part, raw: rawPart })
      } else if (step.kind === 'matches') {
        sections.push({ kind: 'matches', match: step.match, command: step.command, lines: part, raw: rawPart })
      } else if (step.kind === 'git') {
        sections.push({ kind: 'git', command: step.command, lines: part, raw: rawPart })
      } else if (step.kind === 'summary') {
        sections.push({ kind: 'summary', summary: step.summary, command: step.command, lines: part, raw: rawPart })
      } else if (step.kind === 'blame') {
        sections.push({ kind: 'blame', path: step.path, command: step.command, lines: part, raw: rawPart })
      } else if (step.kind === 'disk') {
        sections.push({ kind: 'disk', tool: step.tool, command: step.command, lines: part, raw: rawPart })
      } else if (step.kind === 'banners') {
        sections.push({ kind: 'banners', view: step.view, lines: part, raw: rawPart })
      } else {
        sections.push({ kind: 'plain', lines: part, raw: rawPart })
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
      const limit = stepLimit(s, failed)
      return sum == null || limit == null ? null : sum + limit
    }, 0)
    let at = total != null && matchesAt(lines, pos + total, expected) ? pos + total : -1
    for (let j = pos; at < 0 && j + expected.length <= lines.length; j++) {
      if (matchesAt(lines, j, expected)) at = j
    }
    if (at < 0) continue // this one never printed
    flush(at)
    sections.push({
      kind: 'marker',
      lines: lines.slice(at, at + expected.length),
      raw: rawSlice(at, at + expected.length),
    })
    pos = at + expected.length
  }
  flush(lines.length)

  const spliced = spliceDiagnostics(sections, keep, all, coloured ? rawAll : undefined)
  return spliced.some((s) => s.kind !== 'plain') ? spliced : null
}

// Section kinds whose line NUMBERS come from where a line sits in the section
// rather than from the line itself. Cutting one in two would restart a file's
// numbering part way down it, so a diagnostic that landed INSIDE one costs that
// section its attribution instead (rather than costing it its honesty).
const POSITIONAL = new Set(['view', 'banners'])

// spliceDiagnostics puts the lines that were held back for being a tool's own
// error message back where they came from, as sections of their own.
//
// The sections handed in partition the output MINUS those lines, in order, so
// `keep` maps each one back to where it really sat: a section whose original
// indices run on consecutively had nothing taken out of it, and a break in them
// is exactly where a diagnostic interrupted that producer.
function spliceDiagnostics(
  sections: ScriptSection[],
  keep: number[],
  all: string[],
  rawAll: string[] | undefined,
): ScriptSection[] {
  if (keep.length === all.length) return sections
  const out: ScriptSection[] = []
  const errors = (from: number, to: number) => {
    if (to > from) out.push({ kind: 'error', lines: all.slice(from, to), raw: rawAll?.slice(from, to) })
  }
  const piece = (section: ScriptSection, from: number, to: number, plain: boolean): ScriptSection => {
    const lines = section.lines.slice(from, to)
    const raw = section.raw?.slice(from, to)
    return plain ? { kind: 'plain', lines, raw } : { ...section, lines, raw }
  }

  let at = 0 // where in the filtered lines this section started
  let last = -1 // the last original line already accounted for
  for (const section of sections) {
    const origin = keep.slice(at, at + section.lines.length)
    at += section.lines.length
    if (origin.length === 0) continue
    errors(last + 1, origin[0])
    last = origin[origin.length - 1]
    const cuts = origin.flatMap((line, i) => (i > 0 && line !== origin[i - 1] + 1 ? [i] : []))
    if (cuts.length === 0) { out.push(section); continue }
    const plain = POSITIONAL.has(section.kind)
    let from = 0
    for (const cut of [...cuts, origin.length]) {
      out.push(piece(section, from, cut, plain))
      if (cut < origin.length) errors(origin[cut - 1] + 1, origin[cut])
      from = cut
    }
  }
  errors(last + 1, all.length)
  return out
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

// Whether two search rows are adjacent source lines and may safely be handed to
// a stateful syntax highlighter as one run. Search results are usually sparse:
// treating line 3 and line 18 of a Markdown file as neighbours lets an opening
// `**` whose close was on omitted line 4 leak into line 18. With no numbers the
// gap is unknowable, so retain the existing grouping; the highlighter then has
// no more reliable boundary to follow.
export function consecutiveMatchLines(prev: MatchLine, next: MatchLine): boolean {
  if (prev.path !== next.path) return false
  if (!prev.num || !next.num) return true
  return Number(next.num) === Number(prev.num) + 1
}

// grep writes `NNN:` before a matched line and `NNN-` before a context line
// (-A/-B/-C), and puts `path:` in front of both when it searched more than one
// file - with the SAME separator it used after the number, so a context line
// reads `path-164-text` and not `path:164-text`.
//
// Hence the backreference, and the lazy path: `my-file.go-164-  x := 1` has to
// split at the separator that comes before the number, not at a dash inside the
// filename or inside the code. A `-A 30` prints thirty context lines per match,
// so reading only the `path:` form left the majority rule below with nothing.
const NUMBERED = /^(\d+)[:-](.*)$/
const PATH_NUMBERED = /^([^:\s][^:]*?)([:-])(\d+)\2(.*)$/
const PATH_ONLY = /^([\w./~@+-]*[/.][\w./~@+-]*):(.*)$/

// namesOneFile reports whether the search's operands pin every line it printed
// to ONE file, which is what makes a leading `path:` on a line something to be
// suspicious of - it is far more likely a colon in that file's own text.
//
// One operand is not enough to conclude it: `rg pat internal/` and
// `grep -rn foo src` each name exactly one thing, search a whole tree under it
// and print a `path:` in front of every line. So the operand also has to LOOK
// like a file - a basename carrying an extension - which is the most a parser
// that never touches a filesystem can ask.
function namesOneFile(paths: string[]): boolean {
  return paths.length === 1 && /\.[^./]+$/.test(paths[0].split('/').pop() ?? '')
}

// A time of day at the head of a line, which is what a log puts there.
//
// `15:13:42 STALL: io full` splits into a `15:` path and a `13:` number as
// readily as a real `path:12:` prefix does, and comes out as line 13 of a file
// called 15 - so a line that opens with a clock carries no prefix. Only asked
// when the search did NOT ask for numbers: a `-n` says the leading number IS the
// line's, and `12:15:13:42 done` is then line 12 of a log, not a clock.
const CLOCK = /^\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\b/

// parseMatchLines reads the prefixes off a search's output. The SHAPE is taken
// from the lines themselves rather than from the flags, because the same tool
// prints different ones (`rg` numbers its output for a terminal and not for a
// pipe) and because a wrong guess here is visible: the number in the gutter
// would not be the number in the file.
//
// A majority has to agree on one shape before it is applied - the odd line that
// does not fit (a truncation notice, a warning on stderr) then renders bare
// rather than dragging the whole section down with it.
//
// The two NUMBERED shapes are counted together, because they are the same output
// with and without the file named and one section really does carry both: an
// agent's second search names one file (so grep prints `12:`) where the first
// named several (so it prints `path:12:`), and a section is what holds the pair.
// So a majority carrying EITHER is enough, and each line is then asked which of
// the two it is - a bare `12:` cannot be read as a path prefix and a
// `path:12:` cannot be read as a bare one, so there is nothing to confuse.
export function parseMatchLines(lines: string[], paths: string[], asked = true): MatchLine[] {
  const bare = (text: string): MatchLine => ({ path: '', num: '', text, separator: false })
  const body = lines.filter((l) => l.trim() !== '--' && l !== '')
  const majority = (test: (line: string) => boolean) =>
    body.length > 0 && body.filter(test).length > body.length / 2

  // A search that named ONE file prints no `path:` in front of anything, so a
  // line that looks like it carries one is carrying its own text: `12:15:13:42
  // done` is line 12 of a log, not line 15 of a file called 12. Same reasoning
  // as namesOneFile's, which the bare `path:` shape below already follows.
  const named = (line: string) => {
    if (namesOneFile(paths)) return null
    const m = PATH_NUMBERED.exec(line)
    // A path of nothing but digits is a line number that met another one.
    return m && !/^\d+$/.test(m[1]) ? m : null
  }
  // `asked` is whether the search asked for line numbers (`-n`). It did not
  // settle the shape - rg numbers its output for a terminal and not for a pipe,
  // so the lines are still what is read - but it settles how far to trust a
  // number found there: unasked-for, a leading `15:13:42` is a clock far more
  // often than it is line 13 of a file called 15.
  const numberedLine = (l: string) => (asked || !CLOCK.test(l)) && (NUMBERED.test(l) || named(l) !== null)
  const numbered = majority(numberedLine)
  const pathOnly = !numbered && !namesOneFile(paths) && majority((l) => PATH_ONLY.test(l))
  if (!numbered && !pathOnly) return lines.map(bare)

  return lines.map((line) => {
    if (line.trim() === '--') return { path: '', num: '', text: line, separator: true }
    if (numbered && !numberedLine(line)) return bare(line)
    if (numbered) {
      // A bare number cannot be read as a path prefix and a `path:12:` cannot be
      // read as a bare one, so there is nothing to choose between here.
      const n = NUMBERED.exec(line)
      if (n) return { path: '', num: n[1], text: n[2], separator: false }
      // PATH_NUMBERED's second group is the separator it matched, not content.
      const p = named(line)
      return p ? { path: p[1], num: p[3], text: p[4], separator: false } : bare(line)
    }
    const m = PATH_ONLY.exec(line)
    return m ? { path: m[1], num: '', text: m[2], separator: false } : bare(line)
  })
}
