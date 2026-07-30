import { describe, it, expect } from 'vitest'
import { enterEdit, lineBounds, listPrefixFor, minimalReplacement } from './textareaEdit'

// Enter at the end of a list item continues the list; anywhere else it is left
// to the browser (enterEdit returns null and the keystroke falls through).
describe('listPrefixFor', () => {
  it('continues a bullet with its exact indent and spacing', () => {
    expect(listPrefixFor('- one')).toBe('- ')
    expect(listPrefixFor('  - one')).toBe('  - ')
    expect(listPrefixFor('\t*  one')).toBe('\t*  ')
    expect(listPrefixFor('+one')).toBe('+')
  })

  it('increments an ordered marker', () => {
    expect(listPrefixFor('1. one')).toBe('2. ')
    expect(listPrefixFor('  9) nine')).toBe('  10) ')
  })

  it('continues a task list unticked', () => {
    expect(listPrefixFor('- [ ] todo')).toBe('- [ ] ')
    expect(listPrefixFor('- [x] done')).toBe('- [ ] ')
  })

  it('leaves non-list lines (and horizontal rules) alone', () => {
    expect(listPrefixFor('plain text')).toBeNull()
    expect(listPrefixFor('---')).toBeNull()
    expect(listPrefixFor('***')).toBeNull()
  })
})

describe('lineBounds', () => {
  it('spans the hard line around a position', () => {
    expect(lineBounds('ab\ncd', 4)).toEqual([3, 5])
    expect(lineBounds('ab\ncd', 0)).toEqual([0, 2])
  })
})

describe('enterEdit', () => {
  it('inserts the marker on the next line', () => {
    const v = '- one'
    expect(enterEdit(v, v.length, v.length)).toEqual({ value: '- one\n- ', caret: 8 })
  })

  it('keeps the rest of the text after the caret', () => {
    const v = '- one\nafter'
    expect(enterEdit(v, 5, 5)).toEqual({ value: '- one\n- \nafter', caret: 8 })
  })

  it('ends the list on an empty item', () => {
    const v = 'text\n- '
    expect(enterEdit(v, v.length, v.length)).toEqual({ value: 'text\n', caret: 5 })
  })

  it('does nothing mid-line, on a selection, or off a list', () => {
    expect(enterEdit('- one', 3, 3)).toBeNull()
    expect(enterEdit('- one', 2, 5)).toBeNull()
    expect(enterEdit('plain', 5, 5)).toBeNull()
  })
})

// The range applyEdit hands to the browser's own editing pipeline. It has to be
// the SMALLEST one that does the job: a bigger range still produces the right
// text, but it is a bigger thing to undo and a bigger region to re-spellcheck,
// which is the whole reason for editing in place rather than reassigning value.
describe('minimalReplacement', () => {
  const apply = (old: string, r: { start: number; end: number; text: string }) =>
    old.slice(0, r.start) + r.text + old.slice(r.end)

  it('spans only the inserted pair', () => {
    expect(minimalReplacement('foo', 'foo()')).toEqual({ start: 3, end: 3, text: '()' })
    expect(minimalReplacement('foo bar', 'foo (bar')).toEqual({ start: 4, end: 4, text: '(' })
  })

  it('spans both marks when a selection is wrapped', () => {
    expect(minimalReplacement('a sel b', 'a (sel) b')).toEqual({ start: 2, end: 5, text: '(sel)' })
  })

  it('reports a deletion as an empty replacement', () => {
    expect(minimalReplacement('a()b', 'ab')).toEqual({ start: 1, end: 3, text: '' })
  })

  it('never splits a surrogate pair', () => {
    // Two emoji sharing a high surrogate: a naive code-unit trim would replace
    // one code unit with the lone low surrogate of the other.
    const r = minimalReplacement('x\u{1F600}y', 'x\u{1F601}y')
    expect(r).toEqual({ start: 1, end: 3, text: '\u{1F601}' })
    expect([...r.text]).toHaveLength(1)
  })

  it('round-trips whatever it is given', () => {
    const cases: [string, string][] = [
      ['', 'a'],
      ['a', ''],
      ['abc', 'abc\n- '],
      ['- one', 'text\n'],
      ['```\n', '```\n\n```'],
      ['aaa', 'aa'],
      ['\u{1F600}\u{1F600}', '\u{1F600}'],
    ]
    for (const [old, next] of cases) expect(apply(old, minimalReplacement(old, next))).toBe(next)
  })
})
