import { useCallback, useEffect } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'

export interface LightboxImage {
  url: string
  filename: string
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
          className="max-h-[85vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
        />
        <figcaption className="text-xs text-white/70 font-mono">
          {current.filename}
          {count > 1 && <span className="ml-2 text-white/40">{index + 1} / {count}</span>}
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
