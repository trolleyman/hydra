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
  // Opens the given images starting at `index` (clamped; defaults to the first).
  // A single image simply has no prev/next arrows. A no-op for an empty array.
  open: (images: LightboxImage[], index?: number) => void
  setIndex: (index: number) => void
  close: () => void
}

export const useImageLightboxStore = create<ImageLightboxState>((set) => ({
  images: null,
  index: 0,
  open: (images, index = 0) => {
    if (images.length === 0) return
    set({ images, index: Math.max(0, Math.min(index, images.length - 1)) })
  },
  setIndex: (index) =>
    set((s) => (s.images ? { index: Math.max(0, Math.min(index, s.images.length - 1)) } : {})),
  close: () => set({ images: null }),
}))

// useImageLightbox returns the opener, keeping the same call signature the old
// context hook exposed so callers (e.g. RepositoryArtifactsView) are unchanged.
export function useImageLightbox(): ImageLightboxState['open'] {
  return useImageLightboxStore((s) => s.open)
}
