import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { agentHostPath } from './extension'
import { HostClient, type HostFrame, type InitializeCommand } from './hostClient'
import { defaultProfileName, profiles, resolveProfile, validateProfile, type AuthoredProfile, type WorkspaceGrants } from './profiles'

type Page = 'chat' | 'history' | 'profiles'
type ChatEvent = Extract<HostFrame, { type: 'chat_event' }>['event']

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView
  private client?: HostClient
  private page: Page = 'chat'
  private profile = defaultProfileName()
  private running = false
  private conversationID?: string
  private workspace?: vscode.WorkspaceFolder
  private pendingProfile?: string
  private readonly approvals = new Map<string, Extract<HostFrame, { type: 'approval_request' }>>()
  private readonly disposables: vscode.Disposable[] = []
  private pendingFrames: HostFrame[] = []
  private frameTimer?: NodeJS.Timeout
  private metadataUpdate = Promise.resolve()

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('hydra')) void this.reloadProfile().catch(error => this.reportError(error))
    }))
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] }
    view.webview.html = this.html(view.webview)
    this.disposables.push(view.webview.onDidReceiveMessage(message => {
      void this.onMessage(message).catch(error => this.reportError(error))
    }))
    this.postState()
  }

  async newChat(): Promise<void> {
    const workspace = await this.chooseWorkspace()
    if (!workspace) return
    this.client?.dispose()
    this.conversationID = randomUUID()
    this.profile = defaultProfileName()
    this.workspace = workspace
    this.pendingProfile = undefined
    const policy = await this.resolvePolicy(this.profile, workspace)
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
      provider_executable: vscode.workspace.getConfiguration('hydra').get<string>(`providers.${policy.provider}.path`, policy.provider).trim(),
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
    await this.selectProfile(next)
  }

  private async selectProfile(next: string): Promise<void> {
    if (!profiles()[next] || next === this.profile) return
    if (!this.client) {
      this.profile = next
      this.postState()
      return
    }
    if (this.running) {
      const behavior = vscode.workspace.getConfiguration('hydra').get<string>('profileChangeBehavior', 'ask')
      let choice: string | undefined = behavior
      if (behavior === 'ask') {
        const labels = this.profileLabels()
        choice = await vscode.window.showInformationMessage(
          `This turn is running under "${labels[this.profile]}". Apply "${labels[next]}" now?`,
          'Interrupt and switch', 'Switch after this turn', 'Cancel',
        )
        choice = choice === 'Interrupt and switch' ? 'interrupt' : choice === 'Switch after this turn' ? 'nextTurn' : undefined
      }
      if (!choice) return
      this.pendingProfile = next
      if (choice === 'interrupt') this.client?.send({ type: 'interrupt', request_id: randomUUID() })
      this.postState()
      return
    }
    await this.applyProfile(next)
  }

  dispose(): void {
    this.client?.dispose()
    if (this.frameTimer) clearTimeout(this.frameTimer)
    for (const disposable of this.disposables) disposable.dispose()
  }

  private onFrame(frame: HostFrame): void {
    if (frame.type === 'approval_request') this.approvals.set(frame.request_id, frame)
    if (frame.type === 'operation_result' && this.approvals.has(frame.request_id)) this.approvals.delete(frame.request_id)
    if (frame.type === 'chat_event') {
      if (frame.event.type === 'turn_started') this.running = true
      if (['turn_completed', 'turn_failed', 'turn_interrupted'].includes(frame.event.type)) {
        this.running = false
        if (this.pendingProfile) void this.applyProfile(this.pendingProfile)
      }
    }
    if (frame.type === 'state_snapshot') this.running = frame.projection.turn?.status === 'running'
    if (frame.type === 'chat_event' && frame.event.type.endsWith('_delta')) this.queueFrame(frame)
    else {
      this.flushFrames()
      this.post({ type: 'hostFrame', frame })
    }
    if (frame.type === 'chat_event') void this.touchMetadata(frame.event)
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
        const text = String(message.text ?? '')
        this.client?.send({ type: 'user_message', request_id: randomUUID(), id: randomUUID(), content: [{ type: 'text', text }] })
        await this.touchMetadata(undefined, text)
        break
      case 'interrupt': this.client?.send({ type: 'interrupt', request_id: randomUUID() }); break
      case 'approval':
        await this.answerApproval(String(message.requestID), message.decision as 'allow' | 'deny', message.scope as 'once' | 'chat' | 'workspace' | 'profile')
        break
      case 'controlResponse':
        if (this.client && typeof message.response === 'object' && message.response) {
          const operationRequestID = String(message.operationRequestID ?? '')
          this.client.send({ type: 'control_response', request_id: operationRequestID.startsWith('question-response:') ? operationRequestID : randomUUID(), response: message.response as Record<string, unknown> })
        }
        break
      case 'loadSubagent': this.client?.send({ type: 'load_subagent', request_id: randomUUID(), agent_id: String(message.agentID) }); break
      case 'openHistory': await this.openHistory(String(message.id)); break
      case 'deleteHistory': await this.deleteHistory(String(message.id)); break
      case 'openLink': {
        const uri = vscode.Uri.parse(String(message.href))
        if (uri.scheme === 'https' || uri.scheme === 'http') await vscode.env.openExternal(uri)
        break
      }
      case 'openSettings': await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:trolleyman.hydra'); break
      case 'selectProfile': await this.selectProfile(String(message.name)); break
      case 'saveProfile': {
        const name = String(message.name)
        if (!name.trim() || typeof message.profile !== 'object' || !message.profile) break
        const profile = message.profile as AuthoredProfile
        validateProfile(name, profile)
        const configuration = vscode.workspace.getConfiguration('hydra')
        const target = message.scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
        const inspected = configuration.inspect<Record<string, AuthoredProfile>>('profiles')
        const existing = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue ?? {} : inspected?.globalValue ?? {}
        await configuration.update('profiles', { ...existing, [name]: profile }, target)
        void vscode.window.showInformationMessage(`Saved Hydra profile "${profile.name || name}" to ${message.scope === 'workspace' ? 'this workspace' : 'user settings'}.`)
        break
      }
      case 'createProfile': await this.createProfile(); break
      case 'deleteProfile': await this.deleteProfile(String(message.name), message.scope === 'workspace' ? 'workspace' : 'user'); break
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

  private async openHistory(id: string): Promise<void> {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return
    const conversationDir = path.join(this.context.globalStorageUri.fsPath, 'conversations', id)
    let metadata: any
    try { metadata = JSON.parse(await fs.readFile(path.join(conversationDir, 'metadata.json'), 'utf8')) } catch { return }
    const folders = vscode.workspace.workspaceFolders ?? []
    const resolved = await Promise.all(folders.map(async folder => ({ folder, path: await fs.realpath(folder.uri.fsPath).catch(() => path.resolve(folder.uri.fsPath)) })))
    const wanted = await fs.realpath(String(metadata.workspace)).catch(() => path.resolve(String(metadata.workspace)))
    const workspace = resolved.find(item => item.path === wanted)?.folder
    if (!workspace) {
      const choice = await vscode.window.showInformationMessage('This chat belongs to a workspace that is not open in this window.', 'Open workspace')
      if (choice === 'Open workspace') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(String(metadata.workspace)), { forceNewWindow: true })
      return
    }
    const configured = profiles()
    const profile = configured[metadata.profile] ? metadata.profile : defaultProfileName(configured)
    const policy = await this.resolvePolicy(profile, workspace)
    let resumeSessionID: string | undefined
    try {
      const provider = JSON.parse(await fs.readFile(path.join(conversationDir, 'provider.json'), 'utf8'))
      resumeSessionID = provider.sessions?.[policy.provider]
    } catch {}
    this.client?.dispose()
    this.conversationID = id
    this.workspace = workspace
    this.profile = profile
    this.pendingProfile = undefined
    this.page = 'chat'
    const initialize: InitializeCommand = {
      type: 'initialize', protocol_version: 1, workspace: policy.workspace,
      conversation_dir: conversationDir, policy, resume_session_id: resumeSessionID,
      provider_executable: vscode.workspace.getConfiguration('hydra').get<string>(`providers.${policy.provider}.path`, policy.provider).trim(),
    }
    const client = new HostClient(agentHostPath(this.context), initialize, this.output)
    client.onFrame(frame => this.onFrame(frame))
    client.onExit(error => error && this.post({ type: 'hostExit', message: error.message }))
    this.client = client
    this.post({ type: 'clearConversation' })
    this.postState()
  }

  private async deleteHistory(id: string): Promise<void> {
    if (!/^[a-zA-Z0-9-]+$/.test(id) || id === this.conversationID) return
    const answer = await vscode.window.showWarningMessage('Delete this chat history permanently?', { modal: true }, 'Delete')
    if (answer !== 'Delete') return
    await fs.rm(path.join(this.context.globalStorageUri.fsPath, 'conversations', id), { recursive: true })
    await this.postHistory()
  }

  private queueFrame(frame: HostFrame): void {
    this.pendingFrames.push(frame)
    if (this.frameTimer) return
    this.frameTimer = setTimeout(() => this.flushFrames(), 16)
  }

  private flushFrames(): void {
    if (this.frameTimer) clearTimeout(this.frameTimer)
    this.frameTimer = undefined
    const frames = this.pendingFrames.splice(0)
    if (frames.length) this.post({ type: 'hostFrames', frames })
  }

  private touchMetadata(event?: ChatEvent, firstText?: string): Promise<void> {
    if (!this.conversationID) return Promise.resolve()
    const file = path.join(this.context.globalStorageUri.fsPath, 'conversations', this.conversationID, 'metadata.json')
    this.metadataUpdate = this.metadataUpdate.then(async () => {
      try {
        const current = JSON.parse(await fs.readFile(file, 'utf8'))
        const title = current.title === 'New chat' && firstText ? firstText.replace(/\s+/g, ' ').slice(0, 72) : current.title
        await fs.writeFile(file, JSON.stringify({ ...current, title, updatedAt: event?.timestamp ?? new Date().toISOString() }, null, 2))
      } catch {}
    })
    return this.metadataUpdate
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

  private async applyProfile(name: string): Promise<void> {
    const workspace = this.workspace
    if (!workspace || !this.client) return
    const policy = await this.resolvePolicy(name, workspace)
    const providerExecutable = vscode.workspace.getConfiguration('hydra').get<string>(`providers.${policy.provider}.path`, policy.provider).trim()
    this.profile = name
    this.pendingProfile = undefined
    this.client.send({ type: 'update_policy', request_id: randomUUID(), policy, provider_executable: providerExecutable, behavior: 'interrupt' })
    if (this.conversationID) {
      const metadata = path.join(this.context.globalStorageUri.fsPath, 'conversations', this.conversationID, 'metadata.json')
      try {
        const current = JSON.parse(await fs.readFile(metadata, 'utf8'))
        await fs.writeFile(metadata, JSON.stringify({ ...current, profile: name, provider: policy.provider, updatedAt: new Date().toISOString() }, null, 2))
      } catch {}
    }
    this.postState()
  }

  private async reloadProfile(): Promise<void> {
    if (!profiles()[this.profile]) this.profile = defaultProfileName()
    if (!this.client) {
      this.postState()
      return
    }
    if (this.running) {
      this.pendingProfile = this.profile
      this.postState()
      return
    }
    await this.applyProfile(this.profile)
  }

  private async answerApproval(requestID: string, decision: 'allow' | 'deny', scope: 'once' | 'chat' | 'workspace' | 'profile'): Promise<void> {
    const request = this.approvals.get(requestID)
    if (!request || !this.client) return
    if (decision === 'allow' && (scope === 'workspace' || scope === 'profile')) {
      if (scope === 'workspace' && this.workspace) {
        const key = this.workspaceGrantKey(this.profile, this.workspace)
        const grants = this.context.workspaceState.get<WorkspaceGrants>(key, {})
        await this.context.workspaceState.update(key, addWorkspaceGrant(grants, request))
      } else if (scope === 'profile') {
        const configuration = vscode.workspace.getConfiguration('hydra')
        const globalProfiles = configuration.inspect<Record<string, any>>('profiles')?.globalValue ?? {}
        const authored = profiles()[this.profile] ?? {}
        await configuration.update('profiles', { ...globalProfiles, [this.profile]: addProfileGrant(authored, request) }, vscode.ConfigurationTarget.Global)
      }
    }
    this.client.send({ type: 'approval_response', request_id: requestID, decision, scope })
  }

  private resolvePolicy(name: string, workspace: vscode.WorkspaceFolder) {
    return resolveProfile(name, workspace, this.context.workspaceState.get(this.workspaceGrantKey(name, workspace), {}))
  }

  private workspaceGrantKey(profile: string, workspace: vscode.WorkspaceFolder): string {
    return `hydra.approvals.${workspace.uri.toString()}.${profile}`
  }

  private postState(): void {
    const configured = profiles()
    const profileLabels = this.profileLabels(configured)
    const networkMode = configured[this.profile]?.network?.mode ?? 'hard'
    this.post({ type: 'state', page: this.page, profile: this.profile, pendingProfile: this.pendingProfile, profiles: Object.keys(configured), profileLabels, profileValues: JSON.parse(JSON.stringify(configured)), networkMode, running: this.running, hasConversation: Boolean(this.conversationID) })
  }

  private async createProfile(): Promise<void> {
    const id = await vscode.window.showInputBox({
      title: 'Create Hydra profile',
      prompt: 'Stable profile ID (used in settings)',
      placeHolder: 'review',
      validateInput: value => /^[a-z][a-z0-9_-]*$/.test(value) ? profiles()[value] ? 'That profile already exists.' : undefined : 'Use lowercase letters, numbers, underscores, or hyphens, starting with a letter.',
    })
    if (!id) return
    const label = await vscode.window.showInputBox({ title: 'Create Hydra profile', prompt: 'Display name', value: id[0].toUpperCase() + id.slice(1) })
    if (!label) return
    const source = profiles()[this.profile] ?? {}
    const profile = JSON.parse(JSON.stringify({ ...source, name: label })) as AuthoredProfile
    validateProfile(id, profile)
    const configuration = vscode.workspace.getConfiguration('hydra')
    const existing = configuration.inspect<Record<string, AuthoredProfile>>('profiles')?.globalValue ?? {}
    await configuration.update('profiles', { ...existing, [id]: profile }, vscode.ConfigurationTarget.Global)
  }

  private async deleteProfile(name: string, scope: 'user' | 'workspace'): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('hydra')
    const inspected = configuration.inspect<Record<string, AuthoredProfile>>('profiles')
    const existing = scope === 'workspace' ? inspected?.workspaceValue ?? {} : inspected?.globalValue ?? {}
    if (!existing[name]) {
      void vscode.window.showInformationMessage(`Hydra profile "${this.profileLabels()[name] ?? name}" has no ${scope} override to remove.`)
      return
    }
    const answer = await vscode.window.showWarningMessage(`Remove the ${scope} definition of "${this.profileLabels()[name] ?? name}"?`, { modal: true }, 'Remove')
    if (answer !== 'Remove') return
    const next = { ...existing }
    delete next[name]
    await configuration.update('profiles', next, scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global)
  }

  private profileLabels(configured = profiles()): Record<string, string> {
    return Object.fromEntries(Object.entries(configured).map(([id, value]) => [id, value.name || id]))
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.output.appendLine(message)
    this.post({ type: 'hostExit', message })
    void vscode.window.showErrorMessage(message)
  }

  private post(message: unknown): void { void this.view?.webview.postMessage(message) }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'))
    const nonce = randomUUID().replaceAll('-', '')
    return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'"><link rel="stylesheet" href="${style}"></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`
  }
}

