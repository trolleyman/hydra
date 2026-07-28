import { memo } from 'react'
import { X, FileText, LoaderCircle } from 'lucide-react'
import type { Attachment } from '../lib/spawnDrafts'

// A row of attachment chips, shared by the spawn form and the agent terminal.
// EVERY chip opens the fullscreen lightbox on click - an image at its thumbnail,
// a text file in the text viewer, anything else as a card with a download link -
// so a chip is never a dead end just because it isn't a picture. (The parent owns
// the lightbox and resolves the clicked id to an entry index; see
// lib/attachmentLightbox.) An upload in progress shows a spinner; a failed one is
// flagged. `className` styles the outer row so each caller can place/pad it to fit
// its layout. Renders nothing when empty.
// The row is capped at two chip rows and scrolls beyond that, so a big batch
// of images can't crowd out the prompt text around it.
// memo: rendered inside the spawn composer, which re-renders on every
// keystroke; the attachments array identity only changes when a chip is
// actually added/removed/patched, so typing skips this row entirely.
export const AttachmentChips = memo(function AttachmentChips({
  attachments,
  size,
  onRemove,
  onOpen,
  className,
}: {
  attachments: Attachment[]
  size: 'sm' | 'md'
  /** Omit to render read-only chips (no remove button), e.g. a submitted prompt. */
  onRemove?: (id: number) => void
  /** `origin` is the chip that was activated - the lightbox flies the picture out of
   *  its box (and back into it on close) rather than fading in over it. */
  onOpen: (id: number, origin: Element) => void
  className?: string
}) {
  if (attachments.length === 0) return null
  const thumb = size === 'sm' ? 'w-6 h-6' : 'w-8 h-8'
  const text = size === 'sm' ? 'text-[10px]' : 'text-xs'
  // Two rows of image chips: 2 * (thumb + py-1 + border) + one gap-1.5.
  const maxH = size === 'sm' ? 'max-h-[74px]' : 'max-h-[90px]'
  return (
    // overflow-x-hidden is explicit: an overflow-y-auto box promotes the other
    // axis from visible to auto, which showed a phantom horizontal scrollbar on
    // the (wrapped) chip row inside a queued message bubble.
    <div className={`flex flex-wrap gap-1.5 overflow-y-auto overflow-x-hidden ${maxH} ${className ?? ''}`}>
      {attachments.map((a) => {
        // Openable as soon as there are bytes behind it - which is immediately for
        // a locally attached file (an object URL), so a chip doesn't go from inert
        // to clickable as its upload lands.
        const canOpen = !!a.url
        const open = canOpen
          ? (e: React.SyntheticEvent<HTMLDivElement>) => onOpen(a.id, e.currentTarget)
          : undefined
        return (
          <div
            key={a.id}
            onClick={open}
            onKeyDown={open ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e) } } : undefined}
            role={canOpen ? 'button' : undefined}
            tabIndex={canOpen ? 0 : undefined}
            className={`group relative flex items-center gap-1.5 rounded-md border px-1.5 py-1 ${text} ${canOpen ? 'cursor-pointer' : ''} ${a.error ? 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-900/20' : 'border-stone-200 bg-stone-50 dark:border-stone-600 dark:bg-stone-700/60'}`}
            title={a.error ? a.error : canOpen ? `View ${a.filename}` : a.filename}
            aria-label={canOpen ? `View ${a.filename}` : undefined}
          >
            {a.previewUrl ? (
              <img src={a.previewUrl} alt={a.filename} className={`${thumb} rounded object-cover shrink-0`} />
            ) : (
              <FileText className={`${size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'} text-stone-400 shrink-0`} />
            )}
            <span className="max-w-[120px] truncate text-stone-600 dark:text-stone-300">{a.filename}</span>
            {a.uploading && <LoaderCircle className="w-3 h-3 animate-spin text-stone-400 shrink-0" />}
            {a.error && <span className="text-red-500 shrink-0">failed</span>}
            {onRemove && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRemove(a.id) }}
                className="ml-0.5 rounded p-0.5 text-stone-400 hover:text-stone-700 hover:bg-stone-200 dark:hover:text-stone-100 dark:hover:bg-stone-600 cursor-pointer shrink-0"
                aria-label={`Remove ${a.filename}`}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
})
