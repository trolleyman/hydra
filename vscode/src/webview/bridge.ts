export const vscode = acquireVsCodeApi()

export function postMessage(message: Record<string, unknown>): void {
  vscode.postMessage(message)
}
