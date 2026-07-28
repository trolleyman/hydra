// Auto-pairing for the markdown composers (HighlightedTextarea, so: the chat
// composer, the spawn prompt, the review/commit boxes).
//
// Four behaviours, all off one client preference (lib/composerPrefs):
//   - typing an opener (` ( [ { " ') inserts its closer behind the caret,
//   - typing a closer that is already there steps over it instead of doubling it,
//   - a third backtick on its own line opens a fenced block, caret in the body,
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

// inOpenFence reports whether `pos` sits inside an unclosed ``` block. Fence
// markers are counted by line, so an odd number of them before the caret means
// the block is still open. Inside one, the backtick IS the fence - pairing it
// would fight the user closing the block by hand.
function inOpenFence(value: string, pos: number): boolean {
  let n = 0
  for (const line of value.slice(0, pos).split('\n')) if (/^[ \t]*```/.test(line)) n++
  return n % 2 === 1
}

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

  // The third backtick of a "```" at the end of an otherwise-empty line opens a
  // fenced block. The caret lands in the BODY (not after the opening fence):
  // Enter sends the message in the chat composer, so a caret parked on the info
  // string would be the one spot the user can't type their way out of.
  if (key === '`') {
    const [ls, le] = lineBounds(value, selStart)
    const before = value.slice(ls, selStart)
    if (le === selStart && /^[ \t]*``$/.test(before)) {
      const indent = before.slice(0, -2)
      const insert = `\`\n${indent}\n${indent}${FENCE}`
      return { value: value.slice(0, selStart) + insert + value.slice(selStart), caret: selStart + 2 + indent.length }
    }
  }

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
