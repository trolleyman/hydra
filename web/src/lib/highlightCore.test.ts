import { describe, it, expect } from 'vitest'
import { highlightHtml, highlightLines, resyncDeadTail, splitHighlightedLines } from './highlightCore'

// The shape that used to lose highlight.js: an angle-bracketed word inside a JSX
// element - here in a `//` comment in the opening tag, which hljs read as XML and
// so not as a comment at all. `<n>` opened a nested tag whose end regex matched
// the element's own `</span>`, so the element never closed and the rest of the
// file came back untokenized. Reduced from web/src/DiffViewer.tsx's LineNumCell,
// where it cost 3,596 lines. Prism's tsx grammar handles it; this is the
// regression test for the switch.
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

const TAIL = Array.from({ length: 30 }, (_, i) =>
  `export function after${i}(value: string): number { return value.length + ${i} }`).join('\n')

const tokened = (lines: string[]) => lines.filter((l) => l.includes('<span')).length
const strip = (s: string) => s.replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')

describe('highlightLines', () => {
  it('keeps highlighting the code after a JSX element', () => {
    const out = highlightLines(`${JSX_TRAP}\n${TAIL}`, 'tsx')
    const tailStart = JSX_TRAP.split('\n').length
    // Every tail line is a plain function declaration, so all of them carry
    // tokens. Under highlight.js none of them did.
    expect(tokened(out.slice(tailStart))).toBe(30)
  })

  it('reads a `//` comment inside a JSX opening tag as a comment', () => {
    const out = highlightLines(JSX_TRAP, 'tsx')
    expect(out[6]).toContain('token comment')
    expect(out[7]).toContain('token comment')
  })

  it('returns exactly one entry per source line, with the text intact', () => {
    const src = `${JSX_TRAP}\n${TAIL}`.split('\n')
    const out = highlightLines(src.join('\n'), 'tsx')
    expect(out.length).toBe(src.length)
    out.forEach((html, i) => expect(strip(html)).toBe(src[i]))
  })

  it('falls back to escaped plain lines for a language it cannot highlight', () => {
    const src = ['a < b && c > d', 'x & y']
    const out = highlightLines(src.join('\n'), 'plaintext')
    expect(out).toEqual(['a &lt; b &amp;&amp; c &gt; d', 'x &amp; y'])
  })

  it('routes zsh and ksh - names Prism does not know - through the bash grammar', () => {
    for (const lang of ['zsh', 'ksh']) {
      expect(highlightHtml('echo hi', lang), lang).toContain('token')
    }
  })

  it('highlights the comment attached to import C as embedded C', () => {
    const src = `//go:build linux && cgo

package sample

/*
#include <stdlib.h>
static int answer(void) { return 42; }
*/
import "C"

func value() int { return int(C.answer()) }`
    const out = highlightLines(src, 'go')
    expect(out[0]).toContain('token comment')
    expect(out[5]).toContain('token macro property')
    expect(out[6]).toContain('token keyword')
    expect(out[6]).not.toContain('token comment')
    expect(out.map(strip)).toEqual(src.split('\n'))
  })

  it('leaves ordinary Go block comments as comments in a cgo file', () => {
    const src = `/* ordinary documentation */
package sample
/* static int embedded(void) { return 1; } */
import "C"`
    const out = highlightLines(src, 'go')
    expect(out[0]).toContain('token comment')
    expect(out[0]).not.toContain('token keyword')
    expect(out[2]).toContain('token keyword')
  })
})

// No Prism grammar we can find derails, so the recovery path is driven here with
// a highlighter that gives up on purpose - the loop's real logic (where it
// resumes, when it stops, that it always terminates) is what these check.
describe('resyncDeadTail', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
  // Tokenizes `stopAfter` lines and then gives up, like a derailed grammar.
  const givesUpAfter = (stopAfter: number) => (code: string) =>
    code.split('\n').map((l, i) => (i < stopAfter ? `<span class="token">${l}</span>` : l))

  it('restarts on the dead tail until the whole run is tokened', () => {
    const out = resyncDeadTail(lines, givesUpAfter(20)(lines.join('\n')), givesUpAfter(20))
    expect(tokened(out)).toBe(100)
    expect(out.length).toBe(100)
  })

  it('recovers what it can within the pass cap rather than looping forever', () => {
    // 10 lines per pass, capped at 6 retries: 10 + 6*10 of 100. Partial colour
    // beats an unbounded rescan of a file that keeps derailing.
    const out = resyncDeadTail(lines, givesUpAfter(10)(lines.join('\n')), givesUpAfter(10))
    expect(tokened(out)).toBe(70)
    expect(out.length).toBe(100)
  })

  it('stops when the tail comes back with no tokens at all', () => {
    let calls = 0
    const plain = (code: string) => { calls++; return code.split('\n') }
    const out = resyncDeadTail(lines, plain(lines.join('\n')), plain)
    expect(calls).toBe(2) // the first pass, then one retry that finds nothing
    expect(out.length).toBe(100)
  })

  it('leaves an already fully-tokened run untouched, without retrying', () => {
    let calls = 0
    const all = (code: string) => { calls++; return code.split('\n').map((l) => `<span class="token">${l}</span>`) }
    const first = all(lines.join('\n'))
    calls = 0
    expect(resyncDeadTail(lines, first, all)).toEqual(first)
    expect(calls).toBe(0)
  })

  it('gives up rather than looping when every pass keeps derailing', () => {
    let calls = 0
    const stuck = (code: string) => { calls++; return code.split('\n').map((l, i) => (i < 1 ? `<span class="token">${l}</span>` : l)) }
    const out = resyncDeadTail(lines, stuck(lines.join('\n')), stuck)
    expect(calls).toBeLessThanOrEqual(7) // first pass + the pass cap
    expect(out.length).toBe(100)
  })
})

describe('splitHighlightedLines', () => {
  it('re-opens spans that straddle a line break so each line is valid markup', () => {
    const lines = splitHighlightedLines('<span class="c">one\ntwo</span>\nthree')
    expect(lines).toEqual(['<span class="c">one</span>', '<span class="c">two</span>', 'three'])
  })
})
