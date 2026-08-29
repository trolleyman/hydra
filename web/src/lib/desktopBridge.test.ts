import { describe, expect, it, vi } from 'vitest'
import { onDesktopCommand, postDesktopMessage } from './desktopBridge'

describe('desktopBridge', () => {
  it('delivers native commands and removes the listener', () => {
    const handler = vi.fn()
    const remove = onDesktopCommand(handler)
    window.dispatchEvent(new CustomEvent('hydra-desktop-command', { detail: { type: 'stop-and-close' } }))
    expect(handler).toHaveBeenCalledWith({ type: 'stop-and-close' })
    remove()
    window.dispatchEvent(new CustomEvent('hydra-desktop-command', { detail: { type: 'stop-and-close' } }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('reports no native transport in an ordinary browser', () => {
    expect(postDesktopMessage({ type: 'new-full-window' })).toBe(false)
  })
})
