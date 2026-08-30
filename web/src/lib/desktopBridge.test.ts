import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasNativeFolderPicker, hasNativeNotifications, onDesktopCommand, openChatWindow, postDesktopMessage } from './desktopBridge'

describe('desktopBridge', () => {
  afterEach(() => {
    delete (window as Window & { hydraDesktopCapabilities?: unknown }).hydraDesktopCapabilities
    vi.restoreAllMocks()
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

  it('opens an existing chat at its canonical responsive route', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    openChatWindow('some project', 'agent/one')
    expect(open).toHaveBeenCalledWith(
      '/project/some%20project/agent/agent%2Fone',
      '_blank',
      'popup,noopener,noreferrer,width=940,height=780',
    )
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
