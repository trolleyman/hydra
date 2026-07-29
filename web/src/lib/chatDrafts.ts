// Composer attachments for a chat pane, kept so a half-written message's
// attachments survive both switching between agents (item 30) and a full page
// reload. Two tiers, for two different problems:
//
//   - a module-level map, the live tier. It holds the attachment list exactly as
//     the composer has it, object URLs and in-flight uploads included, so an
//     agent switch (which unmounts the pane) gives it all back untouched.
//   - agentViewPrefs.chatAttachments, the durable tier: the same list reduced to
//     the stored uploads' paths, which is all that means anything once the page
//     is gone (see draftAttachments). On reload the map is empty and the chips
//     are rebuilt from there, pointing at the blob endpoint instead of the dead
//     object URLs. It rides alongside chatDraft (the composer TEXT), so the
//     draft's two halves share one entry, one TTL and one prune.
//
// Keyed per project + agent so each pane keeps its own.

import type { Attachment } from './spawnDrafts'
import { hydrateAttachments, serializeAttachments } from './draftAttachments'
import { loadAgentViewPrefs, patchAgentViewPrefs } from './agentViewPrefs'

const attachmentsByKey = new Map<string, Attachment[]>()

export function chatDraftKey(projectId: string | null, agentId: string): string {
  return `${projectId ?? '_'}-${agentId}`
}

export function loadChatAttachments(projectId: string | null, agentId: string): Attachment[] {
  const live = attachmentsByKey.get(chatDraftKey(projectId, agentId))
  if (live) return live
  return hydrateAttachments(loadAgentViewPrefs(projectId, agentId).chatAttachments, projectId)
}

export function saveChatAttachments(projectId: string | null, agentId: string, attachments: Attachment[]): void {
  const key = chatDraftKey(projectId, agentId)
  if (attachments.length === 0) attachmentsByKey.delete(key)
  else attachmentsByKey.set(key, attachments)
  patchAgentViewPrefs(projectId, agentId, { chatAttachments: serializeAttachments(attachments) ?? undefined })
}
