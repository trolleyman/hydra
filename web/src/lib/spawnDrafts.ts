// In-session, per-project image attachments for the spawn form.
//
// The typed prompt is persisted to localStorage (see promptDraftKey), but image
// attachments each carry an in-memory object URL for their thumbnail that can't
// be serialized, so they live in this module-level cache instead. Keying by the
// same project+layout shape as the prompt draft means switching projects swaps a
// box's attachments out and back in, just like its text does. The cache is lost
// on a full page reload (the object URLs would be dead anyway) — the image
// numbering counter is mirrored to localStorage separately so it stays
// per-project across reloads (see imageCounterKey / SpawnForm).

// A pasted/attached file in the spawn form. Its absolute `path` (set once the
// upload resolves) is appended to the prompt on submit so the agent can read it.
export interface Attachment {
  id: number
  filename: string
  path: string | null
  previewUrl?: string
  size: number
  uploading: boolean
  error?: string
}

// Same project+layout shape as promptDraftKey, so a box's attachments and text
// travel together when the project changes.
export function spawnDraftKey(projectId: string, compact: boolean): string {
  return `${compact ? 'compact' : 'full'}-${projectId}`
}

const attachmentsByKey = new Map<string, Attachment[]>()

export function loadAttachments(key: string): Attachment[] {
  return attachmentsByKey.get(key) ?? []
}

export function saveAttachments(key: string, attachments: Attachment[]): void {
  if (attachments.length === 0) attachmentsByKey.delete(key)
  else attachmentsByKey.set(key, attachments)
}

// Attachment ids only need to be unique within one box's list. A single
// module-global counter stays unique across component remounts (the full-page
// form remounts per project), where a per-instance ref would reset to 0 and
// collide with ids restored from the cache.
let nextId = 0
export function nextAttachmentId(): number {
  return nextId++
}
