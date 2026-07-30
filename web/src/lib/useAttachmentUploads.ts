// A composer's attachment list, as a hook: pick/paste/drop files, watch them
// upload, remove one, read back the settled paths.
//
// The chat composer and the spawn form each grew their own copy of this loop,
// and both are welded to machinery this one does not want - the chat's undo
// history (every add is a `commit` into a snapshot timeline) and the spawn form's
// localStorage draft cache. The review-comment composer needs the loop and
// neither of those, so it lives here in the plain form rather than as a fourth
// transcription. The two older callers are deliberately left alone: rewriting a
// working undo timeline to fit a hook is a bigger change than this one is.
//
// What the hook owns is the part that is easy to get subtly wrong:
//
//   - Optimistic chips. A file shows up the instant it is dropped, with an object
//     URL behind it, so the thumbnail and the lightbox work before the upload
//     lands. The async result patches that chip by id rather than replacing the
//     list, so a file added while an earlier one is still uploading is not lost.
//   - Generic image names. A pasted screenshot arrives as "image.png" (or with no
//     name at all); it becomes image1.png, image2.png, ... numbered from the
//     CURRENT list, so the numbering resets when the list clears and fills the
//     gap left by a removal.
//   - Object-URL lifetime. They are revoked only on unmount and on an explicit
//     reset, never when a chip is removed - a removed chip can come back, and a
//     revoked URL renders as a broken image with no way to tell why.

import { useCallback, useEffect, useRef, useState } from 'react'
import { type Attachment, isGenericImageName, nextGenericImageNumber } from './spawnDrafts'
import { attachmentFromPath, nextAttachmentId } from './draftAttachments'
import { isImageFile, uploadFile } from '../api/uploads'
import { formatError } from '../api/format_error'

export interface AttachmentUploads {
  attachments: Attachment[]
  /** True while any upload is still in flight - the caller disables its submit. */
  uploading: boolean
  /** The settled paths, in chip order: what gets sent. Failed chips are excluded. */
  paths: string[]
  addFiles: (files: File[]) => void
  removeAttachment: (id: number) => void
  /** Drop every chip (after a send). Frees the object URLs. */
  reset: () => void
}

export function useAttachmentUploads(
  projectId: string | null,
  // Chips to start with, as stored paths - editing a draft that already has
  // attachments. Read once on mount; later changes are ignored, because the hook
  // owns the list from then on and re-seeding would discard live edits.
  initialPaths?: string[],
): AttachmentUploads {
  const [attachments, setAttachments] = useState<Attachment[]>(() =>
    (initialPaths ?? []).map((p) => attachmentFromPath(p, projectId)),
  )
  // addFiles reads the current list to number generic images, but must not be
  // re-created on every keystroke-driven render, so it reads through a ref.
  // Published in an effect, never during render - a render must not write a ref;
  // addFiles only reads it from an event handler, well after commit.
  const ref = useRef(attachments)
  useEffect(() => {
    ref.current = attachments
  })
  const objectUrls = useRef<Set<string>>(new Set())

  const revokeAll = useCallback(() => {
    for (const url of objectUrls.current) URL.revokeObjectURL(url)
    objectUrls.current.clear()
  }, [])
  // Only on unmount - see the note above about why removal does not revoke.
  useEffect(() => revokeAll, [revokeAll])

  const patch = useCallback((id: number, fields: Partial<Attachment>) => {
    setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...fields } : a)))
  }, [])

  const addFiles = useCallback(
    (rawFiles: File[]) => {
      let nextN = nextGenericImageNumber(ref.current)
      for (const raw of rawFiles) {
        let file = raw
        if (isImageFile(raw) && isGenericImageName(raw.name)) {
          const ext = (raw.name.match(/\.([^.]+)$/)?.[1] || raw.type.split('/')[1] || 'png').toLowerCase()
          file = new File([raw], `image${nextN}.${ext}`, { type: raw.type, lastModified: raw.lastModified })
          nextN++
        }
        const id = nextAttachmentId()
        // One object URL per file whatever it is: it backs the lightbox for every
        // attachment, and doubles as the thumbnail source for the images.
        const objectUrl = URL.createObjectURL(file)
        objectUrls.current.add(objectUrl)
        const chip: Attachment = {
          id,
          filename: file.name || 'pasted-image',
          path: null,
          url: objectUrl,
          previewUrl: isImageFile(file) ? objectUrl : undefined,
          size: file.size,
          uploading: true,
        }
        setAttachments((prev) => [...prev, chip])
        void uploadFile(projectId, file)
          .then((res) => patch(id, { path: res.path, uploading: false }))
          .catch((err) => patch(id, { uploading: false, error: formatError(err) }))
      }
    },
    [projectId, patch],
  )

  const removeAttachment = useCallback((id: number) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const reset = useCallback(() => {
    revokeAll()
    setAttachments([])
  }, [revokeAll])

  return {
    attachments,
    uploading: attachments.some((a) => a.uploading),
    // A chip that failed to upload has no bytes on the server, so it is silently
    // not sent - the chip itself is already flagged red, which is where the user
    // is told. Blocking the send instead would strand a comment on a failure the
    // user may not care about.
    paths: attachments.filter((a) => a.path && !a.error).map((a) => a.path as string),
    addFiles,
    removeAttachment,
    reset,
  }
}
