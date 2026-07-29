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
// file line numbers it printed, a git report in git's own colours (lib/
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
import { hasAnsi, stripAnsi } from './ansi'
import type { DiskTool } from './diskOutput'
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

export type ScriptStep =
  // A constant `echo`: prints a known string, so it anchors the output.
  | { kind: 'marker'; text: string }
  // A constant `echo` whose text is too short to search the output for - most
  // often the bare `echo` agents put between their greps to space the output
  // out. It anchors nothing, but it still prints a known number of known lines,
  // which is enough to keep it from costing its neighbours their attribution.
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
    // A group runs commands this module is not going to describe, but it is ONE
    // producer's worth of output, so it is stepped over as a single opaque word
    // rather than costing the whole script its parse.
    if (ch === '(' || (ch === '{' && WORD_END.test(script[i + 1] ?? ' '))) {
      const end = skipGroup(script, i)
      if (end === -1) return null
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
// Cluster letters whose argument follows the cluster (`-m5` is not modelled).
const GREP_ARG_LETTERS = new Set(['e', 'f', 'm', 'A', 'B', 'C', 'd', 'g', 't', 'T'])

// parseEcho returns the text a bare `echo` prints, or null when the step is not
// one whose output is known in advance. Flags are refused: `-n` drops the
// trailing newline (so the next command continues on the same line) and `-e`
// expands escapes - either makes the printed text something other than this.
//
// A bare `echo` prints one empty line, so it returns '' - not null. Whether the
// text is long enough to SEARCH for is a separate question, asked in classify.
function parseEcho(words: Word[]): string | null {
  if (words[0].text !== 'echo' || words[0].quoted) return null
  const args = words.slice(1)
  if (args.some((w) => w.dynamic || /^-[neE]+$/.test(w.text))) return null
  return args.map((w) => w.text).join(' ')
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
  const tool = (['du', 'df', 'ls', 'stat'] as DiskTool[]).find((t) => t === name.text)
  if (!tool) return null
  const args = words.slice(1).filter((w) => !w.quoted)
  if (args.some((w) => DISK_REFUSED[tool].test(w.text))) return null
  if (tool === 'ls' && !args.some((w) => LS_LONG.test(w.text))) return null
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

// isFilter reports whether a command only trims what the command before it in
// the pipeline printed - `| head`, `| tail -20` with no file of its own.
function isFilter(cmd: Command): 'head' | 'tail' | null {
  const name = cmd.words[0].text
  if (name !== 'head' && name !== 'tail') return null
  return cmd.words.slice(1).every((w) => w.text.startsWith('-') && !w.quoted) ? name : null
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

// classify decides what one pipeline contributes to the output.
function classify(p: Pipeline): ScriptStep {
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
    if (trim) trimmedFrom = trim
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

  const echo = parseEcho(cmd.words)
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

// --- Splitting the output -----------------------------------------------------

function matchesAt(lines: string[], pos: number, expected: string[]): boolean {
  if (pos < 0 || pos + expected.length > lines.length) return false
  return expected.every((line, i) => lines[pos + i].trimEnd() === line.trimEnd())
}

// stepLimit is the most lines a step can have printed, or null when it is not
// bounded by anything the script says.
function stepLimit(step: ScriptStep): number | null {
  if (step.kind === 'echo') return step.text.split('\n').length
  if (step.kind !== 'view') return null
  return viewLimit(step.view)
}

// echoLines is the exact output of a step whose text the script spells out, so
// the caller can check the lines it is about to hand over really are that step's.
function echoLines(step: ScriptStep): string[] | null {
  return step.kind === 'echo' ? step.text.split('\n') : null
}

// mergeSearches collapses a run of searches with nothing between them into one
// producer. Where one grep's matches stop and the next one's start is not
// knowable - but a search's rendering does not depend on it. Every line already
// says which file it came from (its own `path:` prefix, or the single file the
// searches all named), and that is all the gutter and the highlighting read. Two
// greps back to back are what an agent writes when the second one asks a
// narrower question than the first, and calling that pair unattributable cost
// BOTH of them their line numbers over a boundary neither renderer wanted.
//
// A search whose files this module could not enumerate (a glob, a variable)
// makes the merged path list unknown rather than contributing nothing: guessing
// the other's file for its lines would highlight them as the wrong language.
function mergeSearches(steps: ScriptStep[]): ScriptStep[] {
  const out: ScriptStep[] = []
  for (const step of steps) {
    const prev = out[out.length - 1]
    if (step.kind !== 'matches' || prev?.kind !== 'matches') { out.push(step); continue }
    const known = prev.match.paths.length > 0 && step.match.paths.length > 0
    out[out.length - 1] = {
      kind: 'matches',
      command: `${prev.command}; ${step.command}`,
      match: {
        paths: known ? [...new Set([...prev.match.paths, ...step.match.paths])] : [],
        numbered: prev.match.numbered && step.match.numbered,
      },
    }
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
function distribute(producers: ScriptStep[], slice: string[]): string[][] | null {
  if (producers.length === 0) return null
  if (producers.length === 1) return [slice]
  const out: string[][] = producers.map(() => [])
  let lo = 0
  let hi = slice.length

  // An `echo` whose line is not where it should be printed nothing - it sat
  // behind a `||`, or its trailing blank was trimmed off the end of the output.
  // Its neighbour keeps the line rather than losing one to it.
  const fits = (step: ScriptStep, at: number): boolean => {
    const expected = echoLines(step)
    return !expected || matchesAt(slice, at, expected)
  }

  let head = 0
  for (; head < producers.length; head++) {
    const limit = stepLimit(producers[head]) ?? searchExtent(producers[head], slice, lo, hi, 'start')
    if (limit == null) break
    const n = Math.min(limit, hi - lo)
    if (!fits(producers[head], lo)) continue
    out[head] = slice.slice(lo, lo + n)
    lo += n
  }
  let tail = producers.length - 1
  for (; tail > head; tail--) {
    const limit = stepLimit(producers[tail]) ?? searchExtent(producers[tail], slice, lo, hi, 'end')
    if (limit == null) break
    const n = Math.min(limit, hi - lo)
    if (!fits(producers[tail], hi - n)) continue
    out[tail] = slice.slice(hi - n, hi)
    hi -= n
  }
  // More than one producer with no bound of its own leaves a boundary nothing
  // in the script pins down - the common case, and why those separators matter.
  if (head < tail) return null
  // What is left in the middle goes to that one open-ended producer. When every
  // producer was bounded there is no such gap, and any surplus (an error, a
  // banner) rides with the last one that could have printed something the script
  // does not spell out.
  let rest = head === tail ? head : producers.length - 1
  while (rest > 0 && producers[rest].kind === 'echo') rest--
  out[rest] = out[rest].concat(slice.slice(lo, hi))
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
  // Colour a tool wrote for a terminal is not part of what it said: an escape
  // in the middle of a `grep --color` match would be highlighted as if it were
  // Go, and a coloured heading would not match the `echo` that printed it. So
  // everything below reads the STRIPPED lines, and the originals ride along for
  // the stretches that render as terminal text rather than as code.
  const coloured = hasAnsi(body)
  const raw = body.split('\n')
  const lines = coloured ? raw.map(stripAnsi) : raw
  if (lines.length > MAX_LINES) return null
  const sections: ScriptSection[] = []
  let pending: ScriptStep[] = []
  let pos = 0
  // The lines as they arrived, for the slice `lines.slice(from, to)` covers.
  const rawSlice = (from: number, to: number) => (coloured ? raw.slice(from, to) : undefined)

  const flush = (end: number) => {
    const slice = lines.slice(pos, end)
    const start = pos
    pos = end
    if (slice.length === 0) { pending = []; return }
    const producers = mergeSearches(pending)
    const parts = distribute(producers, slice)
    if (!parts) {
      sections.push({ kind: 'plain', lines: slice, raw: rawSlice(start, end) })
      pending = []
      return
    }
    // The parts partition the slice in order, so walking them keeps each one's
    // offset into the output - which is what pairs it with its raw lines.
    let at = start
    parts.forEach((part, i) => {
      const from = at
      at += part.length
      if (part.length === 0) return
      const rawPart = rawSlice(from, at)
      const step = producers[i]
      const limit = stepLimit(step)
      // More lines than the range could have produced (an error, a banner, a
      // marker that did not fire) means this is not what the parse thinks it is.
      if (step.kind === 'view' && (limit == null || part.length <= limit)) {
        sections.push({ kind: 'view', view: step.view, lines: part, raw: rawPart })
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
      const limit = stepLimit(s)
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
      : !namesOneFile(paths) && majority(PATH_ONLY)
        ? PATH_ONLY
        : null
  if (!shape) return lines.map(bare)

  return lines.map((line) => {
    if (line.trim() === '--') return { path: '', num: '', text: line, separator: true }
    const m = shape.exec(line)
    if (!m) return bare(line)
    if (shape === NUMBERED) return { path: '', num: m[1], text: m[2], separator: false }
    // PATH_NUMBERED's second group is the separator it matched, not content.
    if (shape === PATH_NUMBERED) return { path: m[1], num: m[3], text: m[4], separator: false }
    return { path: m[1], num: '', text: m[2], separator: false }
  })
}
