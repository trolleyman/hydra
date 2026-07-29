// Auto-pairing for the markdown composers (HighlightedTextarea, so: the chat
// composer, the spawn prompt, the review/commit boxes).
//
// Five behaviours, all off one client preference (lib/composerPrefs):
//   - typing an opener (` ( [ { " ') inserts its closer behind the caret,
//   - typing a closer that is already there steps over it instead of doubling it,
//   - Enter on a line that is just "```" opens a fenced block (fenceEnterEdit) -
//     typing the third backtick does NOT, so "```" can be written as text and a
//     language can be typed onto the fence first,
//   - typing a mark with text selected WRAPS the selection (` ( [ { " ' * _ ~).
//   - Backspace between an empty pair deletes both.
//
// A mark the user has backslash-escaped ("\`") is a literal, so nothing pairs it
// (see isEscaped). Wrapping a selection is exempt: it is an explicit request, and
// declining it would replace the selected text with the mark.
//
// Everything here is a pure function of (key, value, selection) so the rules are
// testable without a DOM; the component turns a returned edit into a real one
// through applyEdit.

import { lineBounds, type TextareaEdit } from './textareaEdit'

// The pairs that auto-close as you type. Symmetric marks (quote, backtick) carry
// the same character on both sides.
const PAIRS: Record<string, string> = {
  '`': '`',
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
}

// Marks that only ever wrap a SELECTION. Auto-closing them while typing would
// fight the user: a lone "*" or "-" starts a bullet, "_" sits inside identifiers
// and file names, and "~" is half of a "~~" strikethrough. Wrapping keeps the
// selection, so pressing the same key twice gives the doubled form (**bold**).
const WRAP_ONLY: Record<string, string> = { '*': '*', '_': '_', '~': '~' }

const CLOSERS = new Set(Object.values(PAIRS))

// A letter or digit in any script - what counts as "the caret is against a
// word", where a mark is punctuation rather than the start of a pair.
const WORD = /[\p{L}\p{N}]/u

const FENCE = '```'

// isEscaped reports whether the character typed at `pos` is escaped by a
// markdown backslash. Every mark we pair is backslash-escapable, and an escaped
// mark is a literal - "\`" is a backtick in the text, not the start of a code
// span, so pairing it would leave a stray closer behind. Backslashes escape each
// other, so it is an ODD run of them that escapes what follows ("\\`" pairs).
function isEscaped(value: string, pos: number): boolean {
  let n = 0
  while (pos - n > 0 && value[pos - n - 1] === '\\') n++
  return n % 2 === 1
}

// fenceCount counts the ``` lines before `pos`. Even means the next fence line
// OPENS a block, odd means `pos` sits inside an unclosed one - where the
// backtick IS the fence, so pairing it would fight the user closing the block by
// hand.
function fenceCount(value: string, pos: number): number {
  let n = 0
  for (const line of value.slice(0, pos).split('\n')) if (/^[ \t]*```/.test(line)) n++
  return n
}

const inOpenFence = (value: string, pos: number): boolean => fenceCount(value, pos) % 2 === 1

// fenceWrap wraps a multi-line selection in a fenced block rather than a code
// span, which cannot span lines. The fence gets its own lines on both sides.
function fenceWrap(value: string, selStart: number, selEnd: number): TextareaEdit {
  const pre = value.slice(0, selStart)
  const post = value.slice(selEnd)
  const sel = value.slice(selStart, selEnd)
  const inner = sel.endsWith('\n') ? sel.slice(0, -1) : sel
  const head = (pre === '' || pre.endsWith('\n') ? '' : '\n') + FENCE + '\n'
  const tail = FENCE + (post === '' || post.startsWith('\n') ? '' : '\n')
  return {
    value: pre + head + inner + '\n' + tail + post,
    caret: selStart + head.length,
    caretEnd: selStart + head.length + inner.length,
  }
}

// autoPairEdit is what typing `key` should do, or null to let the browser insert
// the character normally. `key` is a KeyboardEvent.key, so single characters
// only - anything else falls through.
export function autoPairEdit(key: string, value: string, selStart: number, selEnd: number): TextareaEdit | null {
  if (key.length !== 1) return null
  const wrapper = PAIRS[key] ?? WRAP_ONLY[key]

  // Text is selected: wrap it, and keep it selected so the marks can be stacked.
  if (selStart !== selEnd) {
    if (!wrapper) return null
    if (key === '`' && value.slice(selStart, selEnd).includes('\n')) return fenceWrap(value, selStart, selEnd)
    return {
      value: value.slice(0, selStart) + key + value.slice(selStart, selEnd) + wrapper + value.slice(selEnd),
      caret: selStart + 1,
      caretEnd: selEnd + 1,
    }
  }

  const next = value[selStart] ?? ''
  const prev = selStart > 0 ? value[selStart - 1] : ''

  // Escaped: the mark is a literal, so it neither opens a pair nor closes one.
  // Insert it as typed - stepping over the closer ahead would swallow it and
  // leave the span open ("`\|`" + "`" must give "`\`|`", not "`\`|").
  if (isEscaped(value, selStart)) return null

  // The closer is already sitting there (we inserted it): step over it. This is
  // what makes typing `foo` end up as one code span rather than `foo``.
  if (CLOSERS.has(key) && next === key) return { value, caret: selStart + 1 }

  const closer = PAIRS[key]
  if (!closer) return null
  // Typing an opener against a word is an insert, not a wrap - "(" before "foo"
  // means the user is bracketing text that is already there, by hand.
  if (WORD.test(next)) return null
  // A symmetric mark right after a word is punctuation, not an opener: the
  // apostrophe in "don't", a quote closing a phrase, a backtick ending a span
  // typed out in full.
  if (key === closer && (WORD.test(prev) || prev === key)) return null
  if (key === '`' && inOpenFence(value, selStart)) return null
  return { value: value.slice(0, selStart) + key + closer + value.slice(selStart), caret: selStart + 1 }
}