function addWorkspaceGrant(grants: WorkspaceGrants, request: Extract<HostFrame, { type: 'approval_request' }>): WorkspaceGrants {
  const next = JSON.parse(JSON.stringify(grants)) as WorkspaceGrants
  if (request.kind === 'network') next.network = unique([...(next.network ?? []), request.target])
  if (request.kind === 'core_tool' && request.canonical_target) next.core = unique([...(next.core ?? []), request.canonical_target])
  if (request.kind === 'mcp') next.mcp_servers = unique([...(next.mcp_servers ?? []), request.target])
  if (request.kind === 'mcp_tool') next.mcp_tools = unique([...(next.mcp_tools ?? []), request.target])
  if (request.kind === 'git') next.git_operations = unique([...(next.git_operations ?? []), request.target])
  return next
}

function addProfileGrant(profile: Record<string, any>, request: Extract<HostFrame, { type: 'approval_request' }>): Record<string, any> {
  const next = JSON.parse(JSON.stringify(profile))
  if (request.kind === 'network') {
    next.network ??= {}
    next.network.allowed_hosts = unique([...(next.network.allowed_hosts ?? []), request.target])
  }
  if (request.kind === 'core_tool' && request.canonical_target) {
    next.tools ??= {}; next.tools.core ??= {}; next.tools.core[request.canonical_target] = 'allow'
  }
  if (request.kind === 'mcp') {
    next.tools ??= {}; next.tools.mcp ??= {}; next.tools.mcp[request.target] = { ...(next.tools.mcp[request.target] ?? {}), decision: 'allow' }
  }
  if (request.kind === 'mcp_tool') {
    const separator = request.target.indexOf('__')
    if (separator > 0) {
      const server = request.target.slice(0, separator), tool = request.target.slice(separator + 2)
      next.tools ??= {}; next.tools.mcp ??= {}
      const current = next.tools.mcp[server] ?? { decision: 'ask' }
      next.tools.mcp[server] = { ...current, tools: { ...(current.tools ?? {}), [tool]: { decision: 'allow' } } }
    }
  }
  if (request.kind === 'git') {
    next.git ??= {}; next.git.operations ??= {}; next.git.operations[request.target] = 'allow'
  }
  return next
}

function unique(values: string[]): string[] { return [...new Set(values)] }
