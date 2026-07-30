import { MessageSquare } from 'lucide-react'
import type { ReviewImageAnchor } from '../api'
import { anchorPositionLabel, anchorVersionLabel } from '../lib/artifactAnchor'
import { Markdown } from '../lib/MarkdownRenderer'
import { useLightboxStore } from '../stores/lightboxStore'

// A remark about a spot in a picture, rendered as one readable thing.
//
// This is what the frozen crop exists for. A comment that carries only
// coordinates can be shown as text - "#8 home.png @ 62%,28%" - but that is a
// reference to a picture rather than a picture, and the reader has to go and
// look before the remark means anything. With the close-up beside it, the whole
// point is legible in a chat row: here is the spot, here is what is wrong with
// it.
//
// The same card serves every surface that has to show one (the chat, a review
// list, a reply two rounds later), which is the other half of why the crop is
// stored rather than re-derived: none of those surfaces has the artifact.

export function ImageCommentCard({ comment, className, onOpen }: {
  comment: {
    number: number
    text: string
    author: string
    published: boolean
    resolved?: boolean
    image?: ReviewImageAnchor
  }
  className?: string
  /** Called instead of the default lightbox open, when a caller wants the click
   *  to navigate somewhere of its own (a permalink to the comment, say). */
  onOpen?: () => void
}) {
  const openLightbox = useLightboxStore((s) => s.open)
  const a = comment.image
  if (!a) return null
  const cropUrl = a.crop_url
  const open = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onOpen) { onOpen(); return }
    // The crop is a thumbnail of a moment that may no longer exist; opening it
    // shows what was pinned, not what the artifact looks like now. That is the
    // honest thing to show from a card that is itself a record.
    if (cropUrl) {
      openLightbox([{ url: cropUrl, filename: `${a.file} @ ${anchorPositionLabel(a)}`, size: 0 }], 0, e.currentTarget)
    }
  }
  return (
    <div className={`flex gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 ${className ?? ''}`}>
      {cropUrl ? (
        <button
          type="button"
          onClick={open}
          className="shrink-0 cursor-zoom-in"
          aria-label={`Open the close-up for comment #${comment.number}`}
        >
          <img
            src={cropUrl}
            alt=""
            // Capped rather than sized: a crop of a wide region and one of a tall
            // region should both read as the same kind of thumbnail.
            className="block max-w-32 max-h-24 rounded border border-gray-200 dark:border-gray-700 object-contain bg-white dark:bg-gray-950"
          />
        </button>
      ) : (
        // A comment written before crops existed, or one whose crop could not be
        // drawn. The remark is still worth showing - it just costs a trip to the
        // picture to place, which is what the anchor line below is for.
        <div className="shrink-0 w-16 h-16 rounded border border-dashed border-gray-300 dark:border-gray-700 flex items-center justify-center">
          <MessageSquare className="w-5 h-5 text-gray-400 dark:text-gray-600" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        {/* Two lines, not one row of four truncating spans: in a narrow column
            they shared the width evenly and every one of them collapsed to an
            ellipsis, so the header read "h. · 57… ·" and said nothing. The
            filename gets a line with the handle, and the coordinates get their
            own - each can then use the full width. */}
        <div className="flex items-baseline gap-1.5 text-3xs font-mono text-gray-500 dark:text-gray-400">
          <span className="truncate" title={a.file}>{a.file}</span>
          <span className="ml-auto shrink-0 tabular-nums text-gray-400 dark:text-gray-500">
            {comment.published ? `#${comment.number}` : 'draft'}
          </span>
        </div>
        <div className="truncate text-3xs font-mono text-gray-400 dark:text-gray-500 mb-1">
          {anchorPositionLabel(a)}
          {a.key && ` · ${anchorVersionLabel(a)}`}
        </div>
        <div className={`text-xs ${comment.resolved ? 'text-gray-400 dark:text-gray-500 line-through' : 'text-gray-800 dark:text-gray-200'}`}>
          <Markdown text={comment.text} variant="chat" />
        </div>
      </div>
    </div>
  )
}
