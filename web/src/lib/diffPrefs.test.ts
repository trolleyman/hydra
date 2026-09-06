import { describe, expect, it } from 'vitest'
import { DEFAULT_DIFF_CONTEXT_LINES, parseDiffContextLines } from './diffPrefs'

describe('diff context preference', () => {
  it('accepts each supported context size', () => {
    expect([3, 5, 7, 10].map((value) => parseDiffContextLines(String(value))))
      .toEqual([3, 5, 7, 10])
  })

  it('uses the default for missing or invalid values', () => {
    expect(parseDiffContextLines(null)).toBe(DEFAULT_DIFF_CONTEXT_LINES)
    expect(parseDiffContextLines('8')).toBe(DEFAULT_DIFF_CONTEXT_LINES)
    expect(parseDiffContextLines('not-a-number')).toBe(DEFAULT_DIFF_CONTEXT_LINES)
  })
})
