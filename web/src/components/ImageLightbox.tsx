import { Fragment, useCallback, useEffect, useState } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'

export interface LightboxImage {
  url: string
  filename: string
  /** File size in bytes, shown in the caption. */
  size: number
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// A Slack-style fullscreen image viewer: a blurred dark backdrop with the image
// centered, optional prev/next arrows when there's more than one image, and
// keyboard support (Esc closes, ←/→ navigate). Clicking the backdrop closes it.
export function ImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: LightboxImage[]
  index: number
  onIndexChange: (i: number) => void
  onClose: () => void
}) {
  const count = images.length
  const prev = useCallback(() => onIndexChange((index - 1 + count) % count), [index, count, onIndexChange])
  const next = useCallback(() => onIndexChange((index + 1) % count), [index, count, onIndexChange])
  // Natural pixel dimensions of the current image, read once it loads. Cleared
  // on navigation so a stale size never flashes against the next image.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => { setDims(null) }, [index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') prev()
      else if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, onClose])

  const current = images[index]
  if (!current) return null

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 backdrop-blur-md animate-in fade-in duration-150"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* Close button */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors cursor-pointer"
      >
        <X className="w-5 h-5" />
      </button>

      {/* Previous arrow */}
      {count > 1 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); prev() }}
          aria-label="Previous image"
          className="absolute left-4 p-2 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors cursor-pointer"
        >
          <ChevronLeft className="w-7 h-7" />
        </button>
      )}

      {/* Image + caption (clicks here don't close) */}
      <figure
        className="flex flex-col items-center gap-3 max-w-[90vw] max-h-[90vh] animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={current.url}
          alt={current.filename}
          onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          // Checkerboard behind the image so transparent PNGs (e.g. an icon)
          // read as transparent rather than blending into the dark backdrop. The
          // <img> sizes to the image's own aspect ratio, so this sits exactly
          // behind the picture; opaque images simply cover it.
          style={{
            background: 'repeating-conic-gradient(#bfbfbf 0% 25%, #f5f5f5 0% 50%) 0 0 / 20px 20px',
          }}
          className="max-h-[85vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
        />
        <figcaption className="flex items-center gap-2 text-xs font-mono">
          {[
            <span key="name" className="text-white/70">{current.filename}</span>,
            dims && <span key="dims" className="text-white/40">{dims.w} × {dims.h}</span>,
            <span key="size" className="text-white/40">{formatBytes(current.size)}</span>,
            count > 1 && <span key="count" className="text-white/40">{index + 1} / {count}</span>,
          ]
            .filter(Boolean)
            .map((part, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="text-white/30">·</span>}
                {part}
              </Fragment>
            ))}
        </figcaption>
      </figure>

      {/* Next arrow */}
      {count > 1 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); next() }}
          aria-label="Next image"
          className="absolute right-4 p-2 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors cursor-pointer"
        >
          <ChevronRight className="w-7 h-7" />
        </button>
      )}
    </div>
  )
}
