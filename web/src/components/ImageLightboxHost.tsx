import { ImageLightbox } from './ImageLightbox'
import { useImageLightboxStore } from '../stores/imageLightboxStore'

// Renders the single app-wide image lightbox driven by useImageLightboxStore.
// Mount once near the app root (mirrors <Toaster> for useToastStore). The
// lightbox itself portals to <body>, so its position in the tree doesn't matter.
export function ImageLightboxHost() {
  const images = useImageLightboxStore((s) => s.images)
  const index = useImageLightboxStore((s) => s.index)
  const setIndex = useImageLightboxStore((s) => s.setIndex)
  const close = useImageLightboxStore((s) => s.close)
  if (!images) return null
  return (
    <ImageLightbox
      images={images}
      index={Math.min(index, images.length - 1)}
      onIndexChange={setIndex}
      onClose={close}
    />
  )
}
