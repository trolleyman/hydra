// In-session composer attachments for a chat pane, kept so a half-written
// message's attachments survive switching between agents (item 30). Like the
// spawn form's attachment cache, these live in a module-level map rather than
// localStorage because each carries an in-memory object URL for its thumbnail
// that can't be serialized; they're lost on a full page reload (the URLs would
// be dead anyway). The composer TEXT is persisted separately, and durably, via
// agentViewPrefs.chatDraft. Keyed per project + agent so each pane keeps its own.

import type { Attachment } from './spawnDrafts'

const attachmentsByKey = new Map<string, Attachment[]>()

export function chatDraftKey(projectId: string | null, agentId: string): string {
  return `${projectId ?? '_'}-${agentId}`
}

export function loadChatAttachments(key: string): Attachment[] {
  return attachmentsByKey.get(key) ?? []
}

export function saveChatAttachments(key: string, attachments: Attachment[]): void {
  if (attachments.length === 0) attachmentsByKey.delete(key)
  else attachmentsByKey.set(key, attachments)
}
