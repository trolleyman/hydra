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

  describe('images', () => {
    const ctx = { projectId: 'p1', agentId: 'a1', refStr: 'hydra/a1', filePath: '' }

    it('serves an agent-emitted local path through the agent-files endpoint', () => {
      const { container } = render(<Markdown text="![shot](/tmp/shot.png)" linkCtx={ctx} />)
      const img = container.querySelector('img')!
      expect(img).toHaveAttribute(
        'src',
        '/agent-files/projects/p1/agents/a1/blob?path=%2Ftmp%2Fshot.png',
      )
      expect(img).toHaveAttribute('alt', 'shot')
    })

    it('leaves an http/data source alone', () => {
      const { container } = render(<Markdown text="![x](https://e.com/a.png)" linkCtx={ctx} />)
      expect(container.querySelector('img')).toHaveAttribute('src', 'https://e.com/a.png')
    })

    it('falls back to the uploads endpoint for an upload path with no head', () => {
      const path = '/home/u/proj/.hydra/local/uploads/123-image1.png'
      const { container } = render(
        <Markdown text={`![m](${path})`} linkCtx={{ projectId: 'p1', refStr: 'main', filePath: '' }} />,
      )
      expect(container.querySelector('img')).toHaveAttribute(
        'src',
        '/uploads/projects/p1/blob?name=123-image1.png',
      )
    })

    it('degrades an unresolvable path to a labelled chip, not a broken image', () => {
      const { container } = render(<Markdown text="![a shot](/tmp/shot.png)" />)
      expect(container.querySelector('img')).toBeNull()
      expect(container.textContent).toContain('a shot')
    })
  })
})
