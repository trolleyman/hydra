import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ChangeStats } from './ChangeStats'

afterEach(cleanup)

describe('ChangeStats', () => {
  it('shows positive additions and deletions', () => {
    const { container } = render(<ChangeStats additions={12} deletions={3} />)
    expect(screen.getByText('+12')).toBeInTheDocument()
    expect(screen.getByText('-3')).toBeInTheDocument()
    expect(container.firstElementChild).not.toHaveClass('font-mono')
  })

  it('hides each non-positive side independently', () => {
    const { rerender } = render(<ChangeStats additions={4} deletions={0} />)
    expect(screen.getByText('+4')).toBeInTheDocument()
    expect(screen.queryByText('-0')).toBeNull()

    rerender(<ChangeStats additions={-1} deletions={7} />)
    expect(screen.queryByText('+-1')).toBeNull()
    expect(screen.getByText('-7')).toBeInTheDocument()
  })

  it('renders nothing when neither side is positive', () => {
    const { container } = render(<ChangeStats additions={0} deletions={-2} />)
    expect(container).toBeEmptyDOMElement()
  })
})
