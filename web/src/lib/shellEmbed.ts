// Embedded-language awareness for shell highlighting.
//
// highlight.js' bash grammar has no idea that a shell script routinely carries
// another language inside it, and gets two very common shapes visibly wrong:
//
//   python3 -c "import json; print(json.dumps({}))"   <- one flat green string
//   cat << 'EOF'                                      <- body highlighted as BASH,
//   if you write "echo" or "if" here it goes purple      so prose lights up with
//   EOF                                                  shell keywords
//
// So before handing a shell snippet to highlight.js we scan it for those
// embedded regions (a heredoc body, or the quoted argument of an interpreter's
// inline-code flag), highlight each region with the language it actually is -
// or, when we can't name one, as a plain string - and highlight only the shell
// that is left over as bash.
//
// The scanner is deliberately a best-effort approximation of shell word
// splitting, not a real parser: it tracks quoting, comments, heredoc operators
// and command separators, which is enough for the shapes above and degrades to
// "no embeds found -> plain bash highlighting" on anything it doesn't recognise.
//
// INVARIANT: the rendered HTML's text content is exactly the input, character
// for character. The textarea overlay in lib/markdown renders a fenced block
// with this HTML directly behind a transparent textarea, so a single added or
// dropped character would drift the caret away from the visible text.
import { hasLanguage } from './prism'
import { highlightToHtml } from './prismHtml'
import { getLanguage, interpreterLanguage } from './language'
import {
  applyFlavourFlag, grepFlavour, isPatternFlag, regexTokens, takesArgument,
  type RegexFlavour,
} from './regexHighlight'

// Fence info strings / file languages this module takes over from plain bash.
// `shell` and `console` are deliberately excluded: those name the
// prompt-transcript grammar (`$ cmd` / output), not a script.
const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'ksh'])

export function isShellLanguage(lang: string): boolean {
  return SHELL_LANGS.has(lang.toLowerCase())
}

// Flags that make an interpreter take its program as the NEXT argument, keyed by
// the language the interpreter runs. Single-letter entries also match inside a
// cluster (`sh -lc`, `perl -pe`), which is how they are usually written.
const INLINE_CODE_FLAGS: Record<string, string[]> = {
  python: ['-c'],
  javascript: ['-e', '--eval', '-p', '--print'],
  typescript: ['-e', '--eval'],
  ruby: ['-e'],
  perl: ['-e', '-E'],
  php: ['-r'],
  lua: ['-e'],
  r: ['-e'],
  bash: ['-c'],
}

// Heredoc delimiters that name their content by convention. Only consulted when
// the command line itself says nothing (no interpreter, no redirect to a file
// with a known extension), so `cat <<'PY'` still colourises as Python.
const DELIM_LANGS: Record<string, string> = {
  PY: 'python', PYTHON: 'python',
  JS: 'javascript', JAVASCRIPT: 'javascript', NODE: 'javascript',
  TS: 'typescript', TYPESCRIPT: 'typescript',
  SQL: 'sql', JSON: 'json', YAML: 'yaml', YML: 'yaml', TOML: 'toml',
  HTML: 'xml', XML: 'xml', CSS: 'css',
  SH: 'bash', BASH: 'bash', SCRIPT: 'bash',
  RB: 'ruby', RUBY: 'ruby', GO: 'go', RS: 'rust', RUST: 'rust',
  MD: 'markdown', MARKDOWN: 'markdown', DIFF: 'diff', PATCH: 'diff',
  DOCKERFILE: 'dockerfile', MAKE: 'makefile',
}

