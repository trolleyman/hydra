import * as os from 'node:os'
import * as path from 'node:path'
import { realpath } from 'node:fs/promises'
import * as vscode from 'vscode'
import type { components } from '../generated/protocol'

export type EffectivePolicy = components['schemas']['InitializeCommand']['policy']
export type AuthoredProfile = Record<string, unknown> & {
  provider?: 'claude' | 'codex'
  model?: string
  effort?: string
  prompt?: string
  filesystem?: { readable?: string[]; writable?: string[]; copy_on_write?: string[]; masked?: string[] }
  network?: { mode?: 'off' | 'hard' | 'advisory' | 'unrestricted'; allowed_hosts?: string[]; blocked_hosts?: string[] }
  tools?: EffectivePolicy['tools']
  git?: EffectivePolicy['git']
}

const defaultMasks = [
  '~/.ssh', '~/.gnupg', '~/.aws', '~/.azure', '~/.kube', '~/.docker',
  '~/.password-store', '~/.config/gh', '~/.config/glab-cli', '~/.netrc',
  '~/.git-credentials', '~/.npmrc', '~/.pypirc', '.env*',
]

export function profiles(): Record<string, AuthoredProfile> {
  return vscode.workspace.getConfiguration('hydra').get<Record<string, AuthoredProfile>>('profiles', {})
}

export function defaultProfileName(all = profiles()): string {
  const configured = vscode.workspace.getConfiguration('hydra').get<string>('defaultProfile', 'implement')
  return all[configured] ? configured : Object.keys(all)[0] ?? 'implement'
}

export async function resolveProfile(name: string, workspace: vscode.WorkspaceFolder): Promise<EffectivePolicy> {
  const authored = profiles()[name]
  if (!authored) throw new Error(`Unknown Hydra profile: ${name}`)
  const workspacePath = await canonical(workspace.uri.fsPath)
  const home = await canonical(os.homedir())
  const resolveAll = async (values: string[] | undefined) => Promise.all((values ?? []).map(value => resolvePath(value, workspace, home)))
  const filesystem = authored.filesystem ?? {}
  return {
    profile: name,
    provider: authored.provider ?? 'codex',
    model: authored.model,
    effort: authored.effort,
    prompt: authored.prompt,
    workspace: workspacePath,
    user_home: home,
    filesystem: {
      readable: await resolveAll(filesystem.readable ?? ['.']),
      writable: await resolveAll(filesystem.writable ?? ['.']),
      copy_on_write: await resolveAll(filesystem.copy_on_write),
      masked: await resolveAll([...defaultMasks, ...(filesystem.masked ?? [])]),
    },
    network: {
      mode: authored.network?.mode ?? 'hard',
      allowed_hosts: authored.network?.allowed_hosts ?? [],
      blocked_hosts: authored.network?.blocked_hosts ?? [],
    },
    tools: authored.tools ?? { core: { read: 'allow', search: 'allow', edit: 'allow', bash: 'allow', fetch: 'allow' } },
    git: authored.git ?? { isolation: 'readonly', protected_branches: ['main', 'master', 'release/*'] },
  }
}

async function resolvePath(value: string, workspace: vscode.WorkspaceFolder, home: string): Promise<string> {
  const named = value.match(/^\$\{workspaceFolder:([^}]+)\}(.*)$/)
  let expanded: string
  if (named) {
    const folder = vscode.workspace.workspaceFolders?.find(item => item.name === named[1])
    if (!folder) throw new Error(`Unknown workspace folder in path: ${value}`)
    expanded = folder.uri.fsPath + named[2]
  } else {
    expanded = value
      .replace(/^\$\{workspaceFolder\}/, workspace.uri.fsPath)
      .replace(/^\$\{userHome\}/, home)
    if (expanded === '~' || expanded.startsWith(`~${path.sep}`) || expanded.startsWith('~/')) {
      expanded = path.join(home, expanded.slice(expanded === '~' ? 1 : 2))
    } else if (!path.isAbsolute(expanded)) {
      expanded = path.resolve(workspace.uri.fsPath, expanded)
    }
  }
  return canonicalPreservingGlob(expanded)
}

async function canonical(value: string): Promise<string> {
  return realpath(value)
}

async function canonicalPreservingGlob(value: string): Promise<string> {
  if (/[*?\[]/.test(value)) return path.normalize(value)
  try {
    return await canonical(value)
  } catch {
    return path.normalize(value)
  }
}
