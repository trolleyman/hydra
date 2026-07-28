import { Lightbox } from './Lightbox'
import { useLightboxStore } from '../stores/lightboxStore'

// Renders the single app-wide file lightbox driven by useLightboxStore.
// Mount once near the app root (mirrors <Toaster> for useToastStore). The
// lightbox itself portals to <body>, so its position in the tree doesn't matter.
export function LightboxHost() {
  const items = useLightboxStore((s) => s.items)
  const index = useLightboxStore((s) => s.index)
  const origin = useLightboxStore((s) => s.origin)
  const setIndex = useLightboxStore((s) => s.setIndex)
  const close = useLightboxStore((s) => s.close)
  if (!items) return null
  return (
    <Lightbox
      items={items}
      index={Math.min(index, items.length - 1)}
      origin={origin}
      onIndexChange={setIndex}
      onClose={close}
    />
  )
}
