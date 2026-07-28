import { create } from 'zustand'
import type { LightboxImage } from '../components/ImageLightbox'

// App-wide fullscreen image lightbox. A global, imperatively-opened overlay in
// the same shape as useToastStore/useDialogStore: any component calls open() to
// show one or more images, and a single <ImageLightboxHost> near the app root
// (mirroring <Toaster>) renders the actual lightbox. The lightbox portals to
// <body>, so there is nothing subtree-scoped that would need a React context.
interface ImageLightboxState {
  // null when closed; a non-empty array (with the active index) when open.
  images: LightboxImage[] | null
  index: number
  // The element the lightbox was opened from - the thumbnail that was clicked (or a
  // wrapper around it). The lightbox flies the picture out of that element's box on
  // open and back into it on close; null (an opener that didn't supply one, or a
  // keyboard-driven open) just means a plain fade instead. See lib/lightboxFlip.
  origin: Element | null
  // Opens the given images starting at `index` (clamped; defaults to the first).
  // A single image simply has no prev/next arrows. A no-op for an empty array.
  open: (images: LightboxImage[], index?: number, origin?: Element | null) => void
  setIndex: (index: number) => void
  close: () => void
}

export const useImageLightboxStore = create<ImageLightboxState>((set) => ({
  images: null,
  index: 0,
  origin: null,
  open: (images, index = 0, origin = null) => {
    if (images.length === 0) return
    set({ images, index: Math.max(0, Math.min(index, images.length - 1)), origin })
  },
  setIndex: (index) =>
    set((s) => (s.images ? { index: Math.max(0, Math.min(index, s.images.length - 1)) } : {})),
  close: () => set({ images: null, origin: null }),
}))

// useImageLightbox returns the opener, keeping the same call signature the old
// context hook exposed so callers (e.g. RepositoryArtifactsView) are unchanged.
export function useImageLightbox(): ImageLightboxState['open'] {
  return useImageLightboxStore((s) => s.open)
}
