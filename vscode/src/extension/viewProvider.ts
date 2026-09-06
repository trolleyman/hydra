import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { agentHostPath } from './extension'
import { HostClient, type HostFrame, type InitializeCommand } from './hostClient'
import { defaultProfileName, profiles, resolveProfile } from './profiles'

type Page = 'chat' | 'history' | 'profiles'

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView
  private client?: HostClient
  private page: Page = 'chat'
  private profile = defaultProfileName()
  private running = false
  private conversationID?: string
  private readonly disposables: vscode.Disposable[] = []

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('hydra')) this.postState()
    }))
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] }
    view.webview.html = this.html(view.webview)
    this.disposables.push(view.webview.onDidReceiveMessage(message => this.onMessage(message)))
    this.postState()
  }

  async newChat(): Promise<void> {
    const workspace = await this.chooseWorkspace()
    if (!workspace) return
    this.client?.dispose()
    this.conversationID = randomUUID()
    this.profile = defaultProfileName()
    const policy = await resolveProfile(this.profile, workspace)
    const conversationDir = path.join(this.context.globalStorageUri.fsPath, 'conversations', this.conversationID)
    await fs.mkdir(conversationDir, { recursive: true })
    await fs.writeFile(path.join(conversationDir, 'metadata.json'), JSON.stringify({
      id: this.conversationID,
      title: 'New chat',
      workspace: workspace.uri.fsPath,
      provider: policy.provider,
      profile: this.profile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2))
    const initialize: InitializeCommand = {
      type: 'initialize', protocol_version: 1, workspace: policy.workspace,
      conversation_dir: conversationDir, policy,
    }
    const client = new HostClient(agentHostPath(this.context), initialize, this.output)
    client.onFrame(frame => this.onFrame(frame))
    client.onExit(error => error && this.post({ type: 'hostExit', message: error.message }))
    this.client = client
    this.page = 'chat'
    this.post({ type: 'clearConversation' })
    this.postState()
  }

  showPage(page: Page): void {
    this.page = page
    this.postState()
    if (page === 'history') void this.postHistory()
  }

  async cycleProfile(): Promise<void> {
    const names = Object.keys(profiles())
    if (names.length < 2) return
    const next = names[(names.indexOf(this.profile) + 1 + names.length) % names.length]
    if (this.running) {
      const behavior = vscode.workspace.getConfiguration('hydra').get<string>('profileChangeBehavior', 'ask')
      let choice: string | undefined = behavior
      if (behavior === 'ask') {
        choice = await vscode.window.showInformationMessage(
          `This turn is running under “${this.profile}”. Apply “${next}” now?`,
          'Interrupt and switch', 'Switch after this turn', 'Cancel',
        )
        choice = choice === 'Interrupt and switch' ? 'interrupt' : choice === 'Switch after this turn' ? 'nextTurn' : undefined
      }
      if (!choice) return
      if (choice === 'interrupt') this.client?.send({ type: 'interrupt', request_id: randomUUID() })
    }
    this.profile = next
    const workspace = vscode.workspace.workspaceFolders?.[0]
    if (workspace && this.client) {
      const policy = await resolveProfile(next, workspace)
      this.client.send({ type: 'update_policy', request_id: randomUUID(), policy, behavior: this.running ? 'next_turn' : 'interrupt' })
    }
    this.postState()
  }

  dispose(): void {
    this.client?.dispose()
    for (const disposable of this.disposables) disposable.dispose()
  }

  private onFrame(frame: HostFrame): void {
    if (frame.type === 'chat_event') {
      if (frame.event.type === 'turn_started') this.running = true
      if (['turn_completed', 'turn_failed', 'turn_interrupted'].includes(frame.event.type)) this.running = false
    }
    this.post({ type: 'hostFrame', frame })
    this.postState()
  }

  private async onMessage(message: { type?: string; [key: string]: unknown }): Promise<void> {
    switch (message.type) {
      case 'ready': this.postState(); break
      case 'newChat': await this.newChat(); break
      case 'showPage': this.showPage(message.page as Page); break
      case 'cycleProfile': await this.cycleProfile(); break
      case 'sendMessage':
        if (!this.client) await this.newChat()
        this.client?.send({ type: 'user_message', request_id: randomUUID(), id: randomUUID(), content: [{ type: 'text', text: String(message.text ?? '') }] })
        break
      case 'interrupt': this.client?.send({ type: 'interrupt', request_id: randomUUID() }); break
      case 'approval':
        this.client?.send({ type: 'approval_response', request_id: String(message.requestID), decision: message.decision as 'allow' | 'deny', scope: message.scope as 'once' | 'chat' | 'workspace' | 'profile' })
        break
      case 'openSettings': await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:trolleyman.hydra'); break
    }
  }

  private async postHistory(): Promise<void> {
    const root = path.join(this.context.globalStorageUri.fsPath, 'conversations')
    let entries: unknown[] = []
    try {
      const dirs = await fs.readdir(root)
      entries = (await Promise.all(dirs.map(async dir => {
        try { return JSON.parse(await fs.readFile(path.join(root, dir, 'metadata.json'), 'utf8')) }
        catch { return undefined }
      }))).filter(Boolean).sort((a: any, b: any) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    } catch {}
    this.post({ type: 'history', entries })
  }

  private async chooseWorkspace(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders
    if (!folders?.length) {
      void vscode.window.showErrorMessage('Open a folder or workspace before starting a Hydra chat.')
      return undefined
    }
    if (folders.length === 1) return folders[0]
    const picked = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, folder })), { placeHolder: 'Choose the agent workspace' })
    return picked?.folder
  }

  private postState(): void {
    this.post({ type: 'state', page: this.page, profile: this.profile, profiles: Object.keys(profiles()), running: this.running, hasConversation: Boolean(this.conversationID) })
  }

  private post(message: unknown): void { void this.view?.webview.postMessage(message) }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'))
    const nonce = randomUUID().replaceAll('-', '')
    return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'"><link rel="stylesheet" href="${style}"></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`
  }
}
