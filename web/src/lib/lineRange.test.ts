import { describe, it, expect } from 'vitest'
import { parseLineRange, formatLineHash, inRange, parseDiffLineRange, formatDiffLineHash } from './lineRange'

describe('parseLineRange', () => {
  it('parses a single line, with or without the leading #', () => {
    expect(parseLineRange('#L5')).toEqual({ start: 5, end: 5 })
    expect(parseLineRange('L5')).toEqual({ start: 5, end: 5 })
  })

  it('parses a range', () => {
    expect(parseLineRange('#L5-L10')).toEqual({ start: 5, end: 10 })
    expect(parseLineRange('L10-L5')).toEqual({ start: 5, end: 10 }) // normalized
  })

  it('tolerates a bare second number', () => {
    expect(parseLineRange('#L5-10')).toEqual({ start: 5, end: 10 })
  })

  it('returns null when there is no line ref', () => {
    expect(parseLineRange('')).toBeNull()
    expect(parseLineRange('#section')).toBeNull()
    expect(parseLineRange('#')).toBeNull()
  })
})

describe('formatLineHash', () => {
  it('renders a single line and a range, always low-high', () => {
    expect(formatLineHash(5, 5)).toBe('L5')
    expect(formatLineHash(5, 10)).toBe('L5-L10')
    expect(formatLineHash(10, 5)).toBe('L5-L10')
  })
})

describe('inRange', () => {
  it('is inclusive of both ends and false for null', () => {
    const r = { start: 5, end: 10 }
    expect(inRange(5, r)).toBe(true)
    expect(inRange(10, r)).toBe(true)
    expect(inRange(4, r)).toBe(false)
    expect(inRange(11, r)).toBe(false)
    expect(inRange(7, null)).toBe(false)
  })
})

describe('parseDiffLineRange', () => {
  it('parses each side, single line', () => {
    expect(parseDiffLineRange('#L5')).toEqual({ side: 'old', start: 5, end: 5 })
    expect(parseDiffLineRange('R5')).toEqual({ side: 'new', start: 5, end: 5 })
  })

  it('parses a range and normalizes low-high', () => {
    expect(parseDiffLineRange('#R5-R10')).toEqual({ side: 'new', start: 5, end: 10 })
    expect(parseDiffLineRange('L10-L5')).toEqual({ side: 'old', start: 5, end: 10 })
  })

  it('fixes the side from the first prefix and tolerates a bare second number', () => {
    expect(parseDiffLineRange('#R5-10')).toEqual({ side: 'new', start: 5, end: 10 })
    // A differing second prefix does not change the side.
    expect(parseDiffLineRange('#L5-R10')).toEqual({ side: 'old', start: 5, end: 10 })
  })

  it('returns null when there is no diff line ref', () => {
    expect(parseDiffLineRange('')).toBeNull()
    expect(parseDiffLineRange('#section')).toBeNull()
    expect(parseDiffLineRange('#5')).toBeNull()
  })
})

describe('formatDiffLineHash', () => {
  it('prefixes L for old and R for new, always low-high', () => {
    expect(formatDiffLineHash('old', 5, 5)).toBe('L5')
    expect(formatDiffLineHash('new', 5, 5)).toBe('R5')
    expect(formatDiffLineHash('new', 5, 10)).toBe('R5-R10')
    expect(formatDiffLineHash('old', 10, 5)).toBe('L5-L10')
  })
})
