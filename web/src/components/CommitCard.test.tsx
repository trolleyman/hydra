import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CommitCard } from './CommitCard'

describe('CommitCard', () => {
  it('renders the whole commit message as normal markdown prose', () => {
    const { container } = render(
      <CommitCard commit={{
        shortSha: 'a4a55eb',
        message: 'desktop: add dedicated project-directory draft route\n\nPreserve **draft state** between routes.',
      }} />,
    )

    expect(screen.getByText('desktop: add dedicated project-directory draft route').tagName).toBe('P')
    expect(screen.getByText('draft state').tagName).toBe('STRONG')
    expect(container.querySelector('.text-sm')).toBeNull()
    expect(container.querySelector('[data-md-root]')).toHaveClass('text-xs')
  })
})
