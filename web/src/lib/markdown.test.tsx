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

  it('renders ~~double~~ tilde as strikethrough', () => {
    const two = render(<span>{renderMarkdown('a ~~b~~ c')}</span>)
    expect(two.container.querySelector('del')?.textContent).toBe('b')
  })

  // A single `~` is a home path, not a delimiter. Two of them in one message -
  // "~/.config" and "~/.cache", which is an ordinary sentence here - used to
  // strike through everything in between.
  it('leaves home paths alone rather than striking between them', () => {
    const paths = render(<span>{renderMarkdown('CoW ~/.config and ~/.cache please')}</span>)
    expect(paths.container.querySelector('del')).toBeNull()
    expect(paths.container.textContent).toBe('CoW ~/.config and ~/.cache please')
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

  // CommonMark 6.1: a run of N backticks is closed by the next run of exactly N,
  // and a content that is padded with a space at BOTH ends loses one from each.
  // Getting this wrong is what turned a sentence about ``` into two blank chips.
  it('closes a code span only on a backtick run of the same length', () => {
    const { container } = render(<span>{renderMarkdown('Typing ` ``` ` still works')}</span>)
    const codes = [...container.querySelectorAll('code')].map((c) => c.textContent)
    expect(codes).toEqual(['```'])
    expect(container.textContent).toBe('Typing ``` still works')
  })

  it('renders a lone backtick written as a doubled span', () => {
    const { container } = render(<span>{renderMarkdown('the `` ` `` mark')}</span>)
    expect(container.querySelector('code')?.textContent).toBe('`')
  })

  it('keeps a code span that is only spaces, and inner spaces either side', () => {
    // "Not all spaces" is the guard on the padding rule; one-sided padding stays.
    expect(render(<span>{renderMarkdown('a `  ` b')}</span>).container.querySelector('code')?.textContent).toBe('  ')
    expect(render(<span>{renderMarkdown('a ` b` c')}</span>).container.querySelector('code')?.textContent).toBe(' b')
  })

  it('treats the contents of a code span as literal, not emphasis', () => {
    const { container } = render(<span>{renderMarkdown('run `a *b* c` now')}</span>)
    expect(container.querySelector('em')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe('a *b* c')
  })

  it('leaves an unclosed backtick run as plain text', () => {
    const { container } = render(<span>{renderMarkdown('a ``` b\nc')}</span>)
    expect(container.querySelector('code')).toBeNull()
    expect(container.textContent).toBe('a ``` b\nc')
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
    const strike = render(<span>{renderMarkdownSource('a ~~b~~ c')}</span>)
    expect(strike.container.querySelector('.line-through')?.textContent).toBe('b')
    // The composer highlighter must agree with the renderer: a lone `~` is a
    // path, so nothing between two of them is struck.
    const paths = render(<span>{renderMarkdownSource('CoW ~/.config and ~/.cache')}</span>)
    expect(paths.container.querySelector('.line-through')).toBeNull()
    // Italic slants through .md-src-italic (Roboto Flex slnt axis, advance-width
    // preserving), NOT a real cursive <em>/.italic that would drift the caret.
    const italic = render(<span>{renderMarkdownSource('a *b* c')}</span>)
    expect(italic.container.querySelector('.md-src-italic')?.textContent).toBe('*b*')
    expect(italic.container.querySelector('em')).toBeNull()
    expect(italic.container.querySelector('.italic')).toBeNull()
  })

  it('keeps every source character of a padded, multi-backtick code span', () => {
    // The composer overlay sits behind the textarea, so a stripped padding space
    // would drift every glyph after it away from the caret.
    for (const src of ['Typing ` ``` ` still works', 'the `` ` `` mark', 'a `  ` b']) {
      const { container } = render(<span>{renderMarkdownSource(src)}</span>)
      expect(container.textContent).toBe(src)
    }
  })

  it('slants and bold-strokes bold-italic, keeping metrics neutral', () => {
    const { container } = render(<span>{renderMarkdownSource('x ***y*** z')}</span>)
    const span = container.querySelector('.md-src-bold.md-src-italic')
    expect(span?.textContent).toBe('***y***')
  })
})
