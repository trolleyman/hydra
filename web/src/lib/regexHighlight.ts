// Pick the machinery out of a regex, so a search pattern stops being one flat
// string.
//
// An agent's greps are the densest thing in a transcript:
//
//   grep -rn '"type": "\|terminalEvent\|\.Append(' internal/http/*.go
//
// and every character of that arrives the same colour, which hides the only
// question the reader has - where are the alternations? So this splits a pattern
// into the parts that MATCH SOMETHING (anchors, alternation, groups,
// quantifiers, character classes) and the parts that are just text.
//
// FLAVOUR IS THE WHOLE PROBLEM. `\|` is alternation in a POSIX basic regex - a
// bare `grep` - and a literal pipe in an extended one; `|` is the reverse. A
// highlighter that assumed JavaScript's dialect would paint the pattern above
// exactly backwards, which is worse than leaving it plain. So the caller must
// say which dialect the command it came from actually parses (lib/shellEmbed
// reads it off the command name and its flags), and `-F` / `fgrep`, where there
// is no regex at all, must not reach here.
//
// INVARIANT: the tokens concatenate back to the input, character for character.
// The caller is rendering them behind (or beside) the untouched source text.

export type RegexFlavour =
  // A bare `grep` or `sed`: POSIX basic. `\(`, `\|`, `\{` are the operators.
  | 'bre'
  // `grep -E`, `egrep`: POSIX extended. `(`, `|`, `{` are the operators.
  | 'ere'
  // `grep -P`, `rg`, `ag`: extended, plus the `\d`/`\b` shorthands and `(?:`.
  | 'pcre'

export interface RegexToken {
  text: string
  // 'literal' - matches itself, and reads as the string it is.
  // 'meta'    - structure: an anchor, an alternation, a group, a quantifier.
  // 'class'   - a set of characters: `[a-z]`, `\d`, `\w`.
  kind: 'literal' | 'meta' | 'class'
}

// The characters a basic regex needs a backslash in FRONT of to mean, and an
// extended one needs a backslash to NOT mean.
const BRE_ESCAPED_META = new Set(['(', ')', '{', '}', '|', '+', '?'])
const ERE_META = new Set(['(', ')', '{', '}', '|', '+', '?', '*', '.'])

