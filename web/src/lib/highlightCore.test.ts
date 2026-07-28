import { describe, it, expect } from 'vitest'
import { highlightLines, splitHighlightedLines } from './highlightCore'

// The shape that loses highlight.js: an angle-bracketed word inside a JSX
// element - here in a `//` comment in the opening tag, which hljs reads as XML
// and so not as a comment at all. `<n>` opens a nested tag whose end regex
// (`/Tag>` or `/>`) matches the element's own `</span>`, so the element never
// closes and everything after it comes back untokenized. Reduced from
// web/src/DiffViewer.tsx's LineNumCell, where it cost 3,596 lines.
const JSX_TRAP = `const LineNumCell = ({ num, side, baseClass, selected, onSelectLine }) => {
  const clickable = !!onSelectLine && num != null
  return (
    <span
      onClick={clickable ? (e) => { e.stopPropagation(); onSelectLine(side, num) } : undefined}
      title={clickable ? \`Select line \${num}\` : undefined}
      // Locates a line+side for scroll-into-view when a selection is deep-linked
      // (the repository compare-diff scrolls #L<n>/#R<n>'s first row into view).
      data-diff-ln={num != null ? \`\${side}:\${num}\` : undefined}
      className={\`\${baseClass} \${selected ? SELECTED : ''}\`}
    >
      {num ?? ''}
    </span>
  )
}`

// Enough real code after the trap to be worth resyncing for (RESYNC_MIN_TAIL).
const TAIL = Array.from({ length: 30 }, (_, i) =>
  `export function after${i}(value: string): number { return value.length + ${i} }`).join('\n')

const tokened = (lines: string[]) => lines.filter((l) => l.includes('<span')).length
const strip = (s: string) => s.replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")

describe('highlightLines', () => {
  it('keeps highlighting after a construct that derails the grammar', () => {
    const code = `${JSX_TRAP}\n${TAIL}`
    const out = highlightLines(code, 'typescript')
    const tailStart = JSX_TRAP.split('\n').length
    // Every line of the tail is a plain function declaration, so all of them
    // should carry tokens. Before the resync, none of them did.
    expect(tokened(out.slice(tailStart))).toBe(30)
  })

  it('keeps each line of HTML aligned with its source line while resyncing', () => {
    const src = `${JSX_TRAP}\n${TAIL}`.split('\n')
    const out = highlightLines(src.join('\n'), 'typescript')
    expect(out.length).toBe(src.length)
    out.forEach((html, i) => expect(strip(html)).toBe(src[i]))
  })

  it('returns a genuinely token-free tail as aligned plain lines', () => {
    // Prose after code: there is nothing to tokenize, so the resync loop finds
    // no improvement and leaves the lines as they are (rather than rescanning
    // them up to the pass limit, or dropping them).
    const src = ['const a = 1', ...Array.from({ length: 40 }, () => 'alpha bravo charlie delta')]
    const out = highlightLines(src.join('\n'), 'typescript')
    expect(out.length).toBe(src.length)
    expect(tokened(out)).toBe(1)
    out.forEach((html, i) => expect(strip(html)).toBe(src[i]))
  })

  it('leaves an already well-highlighted file alone', () => {
    const code = Array.from({ length: 40 }, (_, i) => `const value${i} = ${i}`).join('\n')
    const out = highlightLines(code, 'typescript')
    expect(tokened(out)).toBe(40)
  })
})

describe('splitHighlightedLines', () => {
  it('re-opens spans that straddle a line break so each line is valid markup', () => {
    const lines = splitHighlightedLines('<span class="c">one\ntwo</span>\nthree')
    expect(lines).toEqual(['<span class="c">one</span>', '<span class="c">two</span>', 'three'])
  })
})
