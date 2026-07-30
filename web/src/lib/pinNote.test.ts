import { describe, it, expect } from 'vitest'
import { appendToComposer, formatAnnotation, formatQuote } from './pinNote'

const note = { filename: 'shot.png', position: '514,697 px', body: 'the button is 3px low' }

describe('formatQuote', () => {
  // The path is what the agent can actually open - it posted the file, so it can
  // read it back and look at the spot rather than reasoning from coordinates.
  it('names the path the agent can open', () => {
    expect(formatQuote({ ...note, path: '/tmp/shot.png' }))
      .toBe('About `/tmp/shot.png` at 514,697 px:\n\nthe button is 3px low')
  })

  it('falls back to the filename when there is no path', () => {
    expect(formatQuote(note)).toContain('`shot.png`')
  })

  // A remark on its own line keeps its shape when it is more than one line, and
  // keeps the location scannable when several are stacked in one message.
  it('keeps the remark on its own line', () => {
    const multi = formatQuote({ ...note, body: 'one\ntwo' })
    expect(multi.endsWith('one\ntwo')).toBe(true)
  })
})

describe('formatAnnotation', () => {
  // An annotation is an instruction about a file being SENT, not one to fetch -
  // so it names the attachment, never a path that does not exist yet.
  it('names the attachment and stays on one line', () => {
    expect(formatAnnotation(note)).toBe('In `shot.png` at 514,697 px: the button is 3px low')
  })

  it('ignores a path even when one is present', () => {
    expect(formatAnnotation({ ...note, path: '/tmp/shot.png' })).not.toContain('/tmp/')
  })
})

describe('appendToComposer', () => {
  it('separates additions with a blank line', () => {
    expect(appendToComposer('hello', 'world')).toBe('hello\n\nworld')
  })

  // Otherwise the composer opens with blank lines the user has to delete.
  it('does not lead with blank lines on an empty composer', () => {
    expect(appendToComposer('', 'world')).toBe('world')
    expect(appendToComposer('   \n\n', 'world')).toBe('world')
  })

  it('does not stack blank lines when the composer already ends with them', () => {
    expect(appendToComposer('hello\n\n\n', 'world')).toBe('hello\n\nworld')
  })
})