// `\d`, `\w`, `\s` and the rest: a backslash followed by one of these is a set
// of characters or a position, not the character itself. GNU grep understands
// them in every flavour, which is why this is not gated on `pcre`.
const SHORTHAND = /[dDwWsSbBAzZ<>`']/

// pushes `text` as `kind`, merging into the previous token when it matches, so
// a run of ordinary characters is one span rather than one span per character.
function push(out: RegexToken[], text: string, kind: RegexToken['kind']): void {
  if (text === '') return
  const last = out[out.length - 1]
  if (last && last.kind === kind) last.text += text
  else out.push({ text, kind })
}

// readClass consumes a `[...]` set from `at`, or returns -1 when the bracket
// never closes - an unterminated `[` is a literal bracket, not a set that eats
// the rest of the pattern.
//
// The two shapes that trip a naive scan: a `]` FIRST in the set is a literal
// `]`, and a POSIX class (`[:alpha:]`) carries a `]` of its own inside.
function readClass(p: string, at: number): number {
  let i = at + 1
  if (p[i] === '^') i++
  if (p[i] === ']') i++
  while (i < p.length) {
    if (p[i] === '[' && p[i + 1] === ':') {
      const close = p.indexOf(':]', i + 2)
      if (close !== -1) { i = close + 2; continue }
    }
    if (p[i] === ']') return i + 1
    i++
  }
  return -1
}

// classTokens colours a set: the brackets and the negation are structure, what
// is between them is the characters it holds.
function classTokens(out: RegexToken[], body: string): void {
  const open = body.startsWith('[^') ? '[^' : '['
  push(out, open, 'meta')
  push(out, body.slice(open.length, -1), 'class')
  push(out, ']', 'meta')
}

// anchorsHere reports whether a `^` at `at` is an anchor rather than a literal
// caret. It is one at the start of the pattern and at the start of a branch or a
// group - which is exactly where a basic regex allows it, and a harmless subset
// of where an extended one does. The alternative, treating every `^` as an
// anchor, paints the caret in `"exit ^C"` as machinery.
function isAnchorStart(p: string, at: number): boolean {
  if (at === 0) return true
  const before = p.slice(0, at)
  return /(\\?[(|])$/.test(before)
}

// The mirror of it for `$`: an anchor at the end of the pattern or of a branch.
function isAnchorEnd(p: string, at: number): boolean {
  if (at === p.length - 1) return true
  return /^(\\?[)|])/.test(p.slice(at + 1))
}

// regexTokens splits a pattern into what matches something and what is just
// text. Never throws and never drops a character: anything it cannot account for
// stays literal.
export function regexTokens(pattern: string, flavour: RegexFlavour): RegexToken[] {
  const out: RegexToken[] = []
  const extended = flavour !== 'bre'
  let i = 0

  while (i < pattern.length) {
    const ch = pattern[i]

    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1]
      // In a basic regex the backslash is what MAKES an operator; in an extended
      // one it is what unmakes it.
      if (!extended && BRE_ESCAPED_META.has(next)) push(out, pattern.slice(i, i + 2), 'meta')
      else if (SHORTHAND.test(next)) push(out, pattern.slice(i, i + 2), 'class')
      // An escaped metacharacter is the character itself - `\.` is a full stop -
      // so it reads as the text it matches.
      else push(out, pattern.slice(i, i + 2), 'literal')
      i += 2
      continue
    }

    if (ch === '[') {
      const end = readClass(pattern, i)
      if (end !== -1) { classTokens(out, pattern.slice(i, end)); i = end; continue }
      push(out, ch, 'literal')
      i++
      continue
    }

    if (ch === '^') { push(out, ch, isAnchorStart(pattern, i) ? 'meta' : 'literal'); i++; continue }
    if (ch === '$') { push(out, ch, isAnchorEnd(pattern, i) ? 'meta' : 'literal'); i++; continue }

    // `*` quantifies in every flavour (except leading, where a basic regex reads
    // it as a literal asterisk); the rest are operators only when extended.
    if (ch === '*') { push(out, ch, i === 0 && !extended ? 'literal' : 'meta'); i++; continue }
    if (extended && ERE_META.has(ch)) {
      // `(?:`, `(?<name>`, `(?=` - the group's own modifier is part of it.
      if (ch === '(' && flavour === 'pcre' && pattern[i + 1] === '?') {
        const mod = /^\(\?(<[^>]*>|P<[^>]*>|[:=!>#]|<[=!])?/.exec(pattern.slice(i))
        if (mod) { push(out, mod[0], 'meta'); i += mod[0].length; continue }
      }
      push(out, ch, 'meta')
      i++
      continue
    }
    if (!extended && ch === '.') { push(out, ch, 'meta'); i++; continue }

    push(out, ch, 'literal')
    i++
  }

  return out
}

// Command names whose pattern argument is a regex, and which dialect of one.
// `fgrep` is deliberately absent: it has no regex to highlight.
const FLAVOURS: Record<string, RegexFlavour> = {
  grep: 'bre',
  egrep: 'ere',
  rg: 'pcre',
  ag: 'pcre',
  ack: 'pcre',
}

// Flags that change the dialect. `-F` turns the pattern into plain text, which
// is why this can answer null.
const FLAVOUR_FLAGS: Record<string, RegexFlavour | null> = {
  '-G': 'bre', '--basic-regexp': 'bre',
  '-E': 'ere', '--extended-regexp': 'ere',
  '-P': 'pcre', '--perl-regexp': 'pcre', '--pcre2': 'pcre',
  '-F': null, '--fixed-strings': null,
}

// grepFlavour is the dialect a search command parses its pattern as, or null
// when it is not a search or is matching fixed strings.
export function grepFlavour(name: string): RegexFlavour | null {
  return FLAVOURS[name] ?? null
}

// applyFlavourFlag folds one flag into the dialect. `undefined` back means the
// flag said nothing about it, so the caller keeps what it had. A cluster
// (`-rniE`) is read letter by letter, so the `E` in it still counts.
export function applyFlavourFlag(word: string): RegexFlavour | null | undefined {
  if (word in FLAVOUR_FLAGS) return FLAVOUR_FLAGS[word]
  if (!/^-[A-Za-z]+$/.test(word)) return undefined
  let next: RegexFlavour | null | undefined
  for (const letter of word.slice(1)) {
    const flag = `-${letter}`
    if (flag in FLAVOUR_FLAGS) next = FLAVOUR_FLAGS[flag]
  }
  return next
}

// Flags whose VALUE is the next word, so that word is not the pattern.
const ARG_FLAGS = new Set([
  '-m', '--max-count', '-A', '--after-context', '-B', '--before-context',
  '-C', '--context', '-d', '--devices', '--binary-files', '--include',
  '--exclude', '--exclude-dir', '--color', '--colour', '-g', '--glob',
  '-t', '--type', '-T', '--type-not', '--max-columns', '--sort', '--iglob',
  '--replace', '--regex-size-limit', '-f', '--file',
])
// The same, as the last letter of a cluster (`-rnA`). `r` is pointedly absent:
// on grep it means "recursive" and takes nothing, and reading the pattern as its
// argument would lose every `grep -rn PATTERN` there is.
const ARG_LETTERS = new Set(['m', 'A', 'B', 'C', 'd', 'g', 't', 'T', 'f'])

// takesArgument reports whether a flag eats the word after it.
export function takesArgument(word: string): boolean {
  if (word.includes('=')) return false
  if (ARG_FLAGS.has(word)) return true
  if (!/^-[A-Za-z]+$/.test(word)) return false
  return ARG_LETTERS.has(word[word.length - 1])
}

// isPatternFlag: the flags that say "the pattern is the NEXT word" rather than
// it being the first operand. `-f` is not one of them - it names a file to read
// patterns out of, and is in ARG_FLAGS above so its filename is skipped.
export function isPatternFlag(word: string): boolean {
  return word === '-e' || word === '--regexp'
}