// A region of a shell snippet that highlight.js' bash grammar must not see.
export interface ShellEmbed {
  // 'code'      - an interpreter's inline program: `python3 -c "..."`.
  // 'regex'     - a search command's pattern: `grep -rn 'a\|b' src`. Embedded in
  //   the same sense as the above - a language of its own inside a shell word -
  //   but rendered as a string with its machinery picked out (lib/regexHighlight)
  //   rather than by a grammar, so a pattern with no metacharacters in it still
  //   looks exactly like the string it looked like before.
  // 'heredoc'   - a heredoc body.
  // 'delimiter' - the `<<EOF` operator's delimiter word. Not embedded code, but
  //   carved out all the same: highlight.js' own heredoc rule (END_SAME_AS_BEGIN
  //   on `<<-?\s*(?=\w+)`) would start a string at an UNQUOTED delimiter and,
  //   with the body no longer in its input, run it to the end of the line -
  //   painting `<<PY > out.py` green. We colour the delimiter ourselves instead,
  //   the same way the grammar colours a quoted one.
  kind: 'code' | 'regex' | 'heredoc' | 'delimiter'
  // The whole region as it must be carved out of the bash stream, including any
  // delimiters (the quotes around a `-c` argument, the `<<-` operator).
  // `start..bodyStart` and `bodyEnd..end` are those delimiters.
  start: number
  bodyStart: number
  bodyEnd: number
  end: number
  // The embedded language, or null when we only know "this is inert text".
  lang: string | null
  // For a 'regex' embed: the dialect the command that carries it parses.
  flavour?: RegexFlavour
  // For a lang-less body: whether the shell would expand `$vars` inside it (an
  // unquoted heredoc delimiter). Quoted delimiters (<<'EOF') expand nothing.
  expand: boolean
}

interface PendingHeredoc {
  delim: string
  // `<<-` strips leading tabs, including on the terminator line.
  strip: boolean
  // Quoted delimiter (<<'EOF', <<"EOF", <<\EOF): the body is literal.
  quoted: boolean
}

// A bare (unquoted) heredoc delimiter must look like an identifier. This is what
// keeps an arithmetic left shift - `$(( 1 << 2 ))` - from being read as a
// heredoc that swallows the rest of the snippet.
const BARE_DELIM = /^[A-Za-z_][A-Za-z0-9_.-]*$/

// Characters that end an unquoted word.
const WORD_END = /[\s;|&<>()]/

