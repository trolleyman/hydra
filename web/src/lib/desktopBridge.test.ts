import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasNativeFolderPicker, hasNativeNotifications, hasWebKitDesktopBridge, isCompactChatWindow, onDesktopCommand, onDesktopImagePaste, openChatWindow, postDesktopMessage } from './desktopBridge'

describe('desktopBridge', () => {
  afterEach(() => {
    delete (window as Window & { hydraDesktopCapabilities?: unknown }).hydraDesktopCapabilities
    delete (window as Window & { webkit?: unknown }).webkit
    delete (window as Window & { chrome?: unknown }).chrome
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

  it('turns a native clipboard texture into a browser File', () => {
    const handler = vi.fn()
    const remove = onDesktopImagePaste(handler)
    window.dispatchEvent(new CustomEvent('hydra-desktop-image-paste', {
      detail: { base64: 'AQID', mediaType: 'image/png', name: 'image.png' },
    }))
    const file = handler.mock.calls[0]?.[0] as File
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('image.png')
    expect(file.type).toBe('image/png')
    expect(file.size).toBe(3)
    remove()
  })

  it('reports no native transport in an ordinary browser', () => {
    expect(postDesktopMessage({ type: 'show-main-window' })).toBe(false)
    expect(hasWebKitDesktopBridge()).toBe(false)
  })

  it('distinguishes WebKit desktop shells from Windows WebView2', () => {
    ;(window as Window & { chrome?: object }).chrome = { webview: { postMessage: vi.fn() } }
    expect(hasWebKitDesktopBridge()).toBe(false)
    delete (window as Window & { chrome?: unknown }).chrome
    ;(window as Window & { webkit?: object }).webkit = { messageHandlers: { hydra: { postMessage: vi.fn() } } }
    expect(hasWebKitDesktopBridge()).toBe(true)
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
    expect(isCompactChatWindow()).toBe(false)
    ;(window as Window & { hydraDesktopCapabilities?: object }).hydraDesktopCapabilities = {
      nativeNotifications: true,
      nativeFolderPicker: false,
      compactChatWindow: true,
    }
    expect(hasNativeNotifications()).toBe(true)
    expect(hasNativeFolderPicker()).toBe(false)
    expect(isCompactChatWindow()).toBe(true)
  })
})
