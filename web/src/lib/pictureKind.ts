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

export function pictureKind(url: string | null | undefined): PictureKind {
  if (!url) return 'other'
  // Path-prefix matching on the route, not a substring search: a filename
  // containing "/uploads/" must not be mistaken for an upload.
  let path: string
  try {
    path = new URL(url, window.location.origin).pathname
  } catch {
    return 'other'
  }
  if (path.startsWith('/artifacts/projects/')) return 'artifact'
  if (path.startsWith('/agent-files/projects/')) return 'agent-file'
  if (path.startsWith('/uploads/projects/')) return 'upload'
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
