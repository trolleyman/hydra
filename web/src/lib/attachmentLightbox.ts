// Turning prompt attachments into lightbox entries.
//
// Every surface that shows attachment chips - the spawn form, the chat composer,
// a submitted user message, an agent's original prompt - opens them the same way,
// so the "which chips can be opened, and in what order" rule lives here rather
// than being re-derived (differently) in each of the four.

import type { Attachment } from './spawnDrafts'
import type { LightboxItem } from '../components/Lightbox'
import { fileKind } from './fileKind'

// The attachments that can be opened, in chip order - which is the order the
// lightbox's ←/→ walk. An attachment has no url only while a *local* file has yet
// to be given one (nothing to show yet); everything that reached the server, and
// every locally-attached file, has one.
export function openableAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.filter((a) => a.url)
}

// The lightbox entries for `attachments`, aligned with openableAttachments. The
// kind is read off the filename, which is what lets a .log open into the text
// viewer and a .zip into the download card instead of both being unclickable.
export function attachmentLightboxItems(attachments: Attachment[]): LightboxItem[] {
  return openableAttachments(attachments).map((a) => ({
    url: a.url as string,
    filename: a.filename,
    size: a.size,
    kind: fileKind(a.filename),
  }))
}