// scanShellEmbeds finds the embedded-language regions of a shell snippet, in
// source order and never overlapping. Exported for tests.
export function scanShellEmbeds(code: string): ShellEmbed[] {
  const embeds: ShellEmbed[] = []
  const pending: PendingHeredoc[] = []
  const n = code.length
  // Interpreter of the simple command being scanned (reset at every separator),
  // used to recognise ITS inline-code flag.
  let cmdLang: string | null = null
  // Language expected as the next word, once that flag has been seen.
  let expectCode: string | null = null
  // Best guess for the whole current LINE, used for heredoc bodies (which only
  // start at the newline, by which point we have seen the whole line - including
  // a `| python3` after the operator, or a `> out.py` redirect).
  let lineLang: string | null = null
  // The previous token was a redirection operator, so the next word is a file.
  let redirect = false
  // The command being scanned is a search (grep, rg, ...): which dialect it
  // parses its pattern as - null once a `-F` says there is no regex in it - and
  // where in its arguments the pattern is.
  let searching = false
  let dialect: RegexFlavour | null = null
  let patternNext = false
  let patternDone = false
  let skipArg = false
  const endCommand = () => {
    cmdLang = null
    expectCode = null
    redirect = false
    searching = false
    dialect = null
    patternNext = false
    patternDone = false
    skipArg = false
  }
  let i = 0

  while (i < n) {
    const ch = code[i]

    if (ch === '\n') {
      i++
      for (const h of pending) {
        const body = heredocBody(code, i, h)
        if (body.bodyEnd > i) {
          embeds.push({
            kind: 'heredoc',
            start: i, bodyStart: i, bodyEnd: body.bodyEnd, end: body.bodyEnd,
            lang: lineLang ?? DELIM_LANGS[h.delim.toUpperCase()] ?? null,
            expand: !h.quoted,
          })
        }
        // The terminator word is coloured like the opening delimiter, so the two
        // ends of the heredoc read as a matching pair.
        if (body.termStart >= 0) {
          embeds.push({
            kind: 'delimiter',
            start: body.termStart, bodyStart: body.termStart, bodyEnd: body.termEnd, end: body.termEnd,
            lang: null, expand: false,
          })
        }
        i = body.next
      }
      pending.length = 0
      lineLang = null
      endCommand()
      continue
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue }

    // A `#` only opens a comment at the start of a word.
    if (ch === '#' && (i === 0 || WORD_END.test(code[i - 1]))) {
      const nl = code.indexOf('\n', i)
      i = nl === -1 ? n : nl
      continue
    }

    if (ch === '<') {
      if (code.startsWith('<<<', i)) { i += 3; continue } // here-string, not a heredoc
      if (code.startsWith('<<', i)) {
        const op = readHeredocOp(code, i)
        if (op) {
          pending.push(op.heredoc)
          embeds.push({
            kind: 'delimiter',
            start: i, bodyStart: op.delimStart, bodyEnd: op.next, end: op.next,
            lang: null, expand: false,
          })
          i = op.next
          continue
        }
        i += 2
        continue
      }
      i++
      redirect = true
      continue
    }

    if (ch === '>') { i++; redirect = true; continue }

    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      i++
      endCommand()
      continue
    }

    // The inline-code argument itself: `python3 -c "..."`. Taken only in quoted
    // form - that is how it is always written, and it gives us exact bounds even
    // when the code inside contains spaces, newlines or shell metacharacters.
    if (expectCode && (ch === "'" || ch === '"')) {
      const close = closingQuote(code, i)
      const end = close === -1 ? n : close + 1
      const bodyEnd = close === -1 ? n : close
      if (bodyEnd > i + 1) {
        embeds.push({ kind: 'code', start: i, bodyStart: i + 1, bodyEnd, end, lang: expectCode, expand: false })
      }
      expectCode = null
      i = end
      continue
    }

    const at = i
    const word = readWord(code, i)
    i = word.end
    expectCode = null
    if (redirect) {
      redirect = false
      const fileLang = getLanguage(word.literal)
      if (fileLang !== 'plaintext') lineLang ??= fileLang
      continue
    }
    if (cmdLang && isInlineCodeFlag(word.literal, cmdLang)) {
      expectCode = cmdLang
      continue
    }

    // Which of a search's words is its pattern. Anything that is not a flag,
    // and not a flag's value, is the first operand - which IS the pattern
    // unless a `-e` already named one.
    if (searching && !patternDone) {
      const flag = !word.quoted && word.literal.length > 1 && word.literal.startsWith('-')
      if (skipArg) skipArg = false
      else if (!patternNext && flag) {
        const next = applyFlavourFlag(word.literal)
        if (next !== undefined) dialect = next
        if (isPatternFlag(word.literal)) patternNext = true
        else if (takesArgument(word.literal)) skipArg = true
      } else {
        patternNext = false
        patternDone = true
        // Taken only in quoted form, exactly as an interpreter's inline code is:
        // that is how a pattern with anything in it is always written, and it is
        // what gives the region exact bounds.
        const quote = code[at]
        const close = quote === "'" || quote === '"' ? closingQuote(code, at) : -1
        if (dialect && close > at + 1 && close + 1 === word.end) {
          embeds.push({
            kind: 'regex',
            start: at, bodyStart: at + 1, bodyEnd: close, end: word.end,
            lang: null, expand: false, flavour: dialect,
          })
        }
      }
      continue
    }

    // A quoted word is data, not a command name, so `echo "python3"` doesn't
    // arm interpreter detection.
    if (!word.quoted) {
      const interp = interpreterLanguage(word.literal)
      if (interp) {
        cmdLang = interp
        lineLang ??= interp
      }
      const flavour = grepFlavour(word.literal)
      if (flavour) {
        searching = true
        dialect = flavour
      }
    }
  }

  return embeds
}

// isInlineCodeFlag reports whether a word is the "program follows" flag of the
// given interpreter, either on its own (`-c`) or as the last letter of a short
// flag cluster (`-lc`, `-pe`).
function isInlineCodeFlag(word: string, lang: string): boolean {
  const flags = INLINE_CODE_FLAGS[lang]
  if (!flags) return false
  if (flags.includes(word)) return true
  if (!/^-[A-Za-z]+$/.test(word)) return false
  return flags.some((f) => f.length === 2 && !f.startsWith('--') && word.endsWith(f[1]))
}

