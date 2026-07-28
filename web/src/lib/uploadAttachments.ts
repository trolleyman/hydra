// Shared parsing for messages that embed upload paths (the spawn form and the
// chat composer both append an uploaded file's on-disk path to the submitted
// text). This lifts those paths out so they render as attachment chips /
// image thumbnails instead of raw links, and strips the harness's own
// "[Image: original WxH ...]" placeholder that the CLI injects for an image.

import type { Attachment } from './spawnDrafts'
import { uploadBlobUrl } from '../api/uploads'

// Any token containing the uploads dir followed by the on-disk filename
// (sanitized to [A-Za-z0-9._-] by uniqueUploadName, so the match stops at
// trailing punctuation).
export const UPLOAD_PATH_RE = /\S*\.hydra\/local\/uploads\/[A-Za-z0-9._-]+/g
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?)$/i
// The CLI's own image placeholder text, e.g. "[Image: original 2543x844,
// displayed at 2000x664. Multiply coordinates by 1.27 to map to original
// image.]" - harness plumbing, not user content (item 41).
const IMAGE_PLACEHOLDER_RE = /\[Image:[^\]]*\]/g

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
    const base = full.split('/').pop() ?? full
    const blob = uploadBlobUrl(projectId, base)
    attachments.push({
      id: id++,
      // Drop the "<unixnano>-" prefix uniqueUploadName adds, for a tidy label.
      filename: base.replace(/^\d+-/, ''),
      path: full,
      // Every stored upload can be served back, whatever it is - the thumbnail is
      // the image-only part.
      url: blob,
      previewUrl: IMAGE_EXT_RE.test(base) ? blob : undefined,
      size: 0,
      uploading: false,
    })
  }
  const text = message
    .replace(UPLOAD_PATH_RE, '')
    .replace(IMAGE_PLACEHOLDER_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, attachments }
}
