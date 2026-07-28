// In-session, per-project image attachments for the spawn form.
//
// The typed prompt is persisted to localStorage (see promptDraftKey), but image
// attachments each carry an in-memory object URL for their thumbnail that can't
// be serialized, so they live in this module-level cache instead. Keying by the
// same project+layout shape as the prompt draft means switching projects swaps a
// box's attachments out and back in, just like its text does. The cache is lost
// on a full page reload (the object URLs would be dead anyway) - the image
// numbering counter is mirrored to localStorage separately so it stays
// per-project across reloads (see imageCounterKey / SpawnForm).

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
