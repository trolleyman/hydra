import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ImageLightbox, type LightboxImage } from './ImageLightbox'

// Covers the lightbox's close-on-backdrop behaviour. Closing must require the
// pointer press to START on the backdrop: a drag that begins on the image (panning
// while zoomed, or dragging a diff slider) and releases past the image's edge makes
// the browser fire the trailing click on the press/release common ancestor — the
// backdrop — and that must NOT close the viewer.
//
// ZoomPan (rendered around the image) needs a ResizeObserver; jsdom has none, and a
// no-op stub is fine — the zero-sized frame jsdom measures just means no minimap.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)

const images: LightboxImage[] = [
  { url: 'shot.png', filename: 'shot.png', size: 1234 },
]

function renderLightbox() {
  const onClose = vi.fn()
  render(<ImageLightbox images={images} index={0} onIndexChange={() => {}} onClose={onClose} />)
  return { onClose, backdrop: screen.getByRole('dialog') }
}

describe('ImageLightbox closing', () => {
  it('closes when the backdrop is pressed and clicked directly', () => {
    const { onClose, backdrop } = renderLightbox()
    fireEvent.pointerDown(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT close when a drag starts on the image and the click lands on the backdrop', () => {
    const { onClose, backdrop } = renderLightbox()
    const img = screen.getByAltText('shot.png')

    // Press on the image, release over the backdrop: the browser dispatches the
    // synthesized click on their common ancestor (the backdrop). Reproduced here
    // by pressing on the img and firing the click on the backdrop directly.
    fireEvent.pointerDown(img)
    fireEvent.pointerMove(window, { clientX: 300, clientY: 300 })
    fireEvent.pointerUp(window)
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()

    // A subsequent genuine backdrop click still closes (the press tracking resets).
    fireEvent.pointerDown(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close on clicks on the image itself', () => {
    const { onClose } = renderLightbox()
    const img = screen.getByAltText('shot.png')
    fireEvent.pointerDown(img)
    fireEvent.click(img)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const { onClose } = renderLightbox()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
