import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AboutSection } from './AboutSection'

describe('AboutSection', () => {
  it('uses AVIF with a desktop-compatible PNG fallback', () => {
    const { container } = render(<AboutSection />)

    expect(container.querySelector('source')).toHaveAttribute('srcset', '/icon.avif')
    expect(container.querySelector('source')).toHaveAttribute('type', 'image/avif')
    expect(container.querySelector('img')).toHaveAttribute('src', '/icon.png')
  })

  it('places the state directory beside backend ownership', () => {
    render(<AboutSection />)

    const backendDetail = screen.getByText('Backend ownership').parentElement?.parentElement
    const directoryDetail = screen.getByText('State directory').parentElement?.parentElement

    expect(backendDetail?.parentElement).toBe(directoryDetail?.parentElement)
  })

  it('renders the state directory as a normal-font directory tooltip trigger', () => {
    render(<AboutSection />)

    const trigger = screen.getByRole('button', { name: /^State directory:/ })
    expect(trigger).toHaveClass('text-sm')
    expect(trigger).not.toHaveClass('font-mono')
    expect(trigger).not.toHaveAttribute('title')
  })
})
