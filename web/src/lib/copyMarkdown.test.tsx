import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Markdown } from './MarkdownRenderer'
import { selectionToMarkdown } from './copyMarkdown'

// A fake Selection over one range - jsdom implements Range (and the boundary
// comparisons the serializer needs) but not selection by mouse.
function sel(range: Range): Selection {
  return {
    isCollapsed: range.collapsed,
    rangeCount: 1,
    getRangeAt: () => range,
  } as unknown as Selection
}

// copyAll renders markdown and copies the whole rendered subtree.
function copyAll(text: string, variant: 'chat' | 'doc' = 'chat'): string {
  const { container } = render(<Markdown text={text} variant={variant} />)
  const range = document.createRange()
  range.selectNodeContents(container)
  return selectionToMarkdown(sel(range))
}

// copyBetween copies from an offset inside one text node to an offset inside
// another, addressed by the text they contain - i.e. a partial drag-select.
function copyBetween(
  container: HTMLElement,
  from: { text: string; offset: number },
  to: { text: string; offset: number },
): string {
  const walk = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let start: Text | null = null
  let end: Text | null = null
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n as Text
    if (!start && t.data.includes(from.text)) start = t
    if (t.data.includes(to.text)) end = t
  }
  if (!start || !end) throw new Error('anchor text not found')
  const range = document.createRange()
  range.setStart(start, start.data.indexOf(from.text) + from.offset)
  range.setEnd(end, end.data.indexOf(to.text) + to.offset)
  return selectionToMarkdown(sel(range))
}

describe('selectionToMarkdown', () => {
  it('round-trips inline emphasis, code and links', () => {
    expect(copyAll('Some **bold** and *italic* and `code` here.')).toBe(
      'Some **bold** and *italic* and `code` here.',
    )
    expect(copyAll('~~gone~~ and [a link](https://example.com/x).')).toBe(
      '~~gone~~ and [a link](https://example.com/x).',
    )
  })

  it('keeps a bare autolink unwrapped', () => {
    expect(copyAll('see https://example.com/x now')).toBe('see https://example.com/x now')
  })

  it('restores headings and paragraphs', () => {
    expect(copyAll('# Title\n\nBody text.\n\n## Sub\n\nMore.')).toBe(
      '# Title\n\nBody text.\n\n## Sub\n\nMore.',
    )
  })

  it('restores bullet, ordered and nested lists', () => {
    expect(copyAll('- one\n- two\n- three')).toBe('- one\n- two\n- three')
    expect(copyAll('3. three\n4. four')).toBe('3. three\n4. four')
    expect(copyAll('- outer\n  - inner\n- last')).toBe('- outer\n  - inner\n- last')
  })

  it('restores task-list checkboxes', () => {
    expect(copyAll('- [x] done\n- [ ] todo')).toBe('- [x] done\n- [ ] todo')
  })

  it('restores a fenced code block with its language', () => {
    const md = 'Before:\n\n```go\nfunc main() {\n\tprintln("hi")\n}\n```\n\nAfter.'
    expect(copyAll(md)).toBe(md)
  })

  it('widens the fence when the code contains backticks', () => {
    const out = copyAll('```\na ``` b\nsecond line\n```')
    expect(out).toBe('````\na ``` b\nsecond line\n````')
  })

  it('restores a GFM table', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    expect(copyAll(md)).toBe(md)
  })

  it('restores blockquotes and rules', () => {
    expect(copyAll('> quoted\n> lines')).toBe('> quoted\n> lines')
    expect(copyAll('a\n\n---\n\nb')).toBe('a\n\n---\n\nb')
  })

  it('keeps chat single newlines as line breaks', () => {
    expect(copyAll('line one\nline two')).toBe('line one\nline two')
  })

  it('copies a partial selection with the emphasis it touches', () => {
    const { container } = render(<Markdown text="alpha **beta gamma** delta" />)
    expect(copyBetween(container, { text: 'beta', offset: 0 }, { text: ' delta', offset: 3 })).toBe(
      '**beta gamma** de',
    )
  })

  it('copies raw code when the selection stays inside a code block', () => {
    const { container } = render(<Markdown text={'```js\nconst a = 1\nconst b = 2\n```'} />)
    const code = container.querySelector('[data-md-code-block]')!
    const range = document.createRange()
    range.selectNodeContents(code)
    expect(selectionToMarkdown(sel(range))).toBe('const a = 1\nconst b = 2')
  })

  it('separates two rendered messages by a blank line and leaves chrome as text', () => {
    const { container } = render(
      <div>
        <div className="bubble">
          <Markdown text="**hi** there" />
        </div>
        <div className="card">
          <div>Read</div>
          <div>src/main.go</div>
        </div>
        <div className="bubble">
          <Markdown text={'- a\n- b'} />
        </div>
      </div>,
    )
    const range = document.createRange()
    range.selectNodeContents(container)
    expect(selectionToMarkdown(sel(range))).toBe('**hi** there\n\nRead\nsrc/main.go\n\n- a\n- b')
  })

  it('skips control labels, which a drag cannot select anyway', () => {
    const { container } = render(
      <div>
        <button type="button">Read<span>internal/heads/heads.go</span></button>
        <div>
          <Markdown text="the reply" />
        </div>
      </div>,
    )
    const range = document.createRange()
    range.selectNodeContents(container)
    expect(selectionToMarkdown(sel(range))).toBe('the reply')
  })

  it('skips decorative icons and aria-hidden chrome', () => {
    const { container } = render(
      <div>
        <span aria-hidden="true">*</span>
        <div>
          <Markdown text="visible text" />
        </div>
      </div>,
    )
    const range = document.createRange()
    range.selectNodeContents(container)
    expect(selectionToMarkdown(sel(range))).toBe('visible text')
  })

  it('returns nothing for an empty selection', () => {
    const { container } = render(<Markdown text="hello" />)
    const range = document.createRange()
    range.setStart(container, 0)
    range.collapse(true)
    expect(selectionToMarkdown(sel(range))).toBe('')
    expect(selectionToMarkdown(null)).toBe('')
  })
})
