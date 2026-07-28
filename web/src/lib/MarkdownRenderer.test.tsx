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

  // Commit messages are hard-wrapped at ~72 columns, so the surfaces that render
  // one (the git_commit chat card, the commit hover card) pass hardBreaks={false}
  // to get CommonMark reflow with the compact chat styling.
  it('reflows single newlines when hardBreaks is false', () => {
    const { container } = render(<Markdown text={'one\ntwo'} hardBreaks={false} />)
    expect(container.querySelectorAll('br')).toHaveLength(0)
    expect(container.querySelector('p')).toHaveTextContent('one two')
  })

  it('keeps single newlines as hard breaks by default', () => {
    const { container } = render(<Markdown text={'one\ntwo'} />)
    expect(container.querySelectorAll('br')).toHaveLength(1)
  })
})
