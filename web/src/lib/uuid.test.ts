import { describe, it, expect, afterEach } from 'vitest'
import { randomId } from './uuid'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const realCrypto = globalThis.crypto

afterEach(() => {
  Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true })
})

function setCrypto(value: unknown) {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true })
}

describe('randomId', () => {
  it('uses crypto.randomUUID when available', () => {
    expect(randomId()).toMatch(UUID_RE)
  })

  it('falls back to getRandomValues in an insecure context (randomUUID absent)', () => {
    // Reproduces http://hades:26600 in Chrome: crypto exists, getRandomValues
    // exists, but randomUUID does not - the case that used to throw mid-send.
    setCrypto({ getRandomValues: realCrypto.getRandomValues.bind(realCrypto) })
    expect(randomId()).toMatch(UUID_RE)
  })

  it('does not throw when randomUUID throws', () => {
    setCrypto({
      randomUUID: () => {
        throw new Error('not a secure context')
      },
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    })
    expect(randomId()).toMatch(UUID_RE)
  })

  it('still returns an id when crypto is entirely absent', () => {
    setCrypto(undefined)
    expect(typeof randomId()).toBe('string')
    expect(randomId().length).toBeGreaterThan(0)
  })

  it('returns distinct ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => randomId()))
    expect(ids.size).toBe(1000)
  })
})
