import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SegmentedToggle, ImageDiffView, IMAGE_DIFF_MODES } from './ArtifactImageDiff'

// Unit coverage for the image-diff renderers lifted out of ArtifactsPanel (#63b).
// These exercise the pure routing/rendering behaviour — which comparison mode
// maps to which sub-renderer, and how a missing side (an added/removed file)
// degrades — without needing the simulation server or the masonry/WS plumbing.

describe('SegmentedToggle', () => {
  const options = [
    { value: 'before', label: 'Before' },
    { value: 'after', label: 'After' },
  ]

  it('marks the active option and fires onChange on click', () => {
    const onChange = vi.fn()
    render(<SegmentedToggle value="before" onChange={onChange} options={options} />)

    expect(screen.getByRole('button', { name: 'Before' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'After' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'After' }))
    expect(onChange).toHaveBeenCalledWith('after')
  })
})

describe('ImageDiffView', () => {
  it('exposes the four selectable comparison modes', () => {
    expect(IMAGE_DIFF_MODES.map((m) => m.value).sort()).toEqual(['ab', 'onion', 'side-by-side', 'slider'])
  })

  it('side-by-side renders both images under Before/After labels', () => {
    const { container } = render(<ImageDiffView mode="side-by-side" left="L.png" right="R.png" name="home.png" />)

    expect(screen.getByText('Before')).toBeInTheDocument()
    expect(screen.getByText('After')).toBeInTheDocument()

    const imgs = Array.from(container.querySelectorAll('img'))
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['L.png', 'R.png'])
  })

  it('ab mode offers the before/after toggle and an enabled Highlight when both sides exist', () => {
    render(<ImageDiffView mode="ab" left="L.png" right="R.png" name="home.png" />)

    expect(screen.getByRole('button', { name: 'Before' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'After' })).toBeInTheDocument()
    // Highlight diffs the two sides, so it's available only with both present.
    expect(screen.getByRole('checkbox')).toBeEnabled()
  })

  it('ab mode disables Highlight and shows the "No image" placeholder for a one-sided file', () => {
    // An added file: no "before" side, so there is nothing to diff against.
    render(<ImageDiffView mode="ab" left={null} right="R.png" name="settings.png" />)

    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.getByText('No image')).toBeInTheDocument()
  })

  it('onion mode renders the opacity slider', () => {
    render(<ImageDiffView mode="onion" left="L.png" right="R.png" name="home.png" />)
    expect(screen.getByRole('slider')).toBeInTheDocument()
  })

  it('falls back to the side-by-side pair when neither side has an image', () => {
    // Degenerate case (no images at all): even an overlay mode collapses to the
    // side-by-side pair, so both cells show the placeholder.
    render(<ImageDiffView mode="slider" left={null} right={null} name="gone.png" />)
    expect(screen.getAllByText('No image')).toHaveLength(2)
  })
})
