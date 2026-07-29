// Shared parsing for messages that embed upload paths (the spawn form and the
// chat composer both append an uploaded file's on-disk path to the submitted
// text). This lifts those paths out so they render as attachment chips /
// image thumbnails instead of raw links, and strips the harness's own
// "[Image: original WxH ...]" placeholder that the CLI injects for an image.

import type { Attachment } from './spawnDrafts'
import { attachmentFromPath } from './draftAttachments'

// Any token containing the uploads dir followed by the on-disk filename
// (sanitized to [A-Za-z0-9._-] by uniqueUploadName, so the match stops at
// trailing punctuation).
export const UPLOAD_PATH_RE = /\S*\.hydra\/local\/uploads\/[A-Za-z0-9._-]+/g
// The CLI's own image placeholder text, e.g. "[Image: original 2543x844,
// displayed at 2000x664. Multiply coordinates by 1.27 to map to original
// image.]" - harness plumbing, not user content (item 41).
const IMAGE_PLACEHOLDER_RE = /\[Image:[^\]]*\]/g

// The same placeholder, but as a whole machine-injected (isMeta) message rather
// than a fragment inside a user turn: the CLI logs one every time it downscales
// an image it is about to send, including images IT read itself. Deliberately
// stricter than IMAGE_PLACEHOLDER_RE above - that one strips a fragment out of
// text the user still sees, where over-matching costs a few characters, while a
// match here drops a whole card, where over-matching would silently swallow
// context. So this anchors on the two dimension pairs that make the record the
// CLI's own bookkeeping, and leaves the tail free to be reworded.
const IMAGE_RESIZE_NOTICE_RE = /^\[Image: original \d+x\d+, displayed at \d+x\d+\./

export function isImageResizeNotice(text: string): boolean {
  return IMAGE_RESIZE_NOTICE_RE.test(text.trim())
}

// parseUploadAttachments splits a submitted message into its display text and
// the upload attachments it references. Upload paths are lifted out as chips,
// the image placeholder is dropped, and the leftover text is tidied so removing
// them leaves no dangling blank lines.
export function parseUploadAttachments(
  message: string,
  projectId: string | null,
): { text: string; attachments: Attachment[] } {
  const seen = new Set<string>()
  const attachments: Attachment[] = []
  let id = 0
  for (const m of message.matchAll(UPLOAD_PATH_RE)) {
    const full = m[0]
    if (seen.has(full)) continue
    seen.add(full)
    // Ids are local to this one parsed message (these chips never mix with a
    // live composer's), so they count from 0 rather than drawing on the shared
    // counter - keeping the output a pure function of the message.
    attachments.push(attachmentFromPath(full, projectId, { id: id++ }))
  }
  const text = message
    .replace(UPLOAD_PATH_RE, '')
    .replace(IMAGE_PLACEHOLDER_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, attachments }
}
