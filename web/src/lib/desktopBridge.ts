export type DesktopMessage =
  | { type: 'show-main-window' }
  | { type: 'new-chat-window'; projectId?: string; agentId?: string }
  | { type: 'active-project'; projectId: string }
  | {
      type: 'window-state'
      projectId?: string
      agentId?: string
      activeTurn: boolean
      runningAgentCount: number
      commandOwnedBackend: boolean
    }
  | { type: 'image-paste-target'; enabled: boolean }
  | { type: 'close-window'; force?: boolean }
  | { type: 'show-notification'; title: string; body: string; tag: string; url: string }
  | { type: 'dismiss-notification'; tag: string }
  | { type: 'pick-folder'; requestId: string }
  | { type: 'keep-running'; enabled: boolean }

export type DesktopCommand = { type: 'stop-and-close' }

interface DesktopImagePaste {
  base64: string
  mediaType: string
  name: string
}

interface DesktopWindow extends Window {
  hydraDesktopCapabilities?: {
    nativeNotifications?: boolean
    nativeFolderPicker?: boolean
    compactChatWindow?: boolean
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

export function isCompactChatWindow(): boolean {
  return typeof window !== 'undefined' && (window as DesktopWindow).hydraDesktopCapabilities?.compactChatWindow === true
}

export function setDesktopKeepRunning(enabled: boolean): boolean {
  return postDesktopMessage({ type: 'keep-running', enabled })
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
  if (!postDesktopMessage({ type: 'show-main-window' })) window.open('/', 'hydra-main', 'noopener')
}

export function openChatWindow(projectId?: string, agentId?: string): void {
  if (postDesktopMessage({ type: 'new-chat-window', projectId, agentId })) return
  const url = projectId && agentId
    ? `/project/${encodeURIComponent(projectId)}/agent/${encodeURIComponent(agentId)}`
    : projectId ? `/focused/${encodeURIComponent(projectId)}` : '/'
  // Browsers decide how much window chrome they permit, but `popup` requests a
  // compact standalone window where supported. The route itself stays canonical
  // and responsive, so the same URL also works as an ordinary tab.
  window.open(url, '_blank', 'popup,noopener,noreferrer,width=940,height=780')
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

export function onDesktopImagePaste(handler: (file: File) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<DesktopImagePaste>).detail
    if (!detail?.base64 || !detail.mediaType.startsWith('image/')) return
    const binary = window.atob(detail.base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    handler(new File([bytes], detail.name || 'image.png', { type: detail.mediaType }))
  }
  window.addEventListener('hydra-desktop-image-paste', listener)
  return () => window.removeEventListener('hydra-desktop-image-paste', listener)
}
