import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { copyText } from './clipboard'

const realClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')

// jsdom doesn't implement document.execCommand, so install a mock we can drive
// per-test (the legacy fallback path calls it).
let execCommand: ReturnType<typeof vi.fn>

beforeEach(() => {
  execCommand = vi.fn().mockReturnValue(true)
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true })
})

afterEach(() => {
  if (realClipboard) Object.defineProperty(globalThis.navigator, 'clipboard', realClipboard)
  else delete (globalThis.navigator as { clipboard?: unknown }).clipboard
  vi.restoreAllMocks()
})

function setClipboard(value: unknown) {
  Object.defineProperty(globalThis.navigator, 'clipboard', { value, configurable: true })
}

describe('copyText', () => {
  it('uses navigator.clipboard.writeText in a secure context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })

    expect(await copyText('hello')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
    // The async API succeeded, so we never touch the legacy path.
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back to execCommand when navigator.clipboard is undefined (insecure LAN origin)', async () => {
    setClipboard(undefined)

    expect(await copyText('lan-copy')).toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    // The hidden textarea is cleaned up, not left in the DOM.
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('falls back to execCommand when writeText rejects (denied permission)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    setClipboard({ writeText })

    expect(await copyText('denied-then-legacy')).toBe(true)
    expect(writeText).toHaveBeenCalled()
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('reports false when both paths fail', async () => {
    setClipboard(undefined)
    execCommand.mockReturnValue(false)

    expect(await copyText('nope')).toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })
})
