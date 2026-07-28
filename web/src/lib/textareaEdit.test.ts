import { describe, it, expect } from 'vitest'
import { enterEdit, lineBounds, listPrefixFor } from './textareaEdit'

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
