import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { ImageLightbox, type LightboxImage } from './ImageLightbox'

// openImage opens one or more images in the shared fullscreen lightbox, starting
// at `index` (defaults to the first). With a single image the lightbox simply has
// no prev/next arrows.
type OpenImage = (images: LightboxImage[], index?: number) => void

const ImageLightboxContext = createContext<OpenImage | null>(null)

// useImageLightbox returns a function that opens images in the app-wide lightbox.
// If no provider is mounted (e.g. an isolated unit render) it falls back to opening
// the chosen image in a new tab, so a caller always does something sensible.
export function useImageLightbox(): OpenImage {
  const open = useContext(ImageLightboxContext)
  return open ?? ((images, index = 0) => {
    const img = images[index]
    if (img) window.open(img.url, '_blank', 'noopener,noreferrer')
  })
}

// ImageLightboxProvider holds the single lightbox instance for its subtree, so any
// descendant can open an image fullscreen via useImageLightbox() without threading
// state through every component in between. The lightbox portals to <body>, so one
// provider near the app root covers the whole UI.
export function ImageLightboxProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ images: LightboxImage[]; index: number } | null>(null)
  const open = useCallback<OpenImage>((images, index = 0) => {
    if (images.length === 0) return
    setState({ images, index: Math.max(0, Math.min(index, images.length - 1)) })
  }, [])
  return (
    <ImageLightboxContext.Provider value={open}>
      {children}
      {state && (
        <ImageLightbox
          images={state.images}
          index={Math.min(state.index, state.images.length - 1)}
          onIndexChange={(i) => setState((s) => (s ? { ...s, index: i } : s))}
          onClose={() => setState(null)}
        />
      )}
    </ImageLightboxContext.Provider>
  )
}
