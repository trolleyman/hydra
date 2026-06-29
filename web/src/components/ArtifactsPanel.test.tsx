import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MasonryGrid } from './ArtifactsPanel'

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
