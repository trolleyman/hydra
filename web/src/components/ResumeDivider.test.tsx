import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResumeDivider } from './ResumeDivider'

describe('ResumeDivider', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows relative resume time with a shared tooltip for the exact timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T12:00:10Z'))
    const resumedAt = Date.parse('2026-08-30T12:00:00Z')
    render(<ResumeDivider resumedAt={resumedAt} ariaLabel="Conversation resumed" />)

    const divider = screen.getByLabelText('Conversation resumed')
    expect(divider).toHaveTextContent('Resumed 10s ago')
    const label = screen.getByText(/Resumed 10s ago/)
    expect(label).not.toHaveAttribute('title')

    fireEvent.mouseEnter(label)
    act(() => vi.advanceTimersByTime(600))
    expect(document.body).toHaveTextContent(new Date(resumedAt).toLocaleString())
  })
})
