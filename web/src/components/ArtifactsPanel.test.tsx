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

// Regression tests for the live-drag mechanics: the rubber-band pull feedback, the
// snap hysteresis, the measurement ghost being truly hidden, and the tile's measured
// height being refreshed when the drag ends (its ResizeObserver readings are frozen
// during the drag, so without the refresh the stale pre-drag height left a permanent
// gap below a shrunk tile).
//
// Layout arithmetic in jsdom: the container measures 0px wide, so the grid renders
// BASE_ARTIFACT_COLUMNS (6) columns of colW=0 and every width is a multiple of the
// 12px gap (unit = colW + gap = 12). aspect 1.6 ⇒ a default span of 3, i.e. a
// starting tile width of 3*0 + 2*12 = 24px. A pointer at clientX=x (down at 0) gives
// a raw width w = 24 + x, and spanFloat = (w + 12) / 12; the snap-to-4 threshold is
// spanFloat ≥ 3 + 0.5 + RESIZE_STICK(0.3) = 3.8, i.e. x ≥ 9.6.
describe('MasonryGrid drag feedback + ghost + settled height', () => {
  afterEach(() => vi.restoreAllMocks())

  const tileEl = (container: HTMLElement) =>
    container.querySelector('[data-mkey="screenshot.png"]') as HTMLElement
  const ghostEl = (container: HTMLElement) =>
    container.querySelector('[data-masonry-ghost]') as HTMLElement | null

  // Press on the media and pull 8px right: past the 6px activation threshold, but
  // inside the snap deadband (spanFloat ≈ 3.67 < 3.8).
  function startPull(container: HTMLElement) {
    fireEvent.pointerDown(screen.getByTestId('media'), { button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(window, { clientX: 8, clientY: 0 })
    return container
  }

  it('stretches the tile with a rubber-band pull inside the deadband (feedback before the snap)', () => {
    const onSpanChange = vi.fn()
    const { container } = renderGrid(onSpanChange)
    startPull(container)
    // No snap yet…
    expect(onSpanChange).not.toHaveBeenCalled()
    // …but the tile visibly stretches: snapped 24px + RESIZE_PULL(0.35) * 8px pull.
    const w = parseFloat(tileEl(container).style.width)
    expect(w).toBeCloseTo(24 + 8 * 0.35)
    expect(w).toBeGreaterThan(24) // more than frozen-at-snap
    expect(w).toBeLessThan(24 + 8) // less than 1:1 pointer tracking
    fireEvent.pointerUp(window, { clientX: 8, clientY: 0 })
  })

  it('snaps the span only once the pointer commits past the halfway+stick threshold', () => {
    const onSpanChange = vi.fn()
    const { container } = renderGrid(onSpanChange)
    startPull(container) // 8px: inside the deadband, held
    expect(onSpanChange).not.toHaveBeenCalled()
    // 12px: spanFloat = 4.0 ≥ 3.8 — commits to span 4 mid-drag.
    fireEvent.pointerMove(window, { clientX: 12, clientY: 0 })
    expect(onSpanChange).toHaveBeenCalledWith('screenshot.png', 4)
    // The tile now renders the new snapped width (4*0 + 3*12 = 36) with no residual
    // pull (the pointer sits exactly on the new width).
    expect(parseFloat(tileEl(container).style.width)).toBeCloseTo(36)
    fireEvent.pointerUp(window, { clientX: 12, clientY: 0 })
  })

  it('keeps the measurement ghost fully hidden even when the tile forces visibility:visible', () => {
    const onSpanChange = vi.fn()
    // The flip view's layers set an explicit visibility:visible on themselves, which
    // escapes an inherited visibility:hidden — the ghost's image used to paint at the
    // grid's top-left and flash during the drag. opacity:0 has no such escape hatch.
    const { container } = render(
      <MasonryGrid
        items={[{
          key: 'screenshot.png',
          node: (
            <div data-tile-drag>
              <img data-testid="media" alt="" style={{ visibility: 'visible' }} />
            </div>
          ),
          aspect: 1.6,
        }]}
        spans={{}}
        onSpanChange={onSpanChange}
      />,
    )
    expect(ghostEl(container)).toBeNull() // no ghost at rest
    startPull(container)
    const ghost = ghostEl(container)
    expect(ghost).not.toBeNull()
    expect(ghost!.style.opacity).toBe('0')
    // The ghost renders at the *snapped* width (24px), not the rubber-band width —
    // it measures the height the tile will settle to.
    expect(ghost!.style.width).toBe('24px')
    fireEvent.pointerUp(window, { clientX: 8, clientY: 0 })
    expect(ghostEl(container)).toBeNull() // gone once the drag ends
  })

  it("adopts the ghost's settled height when the drag ends (no leftover reserved space)", () => {
    // The dragged tile's ResizeObserver readings are frozen during the drag, and if
    // its width transition settles before release nothing re-measures it afterwards —
    // placement kept reserving the stale pre-drag height, leaving a big empty gap
    // below a shrunk tile. finish() must fold the ghost's settled height back in.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(500)
    const onSpanChange = vi.fn()
    const { container } = renderGrid(onSpanChange)
    const grid = container.firstChild as HTMLElement
    // Unmeasured tile (no ResizeObserver in jsdom): the fallback height is reserved.
    expect(grid.style.height).toBe('240px')
    startPull(container)
    fireEvent.pointerMove(window, { clientX: 12, clientY: 0 }) // snap to span 4
    fireEvent.pointerUp(window, { clientX: 12, clientY: 0 })
    // After the drag the container reserves the ghost-measured settled height — not
    // the stale pre-drag/fallback one.
    expect(grid.style.height).toBe('500px')
  })
})
