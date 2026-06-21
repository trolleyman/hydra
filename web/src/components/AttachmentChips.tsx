import { X, FileText, LoaderCircle } from 'lucide-react'
import type { Attachment } from '../lib/spawnDrafts'

// A row of attachment chips, shared by the spawn form and the agent terminal.
// Image attachments show a thumbnail and open a fullscreen lightbox on click
// (the parent owns the lightbox and resolves the clicked id to an image index);
// other files show a generic icon and aren't clickable. An upload in progress
// shows a spinner; a failed one is flagged. `className` styles the outer row so
// each caller can place/pad it to fit its layout. Renders nothing when empty.
export function AttachmentChips({
  attachments,
  size,
  onRemove,
  onOpenImage,
  className,
}: {
  attachments: Attachment[]
  size: 'sm' | 'md'
  /** Omit to render read-only chips (no remove button), e.g. a submitted prompt. */
  onRemove?: (id: number) => void
  onOpenImage: (id: number) => void
  className?: string
}) {
  if (attachments.length === 0) return null
  const thumb = size === 'sm' ? 'w-6 h-6' : 'w-8 h-8'
  const text = size === 'sm' ? 'text-[10px]' : 'text-xs'
  return (
    <div className={`flex flex-wrap gap-1.5 ${className ?? ''}`}>
      {attachments.map((a) => {
        const isImage = !!a.previewUrl
        const open = isImage ? () => onOpenImage(a.id) : undefined
        return (
          <div
            key={a.id}
            onClick={open}
            onKeyDown={open ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } } : undefined}
            role={isImage ? 'button' : undefined}
            tabIndex={isImage ? 0 : undefined}
            className={`group relative flex items-center gap-1.5 rounded-md border px-1.5 py-1 ${text} ${isImage ? 'cursor-pointer' : ''} ${a.error ? 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-900/20' : 'border-gray-200 bg-gray-50 dark:border-gray-600 dark:bg-gray-700/60'}`}
            title={a.error ? a.error : isImage ? `View ${a.filename}` : a.filename}
            aria-label={isImage ? `View ${a.filename}` : undefined}
          >
            {a.previewUrl ? (
              <img src={a.previewUrl} alt={a.filename} className={`${thumb} rounded object-cover shrink-0`} />
            ) : (
              <FileText className={`${size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'} text-gray-400 shrink-0`} />
            )}
            <span className="max-w-[120px] truncate text-gray-600 dark:text-gray-300">{a.filename}</span>
            {a.uploading && <LoaderCircle className="w-3 h-3 animate-spin text-gray-400 shrink-0" />}
            {a.error && <span className="text-red-500 shrink-0">failed</span>}
            {onRemove && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRemove(a.id) }}
                className="ml-0.5 rounded p-0.5 text-gray-400 hover:text-gray-700 hover:bg-gray-200 dark:hover:text-gray-100 dark:hover:bg-gray-600 cursor-pointer shrink-0"
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
}
