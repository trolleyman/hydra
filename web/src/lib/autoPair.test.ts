import { describe, it, expect } from 'vitest'
import { autoPairEdit, backspacePairEdit, fenceEnterEdit } from './autoPair'

// Shorthand: type `key` into `value` at a caret marked by "|" (or around a
// selection marked by "|...|"), and render the result the same way.
function type(key: string, marked: string): string | null {
  const first = marked.indexOf('|')
  const last = marked.lastIndexOf('|')
  const value = marked.replace(/\|/g, '')
  const start = first
  const end = last === first ? first : last - 1
  const edit = key === 'Backspace' ? backspacePairEdit(value, start, end) : autoPairEdit(key, value, start, end)
  if (!edit) return null
  const caretEnd = edit.caretEnd ?? edit.caret
  return caretEnd === edit.caret
    ? edit.value.slice(0, edit.caret) + '|' + edit.value.slice(edit.caret)
    : edit.value.slice(0, edit.caret) + '|' + edit.value.slice(edit.caret, caretEnd) + '|' + edit.value.slice(caretEnd)
}

// The same shorthand for Enter, which only ever moves the caret.
function enter(marked: string): string | null {
  const first = marked.indexOf('|')
  const last = marked.lastIndexOf('|')
  const value = marked.replace(/\|/g, '')
  const edit = fenceEnterEdit(value, first, last === first ? first : last - 1)
  return edit ? edit.value.slice(0, edit.caret) + '|' + edit.value.slice(edit.caret) : null
}

describe('autoPairEdit: opening', () => {
  it('closes a backtick, a bracket and a quote', () => {
    expect(type('`', '|')).toBe('`|`')
    expect(type('(', 'call|')).toBe('call(|)')
    expect(type('[', '|')).toBe('[|]')
    expect(type('{', '|')).toBe('{|}')
    expect(type('"', 'said |')).toBe('said "|"')
  })

  it('leaves a mark typed against a word alone', () => {
    expect(type('(', '|word')).toBeNull()
    expect(type('`', '|word')).toBeNull()
  })

  it('treats a symmetric mark after a word as punctuation', () => {
    expect(type("'", 'don|')).toBeNull() // don't
    expect(type('"', 'ok|')).toBeNull()
    expect(type("'", 'the |')).toBe("the '|'")
  })

  it('still closes a bracket typed after a word', () => {
    expect(type('(', 'fn|')).toBe('fn(|)')
  })

  it('does not pair a backtick inside an open fence', () => {
    expect(type('`', '```sh\n|\n```')).toBeNull()
  })

  it('leaves a backslash-escaped mark as a literal', () => {
    expect(type('`', '\\|')).toBeNull()
    expect(type('(', 'a \\|')).toBeNull()
    expect(type('"', '\\|')).toBeNull()
  })

  it('pairs again when the backslash is itself escaped', () => {
    expect(type('`', '\\\\|')).toBe('\\\\`|`')
    expect(type('`', '\\\\\\\\|')).toBe('\\\\\\\\`|`')
    expect(type('`', '\\\\\\|')).toBeNull()
  })

  it('ignores keys that are not a single character', () => {
    expect(autoPairEdit('Enter', '', 0, 0)).toBeNull()
    expect(autoPairEdit('ArrowLeft', '', 0, 0)).toBeNull()
  })
})

describe('autoPairEdit: stepping over a closer', () => {
  it('walks past the closer instead of doubling it', () => {
    expect(type('`', '`foo|`')).toBe('`foo`|')
    expect(type(')', '(foo|)')).toBe('(foo)|')
    expect(type('"', '"foo|"')).toBe('"foo"|')
  })

  it('does not step over a closer with an escaped mark', () => {
    expect(type('`', '`\\|`')).toBeNull()
    expect(type(')', '(foo\\|)')).toBeNull()
  })

  it('leaves a closer with nothing to step over to the browser', () => {
    expect(type(')', 'foo|')).toBeNull()
    expect(type(']', '|')).toBeNull()
  })
})

describe('autoPairEdit: fences', () => {
  // ` -> `|`, ` -> steps over -> ``|, ` -> the fence. The caret stays on the
  // opening fence so the language can be typed straight after it.
  it('opens a fenced block on the third backtick, caret on the fence', () => {
    expect(type('`', '``|')).toBe('```|\n\n```')
    expect(type('`', 'text\n``|')).toBe('text\n```|\n\n```')
  })

  it('keeps the line indent on the fence it writes', () => {
    expect(type('`', '  ``|')).toBe('  ```|\n  \n  ```')
  })

  it('only fences at the end of a line', () => {
    expect(type('`', '``| trailing')).toBeNull()
  })
})

describe('fenceEnterEdit', () => {
  it('steps into the body of a just-opened fence', () => {
    expect(enter('```|\n\n```')).toBe('```\n|\n```')
    expect(enter('```python|\n\n```')).toBe('```python\n|\n```')
    expect(enter('text\n```|\n\n```')).toBe('text\n```\n|\n```')
  })

  it('lands after the indent of an indented block', () => {
    expect(enter('  ```sh|\n  \n  ```')).toBe('  ```sh\n  |\n  ```')
  })

  it('leaves any other Enter to the caller', () => {
    expect(enter('```|python\n\n```')).toBeNull() // not at the end of the line
    expect(enter('```sh|\ncode\n```')).toBeNull() // body already written in
    expect(enter('```sh|\n\ntext')).toBeNull() // no closing fence
    expect(enter('```sh|')).toBeNull() // nothing below at all
    expect(enter('plain text|\n\n```')).toBeNull() // not a fence line
    expect(enter('```|a\nb|\n```')).toBeNull() // a selection
  })
})

describe('autoPairEdit: wrapping a selection', () => {
  it('wraps and keeps the selection so marks can be stacked', () => {
    expect(type('`', 'a |big| one')).toBe('a `|big|` one')
    expect(type('*', '|word|')).toBe('*|word|*')
    expect(type('_', '|word|')).toBe('_|word|_')
    expect(type('~', '|word|')).toBe('~|word|~')
    expect(type('(', '|word|')).toBe('(|word|)')
  })

  it('wraps a multi-line selection in a fenced block', () => {
    expect(type('`', '|a\nb|')).toBe('```\n|a\nb|\n```')
    expect(type('`', 'x\n|a\nb|\ny')).toBe('x\n```\n|a\nb|\n```\ny')
  })

  it('gives the fence its own lines when the selection is mid-line', () => {
    expect(type('`', 'x |a\nb| y')).toBe('x \n```\n|a\nb|\n```\n y')
  })

  it('does not wrap with a mark that has no pair', () => {
    expect(type('%', '|word|')).toBeNull()
  })
})

describe('backspacePairEdit', () => {
  it('clears both halves of an empty pair', () => {
    expect(type('Backspace', '`|`')).toBe('|')
    expect(type('Backspace', 'fn(|)')).toBe('fn|')
    expect(type('Backspace', '"|"')).toBe('|')
  })

  it('leaves a non-empty pair, a mismatch and a selection to the browser', () => {
    expect(type('Backspace', '`a|`')).toBeNull()
    expect(type('Backspace', '(|]')).toBeNull()
    expect(type('Backspace', '|')).toBeNull()
    expect(type('Backspace', '(|a|)')).toBeNull()
    expect(type('Backspace', '\\`|`')).toBeNull() // escaped: never ours to pair
  })

  it('still clears a pair after an escaped backslash', () => {
    expect(type('Backspace', '\\\\`|`')).toBe('\\\\|')
  })
})
