// Turning an uploaded file's stored path back into an attachment chip.
//
// An attachment is only half a browser object. The half that matters - the
// bytes - is already on the server the moment the upload resolves, addressable
// forever by its on-disk path; the half that can't survive a reload is the
// in-memory object URL backing its thumbnail. So a SETTLED attachment (one with
// a `path`) is fully reconstructible from that path alone: the blob endpoint
// serves the bytes back, which is exactly what an already-submitted message's
// chips do (parseUploadAttachments). This module is that reconstruction, shared
// by the submitted-message parser and by the composer draft caches, which use it
// to bring a half-written message's attachments back after a page reload.
//
// An attachment still uploading, or one whose upload FAILED, has no path and is
// deliberately not stored: there is nothing on the server to point at, and a
// chip restored in a permanent "uploading..." state would be a lie.

// The Attachment shape stays in spawnDrafts (its long-standing home); importing
// it as a TYPE keeps this module free of a runtime edge back to spawnDrafts,
// which imports the serializers below - so the dependency runs one way only.
import type { Attachment } from './spawnDrafts'
import { uploadBlobUrl } from '../api/uploads'

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?)$/i

// Attachment ids only need to be unique within one composer's list. A single
// module-global counter stays unique across component remounts (the spawn form
// remounts per project), where a per-instance ref would reset to 0 and collide
// with ids restored from a draft cache. It lives here, beside the restore path
// that has to draw on it, rather than in spawnDrafts, which would make the two
// modules import each other.
let nextId = 0
export function nextAttachmentId(): number {
  return nextId++
}

// A settled attachment reduced to what survives serialization. `path` is the
// authority: filename and size are cosmetic (the chip's label and its byte
// count), and both are re-derivable if a future format drops them.
export interface StoredAttachment {
  filename: string
  path: string
  size: number
}

// attachmentFromPath builds the chip for an upload that already lives on the
// server. `id` defaults to a fresh one from the shared counter - restored chips
// must NOT reuse their old ids, which would collide with the ids handed out to
// attachments added after the reload (the counter restarts at 0 with the page).
export function attachmentFromPath(
  path: string,
  projectId: string | null,
  opts: { filename?: string; size?: number; id?: number } = {},
): Attachment {
  const base = path.split('/').pop() ?? path
  const blob = uploadBlobUrl(projectId, base)
  return {
    id: opts.id ?? nextAttachmentId(),
    // Drop the "<unixnano>-" prefix uniqueUploadName adds, for a tidy label.
    filename: opts.filename ?? base.replace(/^\d+-/, ''),
    path,
    // Every stored upload can be served back, whatever it is - the thumbnail is
    // the image-only part.
    url: blob,
    previewUrl: IMAGE_EXT_RE.test(base) ? blob : undefined,
    size: opts.size ?? 0,
    uploading: false,
  }
}

// serializeAttachments keeps only the chips that have somewhere to come back
// from (see the note above). Returns null for an empty result so callers can
// hand it straight to a "null clears the key" writer.
export function serializeAttachments(attachments: Attachment[]): StoredAttachment[] | null {
  const out = attachments
    .filter((a) => !!a.path && !a.uploading && !a.error)
    .map((a) => ({ filename: a.filename, path: a.path as string, size: a.size }))
  return out.length > 0 ? out : null
}

// hydrateAttachments rebuilds chips from a serialized list, tolerating anything
// (an older format, hand-edited storage, a truncated write): a malformed entry
// is dropped rather than crashing the composer it was supposed to restore.
export function hydrateAttachments(stored: unknown, projectId: string | null): Attachment[] {
  if (!Array.isArray(stored)) return []
  const out: Attachment[] = []
  for (const raw of stored) {
    if (!raw || typeof raw !== 'object') continue
    const { filename, path, size } = raw as Partial<StoredAttachment>
    if (typeof path !== 'string' || !path) continue
    out.push(attachmentFromPath(path, projectId, {
      filename: typeof filename === 'string' && filename ? filename : undefined,
      size: typeof size === 'number' ? size : 0,
    }))
  }
  return out
}
