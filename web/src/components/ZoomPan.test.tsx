import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ZoomPan } from './ZoomPan'

// Covers the zoom/pan interaction layer: wheel zoom eases briefly (a fast glide
// instead of a jump), drag-pan tracks the pointer 1:1 (no ease), and the corner
// minimap scales down on small (phone-sized) frames instead of crowding the image.
//
// jsdom computes no layout, so the frame size ZoomPan measures (clientWidth/Height)
// is mocked per render; ResizeObserver (absent in jsdom) is stubbed - ZoomPan also
// measures directly in its mount effect, so a no-op observer is enough.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)

let frame = { w: 800, h: 600 }
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => frame.w })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => frame.h })
})
afterAll(() => {
  delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth
  delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight
})

function renderZoomPan(w = 800, h = 600) {
  frame = { w, h }
  const utils = render(
    <ZoomPan minimapSrc="mini.png">
      <img src="img.png" alt="content" />
    </ZoomPan>,
  )
  const viewport = utils.container.firstElementChild as HTMLElement
  // The transformed wrapper the zoom/pan applies to.
  const content = viewport.firstElementChild as HTMLElement
  return { ...utils, viewport, content }
}

// jsdom rects are all zeros, so wheel coords are frame-relative as-is; zooming at
// (0,0) keeps the content's top-left corner fixed (tx/ty stay 0).
function zoomIn(viewport: HTMLElement) {
  fireEvent.wheel(viewport, { deltaY: -400, clientX: 0, clientY: 0 })
}

function currentScale(content: HTMLElement): number {
  const m = /scale\(([\d.]+)\)/.exec(content.style.transform)
  return m ? parseFloat(m[1]) : NaN
}

describe('ZoomPan wheel zoom', () => {
  it('magnifies with a short ease so the step glides rather than jumps', () => {
    const { viewport, content } = renderZoomPan()
    zoomIn(viewport)
    expect(currentScale(content)).toBeGreaterThan(1)
    expect(content.style.transition).toBe('transform 120ms ease-out')
  })

  it('never zooms out past fit (scale 1)', () => {
    const { viewport, content } = renderZoomPan()
    fireEvent.wheel(viewport, { deltaY: 800, clientX: 0, clientY: 0 })
    expect(content.style.transform).toContain('scale(1)')
  })
})

describe('ZoomPan drag-pan', () => {
  it('tracks the pointer 1:1 with no transition once zoomed', () => {
    const { viewport, content } = renderZoomPan()
    zoomIn(viewport)

    fireEvent.pointerDown(viewport, { button: 0, clientX: 200, clientY: 200 })
    fireEvent.pointerMove(window, { clientX: 150, clientY: 180 })

    // A -50/-20 pointer move pans exactly -50/-20 (well inside the clamp bounds
    // at this scale), and the ease from the preceding wheel zoom is switched off
    // so the image stays glued to the cursor.
    expect(content.style.transform).toContain('translate(-50px, -20px)')
    expect(content.style.transition).toBe('')

    fireEvent.pointerUp(window)
  })

  it('clamps the pan so the content always covers the frame', () => {
    const { viewport, content } = renderZoomPan(800, 600)
    zoomIn(viewport) // scale ≈ 1.822 at the top-left corner → tx/ty stay 0

    // Dragging right/down would open a gutter above/left of the content; both
    // axes clamp at 0.
    fireEvent.pointerDown(viewport, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 400, clientY: 400 })
    expect(content.style.transform).toContain('translate(0px, 0px)')
    fireEvent.pointerUp(window)
  })

  it('swallows the trailing click after a real pan (no accidental activation underneath)', () => {
    const clicked = vi.fn()
    frame = { w: 800, h: 600 }
    const { container } = render(
      <div onClick={clicked}>
        <ZoomPan minimapSrc="mini.png">
          <img src="img.png" alt="content" />
        </ZoomPan>
      </div>,
    )
    const viewport = container.firstElementChild!.firstElementChild as HTMLElement
    zoomIn(viewport)

    fireEvent.pointerDown(viewport, { button: 0, clientX: 200, clientY: 200 })
    fireEvent.pointerMove(window, { clientX: 100, clientY: 100 })
    fireEvent.pointerUp(window)
    fireEvent.click(viewport)
    expect(clicked).not.toHaveBeenCalled()

    // A plain click (no drag) still bubbles normally.
    fireEvent.click(viewport)
    expect(clicked).toHaveBeenCalledTimes(1)
  })
})

describe('ZoomPan minimap', () => {
  const minimap = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-zoompan-minimap]')

  it('keeps its full 140px width on a roomy frame', () => {
    const { viewport, container } = renderZoomPan(1200, 800)
    zoomIn(viewport)
    const mm = minimap(container)!
    expect(mm.style.width).toBe('140px')
    expect(mm.style.height).toBe(`${Math.round(140 * 800 / 1200)}px`)
  })

  it('shrinks to a quarter of a phone-sized frame (height follows the aspect)', () => {
    const { viewport, container } = renderZoomPan(360, 740)
    zoomIn(viewport)
    const mm = minimap(container)!
    expect(mm.style.width).toBe('90px') // 360 / 4
    expect(mm.style.height).toBe(`${Math.round(90 * 740 / 360)}px`)
  })

  it('Reset view returns to fit with the longer glide ease', () => {
    const { viewport, content, getByRole } = renderZoomPan()
    zoomIn(viewport)
    fireEvent.click(getByRole('button', { name: /Reset view/ }))
    expect(content.style.transform).toContain('scale(1)')
    expect(content.style.transition).toBe('transform 200ms ease-out')
  })
})
