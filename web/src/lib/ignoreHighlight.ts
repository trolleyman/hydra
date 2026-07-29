// Pick the machinery out of a .gitignore, so a file of ignore rules stops being
// a flat wall of paths.
//
// A `.gitignore` is not prose and it is not code: every line is a PATTERN, and
// the only questions a reader has of one are which lines are exceptions (`!`),
// where the wildcards are, and where the pattern is anchored. So this marks
// exactly that - the negation, the `*`/`**`/`?`, a `[...]` set, the `/`
// separators that anchor a pattern - and leaves the literal path text alone, in
// the panel's own colour. It is the same rule lib/regexHighlight follows for a
// grep pattern, including the treatment of an escape: the backslash of `\#` is
// marked and the `#` it protects stays literal, because that character is
// exactly what the pattern matches.
//
// Prism has an `ignore` grammar and it is deliberately not used. It paints the
// whole entry as a string (a .gitignore is then one solid colour, which is the
// problem, not the fix), it reads the `*` in `\*` as a wildcard, and its tokens
// cannot be handed to lib/gitOutput - which needs the SAME colours for the
// pattern `git check-ignore -v` prints, so a rule reads identically wherever it
// turns up.
//
// INVARIANT: the tokens concatenate back to the input, character for character.
import { escapeText } from './prismHtml'

export interface IgnoreToken {
  text: string
  // 'literal'   - matches itself, and reads as the path text it is.
  // 'meta'      - machinery: the leading `!`, a `*`/`**`/`?`, a set's brackets.
  // 'class'     - the characters a `[...]` set stands for.
  // 'escape'    - the BACKSLASH of an escaped literal, on its own (see above).
  // 'separator' - a `/`. It is what anchors a pattern and what makes it
  //   directory-only, but it is also in every path, so it stays quiet.
  // 'comment'   - a whole line, from a `#` in its first column.
  kind: 'literal' | 'meta' | 'class' | 'escape' | 'separator' | 'comment'
}

// Prism's own token classes, so an ignore file is coloured out of the same
// palette as every other language in the app (web/src/index.css): the structure
// reads as the operators it is, a character set as a thing that stands for
// something the way a variable does, and the backslash of an escaped literal as
// the punctuation it is - the quietest of the three, since what it marks is a
// character that does nothing but match itself.
export const IGNORE_TOKEN_CLASSES: Record<IgnoreToken['kind'], string> = {
  literal: '',
  meta: 'token operator',
  class: 'token variable',
  escape: 'token punctuation',
  separator: 'token punctuation',
  comment: 'token comment',
}

// Languages this module highlights. `gitignore` is what lib/language names an
// ignore file; the rest are what a markdown fence in a doc is likely to say.
const LANGUAGES = new Set(['gitignore', 'ignore', 'dockerignore', 'npmignore'])

export function isIgnoreLanguage(name: string): boolean {
  return LANGUAGES.has(name)
}

// A file whose lines are ignore rules: `.gitignore`, `.dockerignore`, the
// `.hydraignore` this project reads, `web/.npmignore`. The dot is required, so
// an ordinary word ending in "ignore" is not swept up.
const IGNORE_FILE = /\.[\w-]*ignore$/i

export function isIgnoreFile(path: string): boolean {
  return IGNORE_FILE.test(path.split('/').pop() ?? path)
}

function push(out: IgnoreToken[], text: string, kind: IgnoreToken['kind']): void {
  if (text === '') return
  const last = out[out.length - 1]
  if (last && last.kind === kind) last.text += text
  else out.push({ text, kind })
}

// readSet consumes a `[...]` from `at`, or returns -1 when the bracket never
// closes - an unterminated `[` matches a literal bracket rather than eating the
// rest of the pattern. A `]` first in the set is a literal `]`, as in a regex.
function readSet(line: string, at: number): number {
  let i = at + 1
  if (line[i] === '!' || line[i] === '^') i++
  if (line[i] === ']') i++
  while (i < line.length) {
    if (line[i] === '\\') { i += 2; continue }
    if (line[i] === ']') return i + 1
    i++
  }
  return -1
}

// ignoreTokens splits ONE line of an ignore file into what it matches with and
// what it matches. Never throws and never drops a character: anything it cannot
// account for stays literal.
export function ignoreTokens(line: string): IgnoreToken[] {
  const out: IgnoreToken[] = []
  // git reads a `#` as a comment only in the first column - `a#b` is a pattern
  // that matches a hash, and so is ` #b`.
  if (line.startsWith('#')) return [{ text: line, kind: 'comment' }]

  let i = 0
  while (i < line.length) {
    const ch = line[i]

    if (ch === '\\' && i + 1 < line.length) {
      push(out, '\\', 'escape')
      push(out, line[i + 1], 'literal')
      i += 2
      continue
    }

    if (ch === '[') {
      const end = readSet(line, i)
      if (end !== -1) {
        const body = line.slice(i, end)
        const open = /^\[[!^]/.test(body) ? body.slice(0, 2) : '['
        push(out, open, 'meta')
        push(out, body.slice(open.length, -1), 'class')
        push(out, ']', 'meta')
        i = end
        continue
      }
    }

    // `!` negates a rule, and only in the first column - anywhere else it is a
    // character in a filename.
    if (ch === '!' && i === 0) { push(out, ch, 'meta'); i++; continue }
    if (ch === '*') {
      // `**` crosses directories where `*` does not, so it is one token rather
      // than two.
      const run = line[i + 1] === '*' ? '**' : '*'
      push(out, run, 'meta')
      i += run.length
      continue
    }
    if (ch === '?') { push(out, ch, 'meta'); i++; continue }
    if (ch === '/') { push(out, ch, 'separator'); i++; continue }

    push(out, ch, 'literal')
    i++
  }
  return out
}

// highlightIgnore returns Prism-compatible token HTML for a whole ignore file.
// Line by line, because that is what the format is: nothing in it spans a
// newline, so there is no state to carry across one.
export function highlightIgnore(code: string): string {
  return code
    .split('\n')
    .map((line) => ignoreTokens(line).map(spanHtml).join(''))
    .join('\n')
}

function spanHtml(token: IgnoreToken): string {
  const cls = IGNORE_TOKEN_CLASSES[token.kind]
  const text = escapeText(token.text)
  return cls === '' ? text : `<span class="${cls}">${text}</span>`
}
