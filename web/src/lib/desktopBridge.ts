export type DesktopMessage =
  | { type: 'new-full-window' }
  | { type: 'new-focused-window'; projectId?: string }
  | { type: 'active-project'; projectId: string }
  | { type: 'window-state'; projectId?: string; agentId?: string; activeTurn: boolean }
  | { type: 'close-window'; force?: boolean }

export type DesktopCommand = { type: 'stop-and-close' }

interface DesktopWindow extends Window {
  webkit?: { messageHandlers?: { hydra?: { postMessage: (message: DesktopMessage) => void } } }
  chrome?: { webview?: { postMessage: (message: DesktopMessage) => void } }
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

export function onDesktopCommand(handler: (command: DesktopCommand) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<DesktopCommand>).detail)
  window.addEventListener('hydra-desktop-command', listener)
  return () => window.removeEventListener('hydra-desktop-command', listener)
}
