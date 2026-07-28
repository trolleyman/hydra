import { create } from 'zustand'
import type { LightboxItem } from '../components/Lightbox'

// App-wide fullscreen file lightbox. A global, imperatively-opened overlay in
// the same shape as useToastStore/useDialogStore: any component calls open() to
// show one or more files - pictures, video, PDFs, text, or a binary that can only
// be downloaded - and a single <LightboxHost> near the app root (mirroring
// <Toaster>) renders the actual lightbox. The lightbox portals to <body>, so
// there is nothing subtree-scoped that would need a React context.
interface LightboxState {
  // null when closed; a non-empty array (with the active index) when open.
  items: LightboxItem[] | null
  index: number
  // The element the lightbox was opened from - the thumbnail that was clicked (or a
  // wrapper around it). The lightbox flies the picture out of that element's box on
  // open and back into it on close; null (an opener that didn't supply one, or a
  // keyboard-driven open) just means a plain fade instead. See lib/lightboxFlip.
  origin: Element | null
  // Opens the given items starting at `index` (clamped; defaults to the first).
  // A single item simply has no prev/next arrows. A no-op for an empty array.
  open: (items: LightboxItem[], index?: number, origin?: Element | null) => void
  setIndex: (index: number) => void
  close: () => void
}

export const useLightboxStore = create<LightboxState>((set) => ({
  items: null,
  index: 0,
  origin: null,
  open: (items, index = 0, origin = null) => {
    if (items.length === 0) return
    set({ items, index: Math.max(0, Math.min(index, items.length - 1)), origin })
  },
  setIndex: (index) =>
    set((s) => (s.items ? { index: Math.max(0, Math.min(index, s.items.length - 1)) } : {})),
  close: () => set({ items: null, origin: null }),
}))

// useLightbox returns the opener, keeping the same call signature the old
// context hook exposed so callers (e.g. RepositoryArtifactsView) are unchanged.
export function useLightbox(): LightboxState['open'] {
  return useLightboxStore((s) => s.open)
}
