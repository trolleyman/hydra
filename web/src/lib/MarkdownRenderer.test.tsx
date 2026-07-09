import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Markdown } from './MarkdownRenderer'

describe('Markdown', () => {
  it('keeps the start number of an ordered list (8. stays 8., not 1.)', () => {
    const { container } = render(<Markdown text="8. test" />)
    const ol = container.querySelector('ol')!
    expect(ol).toHaveAttribute('start', '8')
    expect(ol.querySelector('li')).toHaveTextContent('test')
  })

  it('leaves a list starting at 1 without an explicit start', () => {
    const { container } = render(<Markdown text="1. test" />)
    expect(container.querySelector('ol')).not.toHaveAttribute('start')
  })
})
