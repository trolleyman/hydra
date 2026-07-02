import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { ArtifactsPanel, MasonryGrid } from './ArtifactsPanel'
import { useImageLightboxStore } from '../stores/imageLightboxStore'

// Regression tests for the masonry tile's "drag horizontally to resize the column
// span" gesture (startBodyResize). The handler used to sit on the whole tile, so
// click-dragging to select the file name also enlarged the image. The fix scopes
// the drag to the media region a tile marks with data-tile-drag; the card header
// (file name + badges) is left alone. jsdom has no ResizeObserver, so the grid
// measures a 0px container and renders BASE_ARTIFACT_COLUMNS columns — enough for
// canResize (cols > 1) and a non-zero resize unit (colW 0 + MASONRY_GAP). A drag
// is simulated by a pointerdown on a tile child followed by a window pointermove,
// matching how startBodyResize wires its listeners.
afterEach(cleanup)

// A tile node shaped like FileRow/MediaCell: a selectable header above a
// data-tile-drag media region. The drag should fire only from the media.
function tileNode() {
  return (
    <div>
      <div data-testid="header">
        <span>screenshot.png</span>
      </div>
      <div data-tile-drag>
        <img data-testid="media" alt="" />
      </div>
    </div>
  )
}

function renderGrid(onSpanChange: (key: string, span: number | null) => void) {
  return render(
    <MasonryGrid
      items={[{ key: 'screenshot.png', node: tileNode(), aspect: 1.6 }]}
      spans={{}}
      onSpanChange={onSpanChange}
    />,
  )
}

// Drive a horizontal drag: press on `from`, then move the pointer past the
// activation threshold (window-level listeners, as startBodyResize attaches them).
function dragHorizontally(from: HTMLElement) {
  fireEvent.pointerDown(from, { button: 0, clientX: 0, clientY: 0 })
  fireEvent.pointerMove(window, { clientX: 80, clientY: 0 })
  fireEvent.pointerUp(window, { clientX: 80, clientY: 0 })
}

describe('MasonryGrid body-drag resize', () => {
  it('resizes the tile when the drag starts on the media', () => {
    const onSpanChange = vi.fn()
    renderGrid(onSpanChange)
    dragHorizontally(screen.getByTestId('media'))
    expect(onSpanChange).toHaveBeenCalled()
    // The override is written under the tile's (scoped) key.
    expect(onSpanChange.mock.calls[0][0]).toBe('screenshot.png')
  })

  it('does NOT resize when the drag starts on the card header (e.g. selecting the file name)', () => {
    const onSpanChange = vi.fn()
    renderGrid(onSpanChange)
    dragHorizontally(screen.getByText('screenshot.png'))
    expect(onSpanChange).not.toHaveBeenCalled()
  })

  it('ignores a drag from a tile with no data-tile-drag media region', () => {
    const onSpanChange = vi.fn()
    render(
      <MasonryGrid
        items={[{ key: 'no-media', node: <div data-testid="plain">just text</div>, aspect: 1 }]}
        spans={{}}
        onSpanChange={onSpanChange}
      />,
    )
    dragHorizontally(screen.getByTestId('plain'))
    expect(onSpanChange).not.toHaveBeenCalled()
  })

  it('does NOT resize when the drag starts on the onion-skin opacity slider (an <input>)', () => {
    // Regression: the onion slider lives inside the data-tile-drag media region, so a
    // horizontal drag on it used to be hijacked by the tile resize. It owns its own
    // drag, so startBodyResize must leave <input> controls alone.
    const onSpanChange = vi.fn()
    render(
      <MasonryGrid
        items={[{
          key: 'onion.png',
          node: (
            <div data-tile-drag>
              <input data-testid="opacity" type="range" min={0} max={100} defaultValue={50} />
            </div>
          ),
          aspect: 1.6,
        }]}
        spans={{}}
        onSpanChange={onSpanChange}
      />,
    )
    dragHorizontally(screen.getByTestId('opacity'))
    expect(onSpanChange).not.toHaveBeenCalled()
  })

  it('does NOT resize when the drag starts on a data-no-tile-drag control', () => {
    const onSpanChange = vi.fn()
    render(
      <MasonryGrid
        items={[{
          key: 'guarded.png',
          node: (
            <div data-tile-drag>
              <div data-no-tile-drag><span data-testid="guarded">controls</span></div>
            </div>
          ),
          aspect: 1.6,
        }]}
        spans={{}}
        onSpanChange={onSpanChange}
      />,
    )
    dragHorizontally(screen.getByTestId('guarded'))
    expect(onSpanChange).not.toHaveBeenCalled()
  })

  it('does not start a resize for a near-vertical drag on the media (lets the page scroll)', () => {
    const onSpanChange = vi.fn()
    renderGrid(onSpanChange)
    const media = screen.getByTestId('media')
    fireEvent.pointerDown(media, { button: 0, clientX: 0, clientY: 0 })
    // Mostly vertical movement stays below the horizontal-takeover threshold.
    fireEvent.pointerMove(window, { clientX: 4, clientY: 60 })
    fireEvent.pointerUp(window, { clientX: 4, clientY: 60 })
    expect(onSpanChange).not.toHaveBeenCalled()
  })
})

