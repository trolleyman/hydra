import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { VideoDiffView } from './VideoDiffView'
import { useLightboxStore } from '../stores/lightboxStore'
import type { LightboxItem } from './Lightbox'

// A .webm artifact used to be the one tile in the grid a click did nothing to -
// the lightbox could only show pictures, so video was left out of the gallery and
// out of the click handlers. These pin the plumbing that fixed it: every mode
// opens the shared gallery at this file's index, and the same views rendered
// INSIDE the lightbox (disableOpen) must not open a second one on top of
// themselves.
//
// jsdom stubs: <video>.play is unimplemented (the transport calls it on attach),
// and requestAnimationFrame drives the sync loop.
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
  window.HTMLMediaElement.prototype.pause = vi.fn()
})
afterAll(() => vi.unstubAllGlobals())
afterEach(() => {
  cleanup()
  useLightboxStore.setState({ items: null, index: 0, origin: null })
})

const gallery: LightboxItem[] = [
  { url: 'home.png', filename: 'home.png', size: 0, kind: 'image' },
  { url: 'after.webm', filename: 'loader.webm', size: 0, kind: 'video' },
]

function renderView(mode: 'side-by-side' | 'ab' | 'slider' | 'onion', over: { disableOpen?: boolean } = {}) {
  return render(
    <VideoDiffView
      mode={mode}
      left="before.webm"
      right="after.webm"
      name="loader.webm"
      gallery={gallery}
      index={1}
      {...over}
    />,
  )
}

// The clickable media box each mode marks with data-lb-picture (side-by-side has
// a button per cell instead, so it is queried separately).
const picture = () => document.querySelector('[data-lb-picture]') as HTMLElement

describe('VideoDiffView click-to-open', () => {
  it.each(['ab', 'slider', 'onion'] as const)('opens the gallery at this file from %s mode', (mode) => {
    renderView(mode)
    fireEvent.click(picture())
    const state = useLightboxStore.getState()
    expect(state.items).toBe(gallery)
    expect(state.index).toBe(1)
  })

  it('opens from a side-by-side cell', () => {
    const { container } = renderView('side-by-side')
    // The frames, not the transport's own buttons below them.
    const cells = Array.from(container.querySelectorAll('button')).filter((b) => b.querySelector('video'))
    expect(cells.length).toBe(2)
    fireEvent.click(cells[1])
    expect(useLightboxStore.getState().index).toBe(1)
  })

  it('does not open a nested lightbox when rendered inside one', () => {
    renderView('ab', { disableOpen: true })
    fireEvent.click(picture())
    expect(useLightboxStore.getState().items).toBeNull()
  })

  it('falls back to the single clicked clip with no gallery threaded down', () => {
    render(<VideoDiffView mode="ab" left="before.webm" right="after.webm" name="loader.webm" />)
    fireEvent.click(picture())
    const items = useLightboxStore.getState().items
    // Typed as video off its name, so the fallback lands on the player rather
    // than on a broken picture.
    expect(items).toEqual([{ url: 'after.webm', filename: 'loader.webm', size: 0, kind: 'video' }])
  })

  it('shows the transport whatever the mode', () => {
    renderView('ab')
    expect(screen.getByLabelText('Pause')).toBeTruthy()
    expect(screen.getByLabelText('Next frame')).toBeTruthy()
  })
})
