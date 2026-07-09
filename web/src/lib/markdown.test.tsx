import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { renderMarkdown, renderMarkdownSource } from './markdown'

describe('renderMarkdown', () => {
  it('renders backslash-escaped metachars literally, not as emphasis', () => {
    // The shape the backend emits for a live activity line on a file whose
    // name contains underscores (internal/heads/activity.go escapeMarkdown).
    const { container } = render(<span>{renderMarkdown('Editing \\_LAYOUT\\_.tsx')}</span>)
    expect(container.textContent).toBe('Editing _LAYOUT_.tsx')
    expect(container.querySelector('em')).toBeNull()
    expect(container.querySelector('strong')).toBeNull()
  })

  it('renders an escaped backtick literally, opening no code span', () => {
    const { container } = render(<span>{renderMarkdown('a \\`b\\` c')}</span>)
    expect(container.textContent).toBe('a `b` c')
    expect(container.querySelector('code')).toBeNull()
  })

  it('renders an escaped backslash as a single backslash', () => {
    const { container } = render(<span>{renderMarkdown('a \\\\ b')}</span>)
    expect(container.textContent).toBe('a \\ b')
  })

  it('leaves a backslash before a non-metachar untouched (Windows paths)', () => {
    const { container } = render(<span>{renderMarkdown('C:\\Users\\x')}</span>)
    expect(container.textContent).toBe('C:\\Users\\x')
  })

  it('still styles unescaped emphasis', () => {
    const { container } = render(<span>{renderMarkdown('a _b_ **c**')}</span>)
    expect(container.querySelector('em')?.textContent).toBe('b')
    expect(container.querySelector('strong')?.textContent).toBe('c')
  })
})

describe('renderMarkdownSource', () => {
  it('keeps every source character of an escape (backslash included)', () => {
    const { container } = render(<span>{renderMarkdownSource('a \\_b\\_ c')}</span>)
    expect(container.textContent).toBe('a \\_b\\_ c')
    expect(container.querySelector('em')).toBeNull()
  })
})
