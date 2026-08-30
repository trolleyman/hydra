import { describe, it, expect, beforeAll, vi } from 'vitest'
import { render } from '@testing-library/react'
import { Markdown } from './MarkdownRenderer'

// jsdom implements no media loading: the off-screen size probe behind a markdown
// video (lib/imageDensity's useNaturalVideoSize) drops its source on cleanup, and
// the load() that follows only logs "Not implemented" into the run. Same stub the
// other video tests use (see VideoDiffView.test.tsx).
beforeAll(() => {
  window.HTMLMediaElement.prototype.load = vi.fn()
})

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

  it('highlights routing mentions only when requested', () => {
    const { container, rerender } = render(
      <Markdown text="@agent please ask @review too" highlightMentions />,
    )
    expect([...container.querySelectorAll('[data-review-mention]')].map((el) => el.textContent))
      .toEqual(['@agent', '@review'])
    expect(container.querySelector('[data-review-mention]')).not.toHaveClass('font-medium')

    rerender(<Markdown text="@agent is ordinary text here" />)
    expect(container.querySelector('[data-review-mention]')).toBeNull()
  })

  it('does not highlight mention-like text inside code', () => {
    const { container } = render(<Markdown text="`@agent` outside @head" highlightMentions />)
    expect(container.querySelector('code [data-review-mention]')).toBeNull()
    expect(container.querySelector('[data-review-mention]')).toHaveTextContent('@head')
  })

  // The chat variant renders at half a dozen body sizes - 13px chat prose, 14px
  // when the chat font is a serif, 12px sub-agent cards and review comments,
  // 10px config previews, plus whatever the Chat size control adds. An absolute
  // heading size is a fixed 16px h1 in all of them; an em is a multiple of the
  // body it actually sits in, and follows the size control for free. Re-absolute
  // one of these and the pane grows its prose past its own h3.
  it('sizes chat headings relative to their prose', () => {
    const { container } = render(<Markdown text={'# a\n\n## b\n\n### c'} />)
    for (const tag of ['h1', 'h2', 'h3']) {
      expect(container.querySelector(tag)!.className).toMatch(/text-\[length:[\d.]+em\]/)
    }
  })

  // A table is body content, not a heading: it takes no size of its own, so it
  // reads at the size of the prose around it. It used to carry a literal 14px
  // from when chat prose was 14px, which left it 1.077x its surroundings.
  it('gives the chat table no size of its own', () => {
    const { container } = render(<Markdown text={'| x |\n| - |\n| y |'} />)
    expect(container.querySelector('table')!.className).not.toMatch(/text-/)
  })

  // The document variant is a README at a fixed page size, not prose that moves,
  // so its headings stay on the type scale.
  it('leaves the doc variant headings on absolute sizes', () => {
    const { container } = render(<Markdown text="# a" variant="doc" />)
    expect(container.querySelector('h1')!.className).toContain('text-2xl')
  })

  describe('links', () => {
    const ctx = {
      projectId: 'p1',
      refStr: 'hydra/a1',
      filePath: '',
      worktreePath: '/work/hydra',
    }

    it('keeps a chat file link label exact and visibly linked', () => {
      const { container } = render(
        <Markdown text="[controller.go](/work/hydra/internal/controller.go)" linkCtx={ctx} />,
      )
      const link = container.querySelector('a')!
      expect(link).toHaveTextContent('controller.go')
      expect(link.textContent).toBe('controller.go')
      expect(link).toHaveAttribute(
        'href',
        '/project/p1/repository/hydra/a1/-/internal/controller.go',
      )
      expect(link.className.split(' ')).toContain('text-stone-800')
      expect(link.className.split(' ')).not.toContain('font-medium')
      expect(link.className.split(' ')).toContain('underline')
      expect(link.className.split(' ')).toContain('decoration-dotted')
      expect(link.querySelector('svg')).toBeNull()
    })

    it('also makes a semantic repo link visibly linked', () => {
      const { container } = render(
        <Markdown text="[the controller](/work/hydra/internal/controller.go)" linkCtx={ctx} />,
      )
      const link = container.querySelector('a')!
      expect(link).toHaveTextContent('the controller')
      expect(link.textContent).toBe('the controller')
      expect(link.className.split(' ')).toContain('text-stone-800')
      expect(link.className.split(' ')).toContain('decoration-dotted')
    })

    it('distinguishes linked inline code with a stronger neutral border', () => {
      const { container } = render(<Markdown text="[`go help buildconstraint`](https://go.dev/help/buildconstraint)" />)
      const link = container.querySelector('a')!
      expect(link.className).toContain('[&:has(>code)]:no-underline')
      expect(link.className).toContain('[&>code]:border-stone-400/70')
      expect(link.querySelector('code')).toHaveTextContent('go help buildconstraint')
    })

    it('keeps README file links as prose links', () => {
      const { container } = render(
        <Markdown text="[controller.go](internal/controller.go)" variant="doc" linkCtx={ctx} />,
      )
      expect(container.querySelector('a')).toHaveTextContent('controller.go')
      expect(container.querySelector('a')).not.toHaveTextContent('... /')
    })
  })

  // What makes a code block a block is the fence, not what is inside it. This
  // used to be guessed from the content ("no language and no newline means
  // inline"), which rendered the single commonest shape an agent writes - a
  // one-line unannotated fence holding a command - as an inline chip.
  describe('code', () => {
    const kind = (text: string) => {
      const { container } = render(<Markdown text={text} />)
      const code = container.querySelector('code')!
      return code.hasAttribute('data-md-code-block') ? 'block' : 'inline'
    }

    it('renders a one-line fence with no language as a block', () => {
      expect(kind('```\ngit rebase --onto main x y\n```')).toBe('block')
    })

    it('renders an annotated or multi-line fence as a block', () => {
      expect(kind('```sh\nnpm run dev\n```')).toBe('block')
      expect(kind('```\none\ntwo\n```')).toBe('block')
    })

    it('renders an indented block as a block', () => {
      expect(kind('    indented code\n')).toBe('block')
    })

    it('renders a backtick span inside prose as inline', () => {
      expect(kind('some `inline code` here')).toBe('inline')
    })

    it('renders a paragraph that is only a backtick span as inline', () => {
      expect(kind('`git status --short`')).toBe('inline')
    })

    it('carries the info string on the block for copy-as-markdown', () => {
      const { container } = render(<Markdown text={'```go\nx := 1\n```'} />)
      expect(container.querySelector('code')).toHaveAttribute('data-md-lang', 'go')
    })

    it('renders ANSI colours in fenced output without exposing escape codes', () => {
      const esc = '\x1b'
      const { container } = render(
        <Markdown text={`\`\`\`\n${esc}[31mfailed${esc}[0m plain\n\`\`\``} />,
      )
      const code = container.querySelector('code')!
      expect(code).toHaveTextContent('failed plain')
      expect(code.textContent).not.toContain('[31m')
      expect(code.querySelector('.ansi-red')).toHaveTextContent('failed')
    })

    it('keeps syntax highlighting when a language-tagged fence contains ANSI', () => {
      const esc = '\x1b'
      const { container } = render(
        <Markdown text={`\`\`\`html\n${esc}[32m<tag>${esc}[0m\n\`\`\``} />,
      )
      const code = container.querySelector('code')!
      expect(code).toHaveTextContent('<tag>')
      expect(code.textContent).not.toContain('[32m')
      expect(code.querySelector('.token')).not.toBeNull()
      expect(code.querySelector('.ansi-green')).toBeNull()
    })
  })

  describe('images', () => {
    const ctx = { projectId: 'p1', agentId: 'a1', refStr: 'hydra/a1', filePath: '' }

    it('serves an agent-emitted local path through the agent-files endpoint', () => {
      const { container } = render(<Markdown text="![shot](/tmp/shot.png)" linkCtx={ctx} />)
      const img = container.querySelector('img')!
      expect(img).toHaveAttribute(
        'src',
        '/api/projects/p1/agents/a1/media/blob?path=%2Ftmp%2Fshot.png',
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
        '/api/projects/p1/uploads/blob?name=123-image1.png',
      )
    })

    it('degrades an unresolvable path to a labelled chip, not a broken image', () => {
      const { container } = render(<Markdown text="![a shot](/tmp/shot.png)" />)
      expect(container.querySelector('img')).toBeNull()
      expect(container.textContent).toContain('a shot')
    })
  })

  // The same `![alt](path)` syntax, pointed at a recording: an agent demoing a
  // transition has nothing a still can show, so the renderer picks the element
  // off the extension and serves it through the same endpoint.
  describe('video', () => {
    const ctx = { projectId: 'p1', agentId: 'a1', refStr: 'hydra/a1', filePath: '' }

    it('renders a markdown image whose target is a clip as a player', () => {
      const { container } = render(<Markdown text="![the popover](/tmp/demo.webm)" linkCtx={ctx} />)
      expect(container.querySelector('img')).toBeNull()
      const video = container.querySelector('video')!
      expect(video).toHaveAttribute(
        'src',
        '/api/projects/p1/agents/a1/media/blob?path=%2Ftmp%2Fdemo.webm',
      )
      // Controls, so the frame is playable where it sits...
      expect(video).toHaveAttribute('controls')
      // ...and metadata-only, so a transcript of clips doesn't download them all.
      expect(video).toHaveAttribute('preload', 'metadata')
      // The authored path and alt, for copy-as-markdown and the gallery.
      expect(video).toHaveAttribute('data-md-src', '/tmp/demo.webm')
      expect(video).toHaveAttribute('data-md-alt', 'the popover')
    })

    it('still renders a still image as an image', () => {
      const { container } = render(<Markdown text="![shot](/tmp/shot.png)" linkCtx={ctx} />)
      expect(container.querySelector('video')).toBeNull()
      expect(container.querySelector('img')).not.toBeNull()
    })

    it('degrades an unservable clip to a labelled chip', () => {
      const { container } = render(<Markdown text="![a clip](/tmp/demo.webm)" />)
      expect(container.querySelector('video')).toBeNull()
      expect(container.textContent).toContain('a clip')
    })
  })
})
