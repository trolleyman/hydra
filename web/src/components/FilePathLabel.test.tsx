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

  it('can suppress its native title inside a shared tooltip', () => {
    const { container } = render(<FilePathLabel path="/home/callum/README.md" nativeTitle={false} />)
    expect(container.querySelector('[title]')).toBeNull()
    expect(screen.getByText('/home/callum/')).toHaveClass('text-stone-400')
  })

  it('can wrap instead of truncating when revealing a complete path', () => {
    const { container } = render(<FilePathLabel path="deep/delivery_retry_scheduler_with_exponential_backoff.go" wrap />)
    const path = container.querySelector('span > span')
    expect(path).toHaveClass('whitespace-normal', 'break-words')
    expect(path).not.toHaveClass('truncate')
  })
})