// readHeredocOp parses a `<<` / `<<-` operator and its delimiter, returning null
// when what follows isn't a plausible heredoc (so `$(( 1 << 2 ))` is left alone).
// `delimStart` is where the delimiter word (quotes and all) begins, `next` where
// scanning resumes after it.
function readHeredocOp(code: string, at: number): { heredoc: PendingHeredoc; delimStart: number; next: number } | null {
  const n = code.length
  let j = at + 2
  let strip = false
  if (code[j] === '-') { strip = true; j++ }
  while (code[j] === ' ' || code[j] === '\t') j++
  const delimStart = j
  let quoted = false
  let delim = ''
  const q = code[j]
  if (q === "'" || q === '"') {
    j++
    quoted = true
    while (j < n && code[j] !== q) { delim += code[j]; j++ }
    if (j < n) j++
  } else {
    while (j < n && !WORD_END.test(code[j])) {
      if (code[j] === '\\' && j + 1 < n) { quoted = true; delim += code[j + 1]; j += 2; continue }
      delim += code[j]
      j++
    }
    if (!BARE_DELIM.test(delim)) return null
  }
  if (!delim) return null
  return { heredoc: { delim, strip, quoted }, delimStart, next: j }
}

// heredocBody finds where a heredoc body starting at `from` ends: at the line
// that is exactly the delimiter, or at end of input when there is none (a
// truncated or still-streaming snippet). `termStart`/`termEnd` bound the
// terminator word itself (-1 when there is none) and `next` is where scanning
// resumes - after the terminator line, which is shell again.
function heredocBody(
  code: string,
  from: number,
  h: PendingHeredoc,
): { bodyEnd: number; termStart: number; termEnd: number; next: number } {
  const n = code.length
  let pos = from
  while (pos < n) {
    const nl = code.indexOf('\n', pos)
    const lineEnd = nl === -1 ? n : nl
    const raw = code.slice(pos, lineEnd)
    const indent = h.strip ? (/^\t*/.exec(raw)?.[0].length ?? 0) : 0
    if (raw.slice(indent).replace(/\r$/, '') === h.delim) {
      return { bodyEnd: pos, termStart: pos + indent, termEnd: pos + indent + h.delim.length, next: nl === -1 ? n : nl + 1 }
    }
    if (nl === -1) break
    pos = nl + 1
  }
  return { bodyEnd: n, termStart: -1, termEnd: -1, next: n }
}

interface Word {
  end: number
  // The word with its quotes removed - what the shell would pass as an argument.
  literal: string
  // Whether any part of it was quoted or backslash-escaped.
  quoted: boolean
}

// readWord consumes one shell word, tracking quoting so a separator inside
// quotes doesn't end it. Newlines inside a quoted run are part of the word - a
// multi-line "..." string is one word, exactly as the shell sees it.
function readWord(code: string, at: number): Word {
  const n = code.length
  let i = at
  let literal = ''
  let quoted = false
  while (i < n) {
    const ch = code[i]
    if (ch === '\\' && i + 1 < n) { literal += code[i + 1]; quoted = true; i += 2; continue }
    if (ch === "'" || ch === '"') {
      const close = closingQuote(code, i)
      literal += code.slice(i + 1, close === -1 ? n : close)
      quoted = true
      i = close === -1 ? n : close + 1
      continue
    }
    if (WORD_END.test(ch)) break
    literal += ch
    i++
  }
  // A zero-width word would loop forever; always consume at least one char.
  return { end: i > at ? i : at + 1, literal, quoted }
}

// closingQuote returns the index of the quote that closes the one at `at`, or -1
// when the string is unterminated. Inside double quotes a backslash escapes the
// next character; inside single quotes nothing does.
function closingQuote(code: string, at: number): number {
  const q = code[at]
  for (let i = at + 1; i < code.length; i++) {
    if (q === '"' && code[i] === '\\') { i++; continue }
    if (code[i] === q) return i
  }
  return -1
}

// --- Rendering ----------------------------------------------------------------

// escapeHtml matches highlight.js' own escaping so our spans and its spans carry
// identical text for the same source.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

const TOK_STRING = 'token string'
const TOK_VARIABLE = 'token variable'
const TOK_SUBST = 'token interpolation'
// A regex's own colours, over the string colour its inert text keeps: the
// structure reads as the operators it is, and a character class as a thing that
// stands for something the way a variable does. The backslash of an escaped
// literal is punctuation - deliberately the quietest of the three, since what it
// marks is a character that does nothing but match itself.
const TOK_META = 'token operator'
const TOK_CLASS = 'token variable'
const TOK_ESCAPE = 'token punctuation'

