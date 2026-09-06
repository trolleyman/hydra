import * as path from 'node:path'
import * as vscode from 'vscode'
import { ChatViewProvider } from './viewProvider'

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Hydra')
  const provider = new ChatViewProvider(context, output)
  context.subscriptions.push(
    output,
    provider,
    vscode.window.registerWebviewViewProvider('hydra.chatView', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('hydra.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('hydra.showHistory', () => provider.showPage('history')),
    vscode.commands.registerCommand('hydra.showProfiles', () => provider.showPage('profiles')),
    vscode.commands.registerCommand('hydra.cycleProfile', () => provider.cycleProfile()),
  )
}

export function agentHostPath(context: vscode.ExtensionContext): string {
  const override = vscode.workspace.getConfiguration('hydra').get<string>('agentHost.path', '').trim()
  if (override) return override
  const platform = `${process.platform}-${process.arch}`
  const name = process.platform === 'win32' ? 'hydra-agent-host.exe' : 'hydra-agent-host'
  return context.asAbsolutePath(path.join('bin', platform, name))
}

export function deactivate(): void {}
