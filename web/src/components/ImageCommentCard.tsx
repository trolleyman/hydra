import { MessageSquare } from 'lucide-react'
import type { ReviewImageAnchor } from '../api'
import { anchorPointLabel, artifactBlobUrl } from '../lib/artifactAnchor'
import { getFileIcon } from '../lib/fileIcons'
import { cropRect } from '../lib/imageCrop'
import { Markdown } from '../lib/MarkdownRenderer'
import { useLightboxStore } from '../stores/lightboxStore'

// A remark about a spot in a picture, rendered as one readable thing.
//
// A comment that carries only coordinates can be shown as text - "#8 home.png @
// 62%,28%" - but that is a reference to a picture rather than a picture, and the
// reader has to go and look before the remark means anything. With the spot
// shown beside it, the whole point is legible in a row: here is where, here is
// what is wrong with it.
//
// The close-up is a window onto the LIVE artifact, framed with CSS. That works
// because the cache entry a comment anchors to is pinned against pruning
// server-side (artifacts.Pin), so the original outlives the comment - which is
// both less machinery than storing a derived copy and more useful, since
// clicking through opens the whole picture rather than a thumbnail of it.

export function ImageCommentCard({ comment, projectId, onOpen }: {
  comment: {
    number: number
    text: string
    author: string
    published: boolean
    resolved?: boolean
    image?: ReviewImageAnchor
  }
  /** Needed to address the artifact blob the close-up is drawn from. */
  projectId: string | null
  /** Called instead of the default lightbox open, when a caller wants the click
   *  to navigate somewhere of its own (a permalink to the comment, say). */
  onOpen?: () => void
}) {
  const openLightbox = useLightboxStore((s) => s.open)
  const a = comment.image
  if (!a) return null
  const url = artifactBlobUrl(projectId, a)
  // The close-up is a WINDOW onto the live file, not a stored copy: the artifact
  // entry a comment points at is pinned against pruning, so the original is still
  // there. Framed with background-position rather than a canvas, so nothing is
  // decoded or copied to show it - and the same arithmetic (lib/imageCrop) that
  // decided what a crop would have contained decides what this shows.
  //
  // Sized in PERCENTAGES rather than pixels, which is what lets the picture span
  // whatever width the card gets instead of a fixed thumbnail: the background
  // scales with the box, and `aspect-ratio` from the region keeps it undistorted
  // at any width. (Percentage background-position is relative to the leftover
  // space, hence the (natural - rect) divisor rather than natural.)
  const frame = url && a.natural_w && a.natural_h
    ? (() => {
        const rect = cropRect({ x: a.x, y: a.y, w: a.w, h: a.h }, a.natural_w, a.natural_h)
        const offset = (o: number, natural: number, size: number) =>
          natural <= size ? 0 : (o / (natural - size)) * 100
        return {
          aspectRatio: `${rect.w} / ${rect.h}`,
          backgroundImage: `url("${url}")`,
          backgroundSize: `${(a.natural_w / rect.w) * 100}% ${(a.natural_h / rect.h) * 100}%`,
          backgroundPosition: `${offset(rect.x, a.natural_w, rect.w)}% ${offset(rect.y, a.natural_h, rect.h)}%`,
          backgroundRepeat: 'no-repeat',
        } satisfies React.CSSProperties
      })()
    : null
  const open = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onOpen) { onOpen(); return }
    // Opens the WHOLE picture, not the close-up - which is the other half of
    // keeping the original: there is more to look at than the crop showed.
    if (url) {
      openLightbox([{ url, filename: a.file, size: 0, width: a.natural_w, height: a.natural_h }], 0, e.currentTarget)
    }
  }
  const slash = a.file.lastIndexOf('/')
  const directory = slash >= 0 ? a.file.slice(0, slash + 1) : ''
  const fileName = slash >= 0 ? a.file.slice(slash + 1) : a.file
  const { Icon: FileIcon, className: fileIconClass } = getFileIcon(fileName)
  return (
    // Stacked, and NOT a card: the file line, the picture, the remark. Side by
    // side the picture took a third of a narrow row and left the rest fighting
    // over what was left; a bordered box around it then made a list of comments
    // read as a list of panels rather than a list of remarks.
    <div className="min-w-0">
      {/* Deliberately the same file line as a line comment's, down to the icon
          and the lowlit directory - two kinds of comment in one list should not
          announce themselves in two different visual languages. The position sits
          where the line number does, and is the only thing left in mono: it is a
          coordinate, and it lines up when several are stacked. */}
      <div className="flex items-center gap-1.5 text-2xs text-gray-500 dark:text-gray-400">
        <FileIcon className={`w-3.5 h-3.5 shrink-0 ${fileIconClass}`} />
        <span className="truncate" title={a.file}>
          {directory && <span className="text-gray-400 dark:text-gray-500">{directory}</span>}
          <span>{fileName}</span>
        </span>
        <span className="shrink-0 font-mono text-gray-400 dark:text-gray-500">@ {anchorPointLabel(a)}</span>
      </div>
      {frame ? (
        <button
          type="button"
          onClick={open}
          className="block w-full mt-1.5 cursor-zoom-in"
          aria-label={`Open ${a.file}, the picture comment #${comment.number} is on`}
        >
          <div
            className="w-full rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950"
            style={frame}
          />
        </button>
      ) : (
        // No natural size recorded, or nothing to address the blob with. The
        // remark is still worth showing - it just costs a trip to the picture to
        // place, which is what the position above is for.
        <div className="w-full h-14 mt-1.5 rounded border border-dashed border-gray-300 dark:border-gray-700 flex items-center justify-center">
          <MessageSquare className="w-5 h-5 text-gray-400 dark:text-gray-600" />
        </div>
      )}
      <div className={`mt-1.5 text-xs ${comment.resolved ? 'text-gray-400 dark:text-gray-500 line-through' : 'text-gray-800 dark:text-gray-200'}`}>
        <Markdown text={comment.text} variant="chat" />
      </div>
    </div>
  )
}