// A line that is nothing but an opening fence plus an optional info string -
// "```", "```python". The info string is deliberately a single bare token: a
// line like "``` see below" is prose ABOUT a fence, and turning it into one on
// Enter would be a surprise. Group 1 is the indent, which the block inherits.
const FENCE_LINE_RE = /^([ \t]*)```[A-Za-z0-9_+.#-]*$/

// A closing fence: the marker alone on its line (CommonMark 4.5).
const FENCE_CLOSE_RE = /^[ \t]*```[ \t]*$/

// fenceEnterEdit is what Enter should do with the caret at the end of a "```"
// line - the two halves of writing a fenced block by keyboard.
//
//  1. The block isn't there yet: Enter writes it, so the closing fence and the
//     body line appear together and the caret lands in the body. Typing the
//     third backtick deliberately does nothing on its own - that would fight
//     anyone writing "```" as literal text, and it takes the caret away from the
//     fence before the language can be typed onto it.
//  2. The block IS there and its body is still empty (the caret came back up to
//     add a language): Enter steps down into that body rather than inserting a
//     second blank line - and, in the chat composer, rather than sending the
//     half-written block.
//
// Returns null anywhere else, leaving Enter to do its normal thing: on a fence
// that CLOSES a block (an odd number of fence lines above it), on a fence whose
// block is already closed further down, and on any line that isn't a lone fence.
export function fenceEnterEdit(value: string, selStart: number, selEnd: number): TextareaEdit | null {
  if (selStart !== selEnd) return null
  const [ls, le] = lineBounds(value, selStart)
  if (selStart !== le) return null
  const m = FENCE_LINE_RE.exec(value.slice(ls, le))
  if (!m || fenceCount(value, ls) % 2 !== 0) return null
  const indent = m[1]
  // Already opened, with an empty body waiting: step into it (case 2).
  if (le < value.length) {
    const [bs, be] = lineBounds(value, le + 1)
    if (value.slice(bs, be).trim() === '' && be < value.length) {
      const [cs, ce] = lineBounds(value, be + 1)
      if (FENCE_CLOSE_RE.test(value.slice(cs, ce))) return { value, caret: be }
    }
  }
  // Otherwise write the block - but only if this fence has no partner below, so
  // Enter never orphans a closing fence the user already typed (case 1).
  if (fenceCount(value, value.length) % 2 !== 1) return null
  const insert = `\n${indent}\n${indent}${FENCE}`
  return { value: value.slice(0, le) + insert + value.slice(le), caret: le + 1 + indent.length }
}

// backspacePairEdit deletes BOTH halves of an empty pair when the caret sits
// between them, so backspacing over an auto-inserted closer doesn't leave it
// stranded. Returns null (browser default) anywhere else.
export function backspacePairEdit(value: string, selStart: number, selEnd: number): TextareaEdit | null {
  if (selStart !== selEnd || selStart === 0) return null
  const closer = PAIRS[value[selStart - 1]]
  if (!closer || value[selStart] !== closer) return null
  // An escaped mark is a literal we never paired, so only delete the one char.
  if (isEscaped(value, selStart - 1)) return null
  return { value: value.slice(0, selStart - 1) + value.slice(selStart + 1), caret: selStart - 1 }
}
