import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectoryTooltip } from './DirectoryTooltip'

afterEach(() => {
  vi.useRealTimers()
})

describe('DirectoryTooltip', () => {
  it('renders a folder icon and the whole path at one emphasis level', () => {
    vi.useFakeTimers()
    const { container } = render(
      <DirectoryTooltip path="/home/callum/.local/state/hydra">
        <button type="button">State directory</button>
      </DirectoryTooltip>,
    )

    fireEvent.mouseEnter(container.firstElementChild as HTMLElement)
    act(() => void vi.advanceTimersByTime(600))

    const tooltip = screen.getByRole('tooltip')
    const path = screen.getByText('/home/callum/.local/state/hydra')
    expect(tooltip.querySelector('svg')).not.toBeNull()
    expect(path).toHaveClass('text-stone-700')
    expect(path).not.toHaveClass('text-stone-400')
    expect(path).not.toHaveClass('font-mono')
  })
})