function span(cls: string, text: string): string {
  return text === '' ? '' : `<span class="${cls}">${escapeHtml(text)}</span>`
}

function highlightWith(code: string, lang: string): string {
  return highlightToHtml(code, lang) ?? escapeHtml(code)
}

// Expansions the shell performs inside an unquoted heredoc body. Coloured like
// Prism's own bash grammar colours them, so an interpolating heredoc reads as
// "text with holes in it" rather than a uniform block.
//
// Token classes are Prism's: `string` for the inert text, `variable` for a bare
// $NAME and `interpolation` for a command substitution, matching what Prism's
// bash and template-string grammars emit for the same shapes.
const EXPANSION = /\$\{[^}\n]*\}|\$\([^)\n]*\)|\$[A-Za-z_][A-Za-z0-9_]*|`[^`\n]*`/g

// stringBody renders a body we have no language for: one string run, with the
// shell's own expansions picked out when they would actually be expanded.
function stringBody(text: string, expand: boolean): string {
  if (!expand) return span(TOK_STRING, text)
  let out = ''
  let pos = 0
  EXPANSION.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EXPANSION.exec(text))) {
    out += span(TOK_STRING, text.slice(pos, m.index))
    out += span(m[0].startsWith('$(') || m[0].startsWith('`') ? TOK_SUBST : TOK_VARIABLE, m[0])
    pos = m.index + m[0].length
  }
  return out + span(TOK_STRING, text.slice(pos))
}

// regexBody renders a search pattern: still a string, with the parts that match
// something rather than being something picked out of it (lib/regexHighlight).
const REGEX_TOKENS = { meta: TOK_META, class: TOK_CLASS, escape: TOK_ESCAPE, literal: TOK_STRING }

function regexBody(text: string, flavour: RegexFlavour): string {
  let out = ''
  for (const token of regexTokens(text, flavour)) out += span(REGEX_TOKENS[token.kind], token.text)
  return out
}

function embedBody(body: string, e: ShellEmbed): string {
  if (e.kind === 'regex') return regexBody(body, e.flavour ?? 'bre')
  if (!e.lang) return stringBody(body, e.expand)
  // A shell-in-shell embed (`bash -c '...'`, `<<'SH'`) recurses, so a heredoc
  // nested inside an inline script still gets the same treatment.
  if (isShellLanguage(e.lang)) return highlightShell(body)
  // An unregistered language (a lazy grammar the worker hasn't loaded) falls
  // back to inert text - still better than colouring Python as bash.
  if (!hasLanguage(e.lang)) return stringBody(body, e.expand)
  return highlightWith(body, e.lang)
}

// highlightShell returns Prism-compatible token HTML for a shell snippet,
// with heredoc bodies and inline interpreter code highlighted as the language
// they really are. The shell between those regions is highlighted as bash, one
// chunk at a time - a construct that straddles an embedded region (rare: the
// region is a whole heredoc body or a whole quoted argument) loses its
// continuation, which is the price of not re-implementing the grammar.
export function highlightShell(code: string): string {
  const embeds = scanShellEmbeds(code)
  if (embeds.length === 0) return highlightWith(code, 'bash')
  let out = ''
  let pos = 0
  for (const e of embeds) {
    if (e.start < pos) continue // defensive: never emit a region twice
    out += pos < e.start ? highlightWith(code.slice(pos, e.start), 'bash') : ''
    // The quotes around an inline-code argument stay string-coloured, so the
    // embedded code reads as something held inside a shell string; the `<<-`
    // operator in front of a heredoc delimiter is plain shell punctuation.
    const delims = e.kind === 'delimiter' ? '' : TOK_STRING
    out += delims ? span(delims, code.slice(e.start, e.bodyStart)) : escapeHtml(code.slice(e.start, e.bodyStart))
    out += embedBody(code.slice(e.bodyStart, e.bodyEnd), e)
    out += delims ? span(delims, code.slice(e.bodyEnd, e.end)) : escapeHtml(code.slice(e.bodyEnd, e.end))
    pos = e.end
  }
  return out + (pos < code.length ? highlightWith(code.slice(pos), 'bash') : '')
}
