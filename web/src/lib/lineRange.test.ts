import { describe, it, expect } from 'vitest'
import { parseLineRange, formatLineHash, inRange } from './lineRange'

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
