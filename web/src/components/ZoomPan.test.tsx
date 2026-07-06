import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ZoomPan } from './ZoomPan'

// Covers the zoom/pan interaction layer: wheel zoom tracks the wheel directly (no
// ease, like drag-pan - an ease made fast scrolls wobble), drag-pan tracks the
// pointer 1:1, and the minimap (portaled to <body>, screen-fixed) scales down on
// small (phone-sized) frames instead of crowding the image.
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
  it('magnifies directly with no ease (so a fast scroll cannot wobble)', () => {
    const { viewport, content } = renderZoomPan()
    zoomIn(viewport)
    expect(currentScale(content)).toBeGreaterThan(1)
    expect(content.style.transition).toBe('')
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

  it('ends the pan on pointercancel (no stuck grabbing state)', () => {
    const { viewport } = renderZoomPan()
    zoomIn(viewport)
    fireEvent.pointerDown(viewport, { button: 0, clientX: 200, clientY: 200 })
    expect(viewport.style.cursor).toBe('grabbing')
    // The browser takes the pointer away (e.g. a touch gesture) - the pan must
    // still end rather than leaking its listeners and sticking in grabbing mode.
    fireEvent.pointerCancel(window)
    expect(viewport.style.cursor).toBe('grab')
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

describe('ZoomPan pinch zoom', () => {
  it('two touch pointers pinch-zoom by their distance ratio (works from fit)', () => {
    const { viewport, content } = renderZoomPan()
    // Two fingers land 100px apart...
    fireEvent.pointerDown(viewport, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 })
    fireEvent.pointerDown(viewport, { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 100 })
    // ...and spread to 200px apart: 2× the distance → 2× the scale.
    fireEvent.pointerMove(window, { pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 100 })
    expect(currentScale(content)).toBeCloseTo(2, 1)
    fireEvent.pointerUp(window, { pointerId: 2, pointerType: 'touch' })
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'touch' })
  })

  it('never pinches out below fit and stops zooming once a finger lifts', () => {
    const { viewport, content } = renderZoomPan()
    fireEvent.pointerDown(viewport, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 })
    fireEvent.pointerDown(viewport, { pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 100 })
    // Pinch IN below fit: clamped at scale 1.
    fireEvent.pointerMove(window, { pointerId: 2, pointerType: 'touch', clientX: 150, clientY: 100 })
    expect(content.style.transform).toContain('scale(1)')
    // One finger lifts - the survivor's moves are no longer a pinch.
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerMove(window, { pointerId: 2, pointerType: 'touch', clientX: 400, clientY: 100 })
    expect(content.style.transform).toContain('scale(1)')
    fireEvent.pointerUp(window, { pointerId: 2, pointerType: 'touch' })
  })
})

describe('ZoomPan minimap', () => {
  // The minimap is portaled to <body> (pinned to the screen, not the growing frame),
  // so it lives outside the render container - look for it document-wide.
  const minimap = () =>
    document.body.querySelector<HTMLElement>('[data-zoompan-minimap]')

  it('keeps its full 140px width on a roomy frame', () => {
    const { viewport } = renderZoomPan(1200, 800)
    zoomIn(viewport)
    const mm = minimap()!
    expect(mm.style.width).toBe('140px')
    expect(mm.style.height).toBe(`${Math.round(140 * 800 / 1200)}px`)
  })

  it('shrinks to a quarter of a phone-sized frame (height follows the aspect)', () => {
    const { viewport } = renderZoomPan(360, 740)
    zoomIn(viewport)
    const mm = minimap()!
    expect(mm.style.width).toBe('90px') // 360 / 4
    expect(mm.style.height).toBe(`${Math.round(90 * 740 / 360)}px`)
  })

  it('glides on a minimap press but tracks 1:1 once the pointer drags', () => {
    const { viewport, content } = renderZoomPan()
    zoomIn(viewport)
    const mm = minimap()!
    // The press is a deliberate go-there jump: it eases.
    fireEvent.pointerDown(mm, { button: 0, clientX: 10, clientY: 10 })
    expect(content.style.transition).toBe('transform 200ms ease-out')
    // A drag must NOT keep the ease - restarting a 200ms glide on every move would
    // trail the pointer (the view chases where the cursor used to be).
    fireEvent.pointerMove(window, { clientX: 40, clientY: 10 })
    expect(content.style.transition).toBe('')
    fireEvent.pointerUp(window)
  })

  it('Reset view returns to fit with the longer glide ease', () => {
    const { viewport, content, getByRole } = renderZoomPan()
    zoomIn(viewport)
    fireEvent.click(getByRole('button', { name: /Reset view/ }))
    expect(content.style.transform).toContain('scale(1)')
    expect(content.style.transition).toBe('transform 200ms ease-out')
  })
})
