// The spawn choices the user last made in the composer (agent type, model, chat
// mode), read back out of localStorage.
//
// The spawn form owns these preferences, but it is no longer the only way to
// start a head: a one-click "Spawn agent" elsewhere in the UI (the tests panel's
// fix-this-test dialog) has no composer to read them off, and must still spawn
// the agent the user actually uses rather than a hardcoded default.

import { readLocal, StorageKeys } from './storage'
import type { SpawnAgentRequest } from '../api/models/SpawnAgentRequest'

// The agent types offerable from the web UI. `bash` is deliberately absent - it
// is a shell, not something you hand a task to.
export type AgentTypeOption = 'claude' | 'gemini' | 'copilot' | 'codex'

const AGENT_TYPE_IDS: AgentTypeOption[] = ['claude', 'gemini', 'copilot', 'codex']

// The remembered-model map (agent type -> model alias) persisted in localStorage,
// so picking a model seeds the next spawn of that same agent type.
export function readModelMap(): Record<string, string> {
  try {
    const raw = readLocal(StorageKeys.defaultModel)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

// The remembered thinking-effort map mirrors the model map. Keeping the value
// per provider prevents a Claude choice from leaking into a later Codex spawn.
export function readEffortMap(): Record<string, string> {
  try {
    const raw = readLocal(StorageKeys.defaultEffort)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

// The remembered agent type, falling back to claude when unset or unrecognised
// (a stale key from an older build, or an agent type that no longer exists).
export function readDefaultAgentType(): AgentTypeOption {
  const saved = readLocal(StorageKeys.defaultAgentType)
  return AGENT_TYPE_IDS.find((a) => a === saved) ?? 'claude'
}

// Chat mode defaults ON when the user has never touched the toggle; only an
// explicit 'false' opts out (matching the spawn form's own seeding).
export function readDefaultChatMode(): boolean {
  return readLocal(StorageKeys.defaultChatMode) !== 'false'
}

// The agent/model/chat-mode fields a spawn request should carry when it is made
// outside the composer. Shaped as request fields (snake_case, omitted when they
// should inherit the server's default) so a caller can spread it straight into a
// SpawnAgentRequest. chat_mode is only sent for the agent types that support it -
// the server rejects it for the others.
export function spawnDefaultFields(): { agent_type: string; model?: string; effort?: SpawnAgentRequest['effort']; chat_mode?: boolean } {
  const agentType = readDefaultAgentType()
  const model = readModelMap()[agentType] ?? ''
  const effort = readEffortMap()[agentType] ?? ''
  return {
    agent_type: agentType,
    ...(model ? { model } : {}),
    ...((agentType === 'claude' || agentType === 'codex') && effort
      ? { effort: effort as NonNullable<SpawnAgentRequest['effort']> }
      : {}),
    ...(agentType === 'claude' || agentType === 'codex' ? { chat_mode: readDefaultChatMode() } : {}),
  }
}
