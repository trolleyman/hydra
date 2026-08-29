export type DesktopMessage =
  | { type: 'new-full-window' }
  | { type: 'new-focused-window'; projectId?: string }
  | { type: 'active-project'; projectId: string }
  | { type: 'window-state'; projectId?: string; agentId?: string; activeTurn: boolean }
  | { type: 'close-window'; force?: boolean }
  | { type: 'show-notification'; title: string; body: string; tag: string; url: string }
  | { type: 'dismiss-notification'; tag: string }
  | { type: 'pick-folder'; requestId: string }

export type DesktopCommand = { type: 'stop-and-close' }

interface DesktopWindow extends Window {
  hydraDesktopCapabilities?: {
    nativeNotifications?: boolean
    nativeFolderPicker?: boolean
  }
  webkit?: { messageHandlers?: { hydra?: { postMessage: (message: DesktopMessage) => void } } }
  chrome?: { webview?: { postMessage: (message: DesktopMessage) => void } }
}

function hasCapability(capability: 'nativeNotifications' | 'nativeFolderPicker'): boolean {
  return typeof window !== 'undefined' && (window as DesktopWindow).hydraDesktopCapabilities?.[capability] === true
}

export function hasNativeNotifications(): boolean {
  return hasCapability('nativeNotifications')
}

export function hasNativeFolderPicker(): boolean {
  return hasCapability('nativeFolderPicker')
}

export function hasDesktopBridge(): boolean {
  if (typeof window === 'undefined') return false
  const desktop = window as DesktopWindow
  return !!desktop.webkit?.messageHandlers?.hydra || !!desktop.chrome?.webview
}

export function postDesktopMessage(message: DesktopMessage): boolean {
  if (typeof window === 'undefined') return false
  const desktop = window as DesktopWindow
  const webkit = desktop.webkit?.messageHandlers?.hydra
  if (webkit) {
    webkit.postMessage(message)
    return true
  }
  const webview = desktop.chrome?.webview
  if (webview) {
    webview.postMessage(message)
    return true
  }
  return false
}

export function openFullWindow(): void {
  if (!postDesktopMessage({ type: 'new-full-window' })) window.open('/', '_blank', 'noopener')
}

export function openFocusedWindow(projectId?: string): void {
  if (postDesktopMessage({ type: 'new-focused-window', projectId })) return
  window.open(projectId ? `/focused/${encodeURIComponent(projectId)}` : '/', '_blank', 'noopener')
}

export function closeDesktopWindow(): void {
  if (!postDesktopMessage({ type: 'close-window' })) window.close()
}

export function showNativeNotification(message: Omit<Extract<DesktopMessage, { type: 'show-notification' }>, 'type'>): boolean {
  return hasNativeNotifications() && postDesktopMessage({ type: 'show-notification', ...message })
}

export function dismissNativeNotification(tag: string): boolean {
  return hasNativeNotifications() && postDesktopMessage({ type: 'dismiss-notification', tag })
}

let folderRequest = 0

export function pickNativeFolder(): Promise<string | null> | null {
  if (!hasNativeFolderPicker()) return null
  const requestId = `folder-${Date.now()}-${++folderRequest}`
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('hydra-desktop-folder-picked', listener)
      reject(new Error('native folder picker timed out'))
    }, 10 * 60_000)
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: string; path?: string; error?: string }>).detail
      if (detail?.requestId !== requestId) return
      window.clearTimeout(timeout)
      window.removeEventListener('hydra-desktop-folder-picked', listener)
      if (detail.error) reject(new Error(detail.error))
      else resolve(detail.path ?? null)
    }
    window.addEventListener('hydra-desktop-folder-picked', listener)
    if (!postDesktopMessage({ type: 'pick-folder', requestId })) {
      window.clearTimeout(timeout)
      window.removeEventListener('hydra-desktop-folder-picked', listener)
      resolve(null)
    }
  })
}

export function onDesktopCommand(handler: (command: DesktopCommand) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<DesktopCommand>).detail)
  window.addEventListener('hydra-desktop-command', listener)
  return () => window.removeEventListener('hydra-desktop-command', listener)
}
