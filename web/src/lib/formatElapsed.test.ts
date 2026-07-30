import { describe, it, expect } from 'vitest'
import { formatElapsed } from './formatElapsed'

describe('formatElapsed', () => {
  it('shows bare seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(9)).toBe('9s')
    expect(formatElapsed(59)).toBe('59s')
  })

  it('shows minutes + seconds up to an hour', () => {
    expect(formatElapsed(60)).toBe('1m 0s')
    expect(formatElapsed(65)).toBe('1m 5s')
    expect(formatElapsed(3599)).toBe('59m 59s')
  })

  it('shows hours + minutes up to a day', () => {
    expect(formatElapsed(3600)).toBe('1h 0m')
    expect(formatElapsed(3600 + 5 * 60 + 59)).toBe('1h 5m')
    expect(formatElapsed(24 * 3600 - 1)).toBe('23h 59m')
  })

  it('shows days + hours beyond that', () => {
    expect(formatElapsed(24 * 3600)).toBe('1d 0h')
    expect(formatElapsed(3 * 24 * 3600 + 4 * 3600)).toBe('3d 4h')
    // The simulation server's frozen clock puts elapsed labels hundreds of days
    // out - readable here, where saturating at minutes gave "825127m 50s".
    expect(formatElapsed(573 * 24 * 3600 + 12 * 3600)).toBe('573d 12h')
  })
})
