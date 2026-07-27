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

  it('renders ***/___ as bold-italic (strong > em)', () => {
    const star = render(<span>{renderMarkdown('x ***y*** z')}</span>)
    expect(star.container.querySelector('strong > em')?.textContent).toBe('y')
    const under = render(<span>{renderMarkdown('x ___y___ z')}</span>)
    expect(under.container.querySelector('strong > em')?.textContent).toBe('y')
  })

  it('renders ~single~ and ~~double~~ tilde as strikethrough', () => {
    const one = render(<span>{renderMarkdown('a ~b~ c')}</span>)
    expect(one.container.querySelector('del')?.textContent).toBe('b')
    const two = render(<span>{renderMarkdown('a ~~b~~ c')}</span>)
    expect(two.container.querySelector('del')?.textContent).toBe('b')
  })

  it('bolds a heading line and drops the # marker', () => {
    const { container } = render(<span>{renderMarkdown('# Title\nbody')}</span>)
    expect(container.querySelector('strong')?.textContent).toBe('Title')
    // The `# ` marker is dropped; the newline + body stay as following text.
    expect(container.textContent).toBe('Title\nbody')
  })

  it('leaves #hashtags and #foo (no space) untouched', () => {
    const { container } = render(<span>{renderMarkdown('see #123 and #foo')}</span>)
    expect(container.querySelector('strong')).toBeNull()
    expect(container.textContent).toBe('see #123 and #foo')
  })

  it('singleLine: bolds only the heading line, not the body after it', () => {
    // The sidebar preview flattens the message onto one line. The heading must
    // still end at its own line break - collapsing the newlines first made the
    // heading swallow the body and render the whole message bold.
    const { container } = render(<span>{renderMarkdown('# Some heading\nAnd some text', { singleLine: true })}</span>)
    expect(container.querySelector('strong')?.textContent).toBe('Some heading')
    expect(container.textContent).toBe('Some heading And some text')
  })

  it('singleLine: collapses blank lines and keeps later emphasis intact', () => {
    const { container } = render(
      <span>{renderMarkdown('## Title  \n\n  body with **bold**\nmore', { singleLine: true })}</span>,
    )
    expect(container.textContent).toBe('Title body with bold more')
    const strong = [...container.querySelectorAll('strong')].map((e) => e.textContent)
    expect(strong).toEqual(['Title', 'bold'])
  })

  it('singleLine: renders a fenced block as an inline code chip on one line', () => {
    const { container } = render(<span>{renderMarkdown('done:\n```js\nconst a = 1\n```', { singleLine: true })}</span>)
    expect(container.textContent).toBe('done: const a = 1')
    const code = container.querySelector('code')
    expect(code?.textContent).toBe('const a = 1')
    // An inline chip, not the block-level one (which would blow the row height).
    expect(code?.className).not.toContain('block')
  })

  it('leaves an escaped tilde literal, opening no strikethrough', () => {
    const { container } = render(<span>{renderMarkdown('cd \\~/foo then \\~/bar')}</span>)
    expect(container.querySelector('del')).toBeNull()
    expect(container.textContent).toBe('cd ~/foo then ~/bar')
  })
})

describe('renderMarkdownSource', () => {
  it('keeps every source character of an escape (backslash included)', () => {
    const { container } = render(<span>{renderMarkdownSource('a \\_b\\_ c')}</span>)
    expect(container.textContent).toBe('a \\_b\\_ c')
    expect(container.querySelector('em')).toBeNull()
  })

  it('keeps every source character of headings, strike and bold-italic', () => {
    // The overlay must stay glyph-for-glyph with the textarea: no marker dropped.
    for (const src of ['## Heading here', 'a ~b~ c', 'a ~~b~~ c', 'x ***y*** z']) {
      const { container } = render(<span>{renderMarkdownSource(src)}</span>)
      expect(container.textContent).toBe(src)
    }
  })

  it('shows real strikethrough and slants italic via the metric-safe slnt class', () => {
    const strike = render(<span>{renderMarkdownSource('a ~b~ c')}</span>)
    expect(strike.container.querySelector('.line-through')?.textContent).toBe('b')
    // Italic slants through .md-src-italic (Roboto Flex slnt axis, advance-width
    // preserving), NOT a real cursive <em>/.italic that would drift the caret.
    const italic = render(<span>{renderMarkdownSource('a *b* c')}</span>)
    expect(italic.container.querySelector('.md-src-italic')?.textContent).toBe('*b*')
    expect(italic.container.querySelector('em')).toBeNull()
    expect(italic.container.querySelector('.italic')).toBeNull()
  })

  it('slants and bold-strokes bold-italic, keeping metrics neutral', () => {
    const { container } = render(<span>{renderMarkdownSource('x ***y*** z')}</span>)
    const span = container.querySelector('.md-src-bold.md-src-italic')
    expect(span?.textContent).toBe('***y***')
  })
})
