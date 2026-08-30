import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasNativeFolderPicker, hasNativeNotifications, onDesktopCommand, postDesktopMessage } from './desktopBridge'

describe('desktopBridge', () => {
  afterEach(() => {
    delete (window as Window & { hydraDesktopCapabilities?: unknown }).hydraDesktopCapabilities
  })
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
    expect(postDesktopMessage({ type: 'show-main-window' })).toBe(false)
  })

  it('requires explicit capabilities for platform-specific bridge features', () => {
    expect(hasNativeNotifications()).toBe(false)
    expect(hasNativeFolderPicker()).toBe(false)
    ;(window as Window & { hydraDesktopCapabilities?: object }).hydraDesktopCapabilities = {
      nativeNotifications: true,
      nativeFolderPicker: false,
    }
    expect(hasNativeNotifications()).toBe(true)
    expect(hasNativeFolderPicker()).toBe(false)
  })
})
