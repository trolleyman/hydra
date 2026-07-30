import { describe, expect, it } from 'vitest'
import { isJsonOutput } from './jsonOutput'

describe('isJsonOutput', () => {
  it('recognises one pretty value and several compact response lines', () => {
    expect(isJsonOutput('{\n  "available": true,\n  "error": null\n}')).toBe(true)
    expect(isJsonOutput('{"available":true}\n{"account_tier":"Claude Max"}')).toBe(true)
  })

  it('does not repaint scalar output or brace-shaped log lines', () => {
    expect(isJsonOutput('true')).toBe(false)
    expect(isJsonOutput('request: {"available":true}')).toBe(false)
    expect(isJsonOutput('{"ok":true}\nrequest complete')).toBe(false)
  })
})
