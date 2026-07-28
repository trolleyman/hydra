import { describe, it, expect } from 'vitest'
import { autoPairEdit, backspacePairEdit } from './autoPair'

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

  it('leaves a closer with nothing to step over to the browser', () => {
    expect(type(')', 'foo|')).toBeNull()
    expect(type(']', '|')).toBeNull()
  })
})

describe('autoPairEdit: fences', () => {
  // ` -> `|`, ` -> steps over -> ``|, ` -> the fence.
  it('opens a fenced block on the third backtick, caret in the body', () => {
    expect(type('`', '``|')).toBe('```\n|\n```')
    expect(type('`', 'text\n``|')).toBe('text\n```\n|\n```')
  })

  it('keeps the line indent on the fence it writes', () => {
    expect(type('`', '  ``|')).toBe('  ```\n  |\n  ```')
  })

  it('only fences at the end of a line', () => {
    expect(type('`', '``| trailing')).toBeNull()
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
  })
})
