import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FilePathLabel } from './FilePathLabel'

describe('FilePathLabel', () => {
  it('renders a file icon with a lowlit directory and readable basename', () => {
    const { container } = render(<FilePathLabel path="docs/guide/README.md" />)

    expect(container.querySelector('svg')).not.toBeNull()
    expect(screen.getByText('docs/guide/')).toHaveClass('text-stone-400')
    expect(screen.getByText('README.md')).toHaveClass('text-stone-700')
    expect(screen.getByTitle('docs/guide/README.md')).toBeInTheDocument()
  })
})
