// Per-project image attachments for the spawn form, in two tiers - see the same
// split in chatDrafts, which this mirrors:
//
//   - a module-level cache, the live tier, holding the list exactly as the form
//     has it (object URLs, in-flight uploads and all), so switching projects
//     swaps a box's attachments out and back in just like its text does. Keyed
//     by the same project+layout shape as the prompt draft.
//   - localStorage (spawnAttachmentsKey), the durable tier: the same list
//     reduced to the stored uploads' paths, which is all that survives the page.
//     On reload the cache is empty and the chips are rebuilt from there against
//     the blob endpoint, instead of the object URLs, which are long dead.
//
// The image numbering counter is mirrored separately so it too stays per-project
// across reloads (see imageCounterKey / SpawnForm).

import { hydrateAttachments, serializeAttachments } from './draftAttachments'
import { readJSON, writeJSON, spawnAttachmentsKey } from './storage'

// A pasted/attached file in the spawn form. Its absolute `path` (set once the
// upload resolves) is appended to the prompt on submit so the agent can read it.
export interface Attachment {
  id: number
  filename: string
  path: string | null
  /** Thumbnail source - set only for images, and so also the flag for "this chip
   *  shows a picture rather than a file icon". */
  previewUrl?: string
  /** The file's bytes, for ANY attachment: an object URL while it is only local,
   *  the uploads blob endpoint once it has been submitted. This is what the
   *  lightbox opens, which is why it exists separately from previewUrl - a .log or
   *  a .zip has nothing to put in a thumbnail but is still worth opening. */
  url?: string
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

export function loadAttachments(projectId: string, compact: boolean): Attachment[] {
  const live = attachmentsByKey.get(spawnDraftKey(projectId, compact))
  if (live) return live
  return hydrateAttachments(readJSON(spawnAttachmentsKey(projectId, compact), (v) => v), projectId)
}

export function saveAttachments(projectId: string, compact: boolean, attachments: Attachment[]): void {
  const key = spawnDraftKey(projectId, compact)
  if (attachments.length === 0) attachmentsByKey.delete(key)
  else attachmentsByKey.set(key, attachments)
  writeJSON(spawnAttachmentsKey(projectId, compact), serializeAttachments(attachments))
}

// isGenericImageName is true for a pasted/nameless image (image.png, or no stem)
// that should be auto-numbered image1.png, image2.png, ... A file the user named
// keeps its own name.
export function isGenericImageName(name: string): boolean {
  const stem = name.replace(/\.[^.]*$/, '')
  return stem === '' || stem.toLowerCase() === 'image'
}

// nextGenericImageNumber returns the next image<N> number for a generic image:
// max of the numbers already on the current attachments, + 1. Derived from the
// live attachment list (not an ever-growing counter) so it resets to 1 once the
// list clears on send and fills the gap after a removal.
export function nextGenericImageNumber(attachments: Attachment[]): number {
  let max = 0
  for (const a of attachments) {
    const m = /^image(\d+)\.[^.]+$/i.exec(a.filename)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}
