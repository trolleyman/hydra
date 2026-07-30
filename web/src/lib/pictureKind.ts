// What KIND of picture is on screen, and therefore where a remark about it goes.
//
// The three surfaces the lightbox opens pictures from are not one feature with
// three skins - they differ in whether the thing being commented on outlives the
// comment, and that decides the destination:
//
//   artifact   - a generated screenshot, addressed by (script, key, file). It
//                exists on the server, survives the conversation, and can be
//                re-read months later. A remark about it is a durable, numbered
//                REVIEW COMMENT.
//   agent-file - a picture an agent posted into the chat by path. The chat IS the
//                thread; a parallel numbered conversation about one of its
//                messages would split the discussion in two. A remark about it is
//                a REPLY.
//   upload     - a file attached to a message that has not been sent yet (the
//                chat composer, the spawn form). There is nothing to comment ON:
//                no head at spawn time, no message yet in chat. A remark about it
//                is part of the prompt being written - MARKUP, not a comment.
//
// Deriving this from the URL rather than from which component opened the lightbox
// keeps it honest: the lightbox is a global overlay with no idea who opened it,
// and the URL is the one thing that travels with the picture.

export type PictureKind = 'artifact' | 'agent-file' | 'upload' | 'other'

// Whole-path patterns, not prefixes. These routes used to live at three distinct
// top-level prefixes (/artifacts/, /agent-files/, /uploads/), so a startsWith was
// enough to tell them apart. Under /api/ they share one, and the segment that
// discriminates now sits AFTER the project id - so the shape has to be matched,
// not the head of the string. Anchored at both ends, which also subsumes what the
// prefix check was guarding against: a filename containing "/uploads/" cannot be
// mistaken for an upload, because a pathname is only ever these exact routes.
const ARTIFACT_BLOB_RE = /^\/api\/projects\/[^/]+\/artifacts\/blob$/
const AGENT_FILE_BLOB_RE = /^\/api\/projects\/[^/]+\/agents\/[^/]+\/files\/blob$/
const UPLOAD_BLOB_RE = /^\/api\/projects\/[^/]+\/uploads\/blob$/

export function pictureKind(url: string | null | undefined): PictureKind {
  if (!url) return 'other'
  let path: string
  try {
    path = new URL(url, window.location.origin).pathname
  } catch {
    return 'other'
  }
  if (ARTIFACT_BLOB_RE.test(path)) return 'artifact'
  if (AGENT_FILE_BLOB_RE.test(path)) return 'agent-file'
  if (UPLOAD_BLOB_RE.test(path)) return 'upload'
  return 'other'
}

/** The on-disk path an agent-file URL refers to - what an agent would open to see
 *  the picture being talked about. Null when the URL is not one. */
export function agentFilePath(url: string | null | undefined): string | null {
  if (!url || pictureKind(url) !== 'agent-file') return null
  try {
    return new URL(url, window.location.origin).searchParams.get('path')
  } catch {
    return null
  }
}

/** The stored filename an upload URL refers to, which is how an attachment is
 *  identified in the composer (its `path` is the same name on disk). */
export function uploadName(url: string | null | undefined): string | null {
  if (!url || pictureKind(url) !== 'upload') return null
  try {
    return new URL(url, window.location.origin).searchParams.get('name')
  } catch {
    return null
  }
}