// Regression tests for the grid's global A/B keyboard shortcuts: the handler used to
// bind only B (as a toggle) and H, so A and X — advertised and handled by the lightbox
// (ImageLightbox) — silently did nothing over the grid. The grid must accept the same
// X (flip) / B (Before) / A (After) / H (highlight) set, gate them on A/B mode, and
// stand down while the lightbox is open. The panel is rendered for real, with inert
// WebSocket/ResizeObserver stubs (jsdom provides neither) so it idles in its
// "connecting" state — the key handler is registered regardless of data.
describe('ArtifactsPanel A/B keyboard shortcuts', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    vi.stubGlobal('WebSocket', class {
      static OPEN = 1
      onopen: unknown = null
      onmessage: unknown = null
      onclose: unknown = null
      readyState = 0
      send() {}
      close() {}
    })
  })
  afterAll(() => vi.unstubAllGlobals())
  afterEach(() => useImageLightboxStore.setState({ images: null }))

  function renderPanel(over: Partial<ComponentProps<typeof ArtifactsPanel>> = {}) {
    const onView = vi.fn()
    const onHighlight = vi.fn()
    render(
      <ArtifactsPanel
        projectId="proj"
        agentId="agent"
        refreshKey={0}
        imageDiffMode="ab"
        artifactScale={1}
        artifactView="after"
        onArtifactViewChange={onView}
        artifactHighlight={false}
        onArtifactHighlightChange={onHighlight}
        artifactSpans={{}}
        onArtifactSpanChange={vi.fn()}
        {...over}
      />,
    )
    return { onView, onHighlight }
  }

  it('binds A (After), B (Before), X (flip) and H (highlight) in A/B mode', () => {
    const { onView, onHighlight } = renderPanel({ artifactView: 'before' })
    fireEvent.keyDown(document.body, { key: 'a' })
    expect(onView).toHaveBeenLastCalledWith('after')
    fireEvent.keyDown(document.body, { key: 'b' })
    expect(onView).toHaveBeenLastCalledWith('before')
    fireEvent.keyDown(document.body, { key: 'x' })
    expect(onView).toHaveBeenLastCalledWith('after') // flip away from 'before'
    fireEvent.keyDown(document.body, { key: 'h' })
    expect(onHighlight).toHaveBeenLastCalledWith(true)
  })

  it('ignores the keys outside A/B mode', () => {
    const { onView, onHighlight } = renderPanel({ imageDiffMode: 'slider' })
    for (const key of ['a', 'b', 'x', 'h']) fireEvent.keyDown(document.body, { key })
    expect(onView).not.toHaveBeenCalled()
    expect(onHighlight).not.toHaveBeenCalled()
  })

  it('stands down while the image lightbox is open (its own X/B/A/H take over)', () => {
    const { onView } = renderPanel()
    useImageLightboxStore.setState({ images: [{ url: 'u', filename: 'f.png', size: 1 }], index: 0 })
    fireEvent.keyDown(document.body, { key: 'a' })
    expect(onView).not.toHaveBeenCalled()
  })
})
