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
    // Not a whole-message selection (that would copy the source verbatim) -
    // a partial drag from the intro through the end of the block.
    const { container } = render(<Markdown text={'Intro line\n\n```\na ``` b\nsecond line\n```'} />)
    const out = copyBetween(container, { text: 'Intro', offset: 6 }, { text: 'second line', offset: 11 })
    expect(out).toBe('line\n\n````\na ``` b\nsecond line\n````')
  })

  it('restores a GFM table', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    expect(copyAll(md)).toBe(md)
  })

  it('recovers per-column table alignment on a partial selection', () => {
    // A trailing paragraph keeps this off the whole-message verbatim path, so
    // the alignment has to come out of the rendered cells' text-align.
    const md = '| l | c | r | n |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |\n\ntail'
    const { container } = render(<Markdown text={md} />)
    const out = copyBetween(container, { text: 'l', offset: 0 }, { text: '4', offset: 1 })
    expect(out).toBe('| l | c | r | n |\n| :--- | :---: | ---: | --- |\n| 1 | 2 | 3 | 4 |')
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

  // A rendered markdown video is a <video>, and every other <video> in the app
  // is chrome the copy deliberately steps over - so this pins that the markdown
  // one comes back as the image link it was written as, alt and all.
  //
  // The DOM is built by hand rather than rendered: jsdom implements no media
  // loading (it doesn't even have load()), so a real <MarkdownVideo> errors on
  // mount and degrades to its unresolvable-file chip, which is not the shape
  // under test here.
  it('restores a video as the image link it was written as', () => {
    const host = document.createElement('div')
    host.setAttribute('data-md-root', '')
    host.innerHTML =
      '<p>intro line</p>'
      + '<p><span><video data-md-src="/tmp/demo.webm" data-md-alt="the popover"'
      + ' aria-label="the popover" src="/blob?path=demo.webm"></video></span></p>'
      + '<p>closing line</p>'
    document.body.appendChild(host)
    expect(copyBetween(host, { text: 'intro line', offset: 6 }, { text: 'closing line', offset: 7 })).toBe(
      'line\n\n![the popover](/tmp/demo.webm)\n\nclosing',
    )
    host.remove()
  })

  it('copies raw code when the selection stays inside a code block', () => {
    const { container } = render(<Markdown text={'```js\nconst a = 1\nconst b = 2\n```'} />)
    const code = container.querySelector('[data-md-code-block]')!
    const range = document.createRange()
    range.selectNodeContents(code)
    expect(selectionToMarkdown(sel(range))).toBe('const a = 1\nconst b = 2')
  })

  // What a real triple-click hands over, measured in Chrome: the range starts
  // on the clicked line's text but ENDS at offset 0 of the next block's
  // container - a boundary that contributes no characters, yet lifts the common
  // ancestor out of the code block. Everything here is that shape.
  describe('a selection that only covers code', () => {
    // spillingRange renders `text` followed by a second message and returns a
    // range from the start of the line beginning `startsWith` to offset 0 of
    // whatever block comes next - the block after it in the same message, or
    // the next message's root when it was the last one.
    function spillingRange(text: string, startsWith: string) {
      const { container } = render(
        <div>
          <div><Markdown text={text} /></div>
          <div><Markdown text="next message" /></div>
        </div>,
      )
      const walk = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
      let start: Text | null = null
      for (let n = walk.nextNode(); n && !start; n = walk.nextNode()) {
        if ((n as Text).data.startsWith(startsWith)) start = n as Text
      }
      if (!start) throw new Error('line not found')
      // The top-level block of the message that holds the clicked line.
      let blk: Element = start.parentElement!
      while (!blk.parentElement!.hasAttribute('data-md-root')) blk = blk.parentElement!
      const range = document.createRange()
      range.setStart(start, 0)
      range.setEnd(blk.nextElementSibling ?? container.querySelectorAll('[data-md-root]')[1], 0)
      return range
    }

    it('copies a one-line code block as the bare command', () => {
      expect(selectionToMarkdown(sel(spillingRange('```bash\nnpm run dev\n```', 'npm')))).toBe(
        'npm run dev',
      )
    })

    it('copies it bare even when the message has prose around it', () => {
      const md = 'Run this:\n\n```bash\nnpm run dev\n```\n\nThen reload.'
      expect(selectionToMarkdown(sel(spillingRange(md, 'npm')))).toBe('npm run dev')
    })

    it('copies an inline code span without its backticks', () => {
      expect(selectionToMarkdown(sel(spillingRange('`git status --short`', 'git status')))).toBe(
        'git status --short',
      )
    })

    it('copies only the prose when the click landed on the prose', () => {
      const md = 'Run this:\n\n```bash\nnpm run dev\n```'
      expect(selectionToMarkdown(sel(spillingRange(md, 'Run this:')))).toBe('Run this:')
    })

    it('still fences a selection that reaches out of the code block', () => {
      const md = 'Run this:\n\n```bash\nnpm run dev\n```'
      const { container } = render(<Markdown text={md} />)
      expect(copyBetween(container, { text: 'Run', offset: 0 }, { text: 'run dev', offset: 7 })).toBe(md)
    })

    // Narrowing must stop at content that has no text of its own, or the image
    // a selection ends on would fall outside it.
    it('keeps a trailing image the selection ends past', () => {
      const { container } = render(<Markdown text="text ![alt](https://example.com/a.png)" />)
      const first = document.createTreeWalker(container, NodeFilter.SHOW_TEXT).nextNode() as Text
      const range = document.createRange()
      range.setStart(first, 2)
      range.setEnd(container, container.childNodes.length)
      expect(selectionToMarkdown(sel(range))).toBe('xt ![alt](https://example.com/a.png)')
    })
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

  // A tool card's code panel (GutterCodePanel): the line numbers are a
  // select-none gutter and each line is a grid CELL, not a block element - so
  // without the data-copy-* markers the whole script copies as one line.
  it('keeps the lines of a line-numbered code panel apart', () => {
    const lines = ['cd web &&', '(fuser -k 21765/tcp; true) &&', '    node scripts/probe.ts']
    const { container } = render(
      <div>
        <div data-copy-code>
          {lines.map((l, i) => (
            <span key={i}>
              <span style={{ userSelect: 'none' }}>{i + 1}</span>
              <span data-copy-line>{l}</span>
            </span>
          ))}
        </div>
      </div>,
    )
    const range = document.createRange()
    range.selectNodeContents(container)
    expect(selectionToMarkdown(sel(range))).toBe(lines.join('\n'))
  })

  it('keeps the newlines and indentation of a pre panel', () => {
    const { container } = render(
      <div>
        <div>Output</div>
        <pre>{'ok\n    indented\n\nlast'}</pre>
      </div>,
    )
    const range = document.createRange()
    range.selectNodeContents(container)
    expect(selectionToMarkdown(sel(range))).toBe('Output\nok\n    indented\n\nlast')
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

  // A whole-message selection short-circuits the DOM walk and copies the source
  // the message was rendered from, so nothing normalises away.
  describe('whole-message selection', () => {
    // Source whose rendering the serializer would faithfully round-trip but not
    // character-for-character: '*' bullets, a setext heading, a reference link,
    // padded table columns, a hard-wrapped paragraph.
    const source = [
      'Title',
      '=====',
      '',
      'A paragraph hard-wrapped',
      'across two source lines.',
      '',
      '* first',
      '* second',
      '',
      'See [the docs][d] for more.',
      '',
      '| col | other |',
      '|:----|------:|',
      '| 1   |     2 |',
      '',
      '[d]: https://example.com/docs',
    ].join('\n')

    it('copies the original source verbatim when the whole root is selected', () => {
      const { container } = render(<Markdown text={source} variant="doc" />)
      const range = document.createRange()
      range.selectNodeContents(container)
      // Including the reference definition, which renders to nothing but which
      // the copied link would be broken without.
      expect(selectionToMarkdown(sel(range))).toBe(source.trim())
    })

    it('takes the verbatim path from inside the message too (triple-click)', () => {
      const { container } = render(<Markdown text={'a **b** c'} />)
      const p = container.querySelector('p')!
      const range = document.createRange()
      range.selectNodeContents(p)
      expect(selectionToMarkdown(sel(range))).toBe('a **b** c')
    })

    it('falls back to serializing when the selection stops short', () => {
      const { container } = render(<Markdown text={'* first\n* second'} />)
      // Everything except the last character of the last item.
      const out = copyBetween(container, { text: 'first', offset: 0 }, { text: 'second', offset: 5 })
      expect(out).toBe('- first\n- secon')
    })

    it('copies each fully selected message from its own source', () => {
      const { container } = render(
        <div>
          <div><Markdown text={'* one'} /></div>
          <div><Markdown text={'* two'} /></div>
        </div>,
      )
      const range = document.createRange()
      range.selectNodeContents(container)
      expect(selectionToMarkdown(sel(range))).toBe('* one\n\n* two')
    })

    it('still copies raw code for a code block that is the whole message', () => {
      const { container } = render(<Markdown text={'```js\nconst a = 1\n```'} />)
      const code = container.querySelector('[data-md-code-block]')!
      const range = document.createRange()
      range.selectNodeContents(code)
      expect(selectionToMarkdown(sel(range))).toBe('const a = 1')
    })
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
