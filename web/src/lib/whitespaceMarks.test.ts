import { describe, it, expect } from 'vitest'
import { markWhitespace, markWhitespaceText } from './whitespaceMarks'

// The text a line renders as, with the marker spans stripped back out: what the
// browser paints, and what a copy of the line yields. It must always come back
// identical to the input - the marks are drawn by CSS, they never replace a
// character.
const painted = (html: string) => html.replace(/<span class="ws-(?:space|tab)">/g, '').replace(/<\/span>/g, '')

describe('markWhitespace: off', () => {
  it('returns the line untouched', () => {
    expect(markWhitespace('  a  ', 'off')).toBe('  a  ')
  })
})

describe('markWhitespace: boundary', () => {
  it('marks the indent and leaves the gaps between words alone', () => {
    expect(markWhitespace('  a b', 'boundary')).toBe('<span class="ws-space">  </span>a b')
  })

  it('marks trailing spaces', () => {
    expect(markWhitespace('a b  ', 'boundary')).toBe('a b<span class="ws-space">  </span>')
  })

  it('marks each tab on its own, so each draws its own arrow', () => {
    expect(markWhitespace('\t\ta', 'boundary')).toBe('<span class="ws-tab">\t</span><span class="ws-tab">\t</span>a')
  })

  it('marks a whitespace-only line whole', () => {
    expect(markWhitespace('   ', 'boundary')).toBe('<span class="ws-space">   </span>')
  })

  it('leaves a line with no boundary whitespace exactly as it was', () => {
    expect(markWhitespace('a b c', 'boundary')).toBe('a b c')
  })
})

describe('markWhitespace: all', () => {
  it('marks every run, gaps included', () => {
    expect(markWhitespace('a b', 'all')).toBe('a<span class="ws-space"> </span>b')
  })
})

describe('markWhitespace over highlighted HTML', () => {
  it('copies tags through and does not mark the spaces inside them', () => {
    const html = '<span class="token keyword">if</span> <span class="token punctuation">(</span>x'
    expect(markWhitespace(html, 'all')).toBe(
      '<span class="token keyword">if</span><span class="ws-space"> </span><span class="token punctuation">(</span>x',
    )
  })

  it('sees the indent through the token span that opens the line', () => {
    const html = '<span class="token comment">  // hi</span>'
    expect(markWhitespace(html, 'boundary')).toBe('<span class="token comment"><span class="ws-space">  </span>// hi</span>')
  })

  it('sees trailing spaces through the token span that closes the line', () => {
    const html = 'x<span class="token operator"> = </span>1  '
    expect(markWhitespace(html, 'boundary')).toBe('x<span class="token operator"> = </span>1<span class="ws-space">  </span>')
  })

  it('finds trailing whitespace that sits INSIDE the closing tags', () => {
    const html = '<span class="token string">"a"  </span>'
    expect(markWhitespace(html, 'boundary')).toBe('<span class="token string">"a"<span class="ws-space">  </span></span>')
  })

  it('treats an entity as ink, so what follows it is not the indent', () => {
    expect(markWhitespace('&amp; b', 'boundary')).toBe('&amp; b')
  })

  it('never changes the text the line paints', () => {
    const lines = ['  a b  ', '\tif (x) {', 'plain', '   ', '<span class="token f">  a  </span>  ']
    for (const line of lines) {
      for (const mode of ['boundary', 'all'] as const) expect(painted(markWhitespace(line, mode))).toBe(painted(line))
    }
  })

  it('survives a truncated tag rather than dropping the rest of the line', () => {
    expect(markWhitespace('a <span class="x', 'all')).toBe('a<span class="ws-space"> </span><span class="x')
  })
})

describe('markWhitespaceText', () => {
  it('escapes the raw line before marking it', () => {
    expect(markWhitespaceText('  <a>', 'boundary')).toBe('<span class="ws-space">  </span>&lt;a&gt;')
  })

  it('returns null when there is nothing to mark, so the caller keeps its text node', () => {
    expect(markWhitespaceText('a b', 'boundary')).toBeNull()
    expect(markWhitespaceText('', 'all')).toBeNull()
    expect(markWhitespaceText('  a', 'off')).toBeNull()
  })
})
