import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'
import { highlightLines } from '../lib/highlightCore'
import { ResizeHandle } from '../lib/ResizeHandle'

// ShellEditor is a small textarea with live bash syntax highlighting and a
// line-number gutter. A transparent textarea sits on top of a highlighted <pre>
// layer that mirrors its text exactly, sharing identical typography, padding and
// wrap width so the caret and characters line up whatever the scroll position.
// Both layers reserve the line-number column with the same `padding-left:
// var(--shell-gutter)`, so their text wraps in a pixel-identical box; the line
// numbers are absolutely positioned into that reserved gutter, out of the text
// flow. Reuses the Prism `.token` theme already defined in index.css.
export function ShellEditor({
  value,
  onChange,
  placeholder,
  rows = 8,
  className = '',
}: {
  value: string
  onChange: (val: string) => void
  placeholder?: string
  rows?: number
  className?: string
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)

  // One HTML fragment per source line, so a row per logical line can carry a
  // line-number gutter while multi-line constructs (heredocs, `\` continuations,
  // quoted strings) stay correctly coloured across the breaks. highlightLines
  // falls back to escaped plain text when bash can't be highlighted at all.
  //
  // It can return FEWER rows than the text has lines: a value ending in "\n" has
  // a final empty line the highlighter drops. The textarea keeps that line, so
  // dropping it here makes this layer one line shorter than the textarea - which
  // caps its scrollTop lower and slides the highlighted text out of register
  // with the real one. Pad back to the source line count.
  const lines = useMemo(() => {
    const want = (value ?? '').split('\n').length
    const html = highlightLines(value ?? '', 'bash')
    while (html.length < want) html.push('')
    return html.length > want ? html.slice(0, want) : html
  }, [value])

  // Reserve room for the widest line number plus the separator rule and its
  // breathing room either side. The spacing matches the chat's Read/Write card
  // gutter (AgentChat's GutterCodePanel): 8px, the digits, 8px, the 1px rule,
  // 10px. In the monospace font 1ch is one digit, so `${digits}ch` fits the
  // gutter text; the numbers' 19px padding-right and the rule's 11px offset from
  // the text column are the other two halves of that 27px.
  const gutter = `calc(27px + ${String(lines.length).length}ch)`

  // Keep the highlight layer scrolled in lockstep with the textarea.
  function syncScroll() {
    if (taRef.current && preRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop
      preRef.current.scrollLeft = taRef.current.scrollLeft
    }
  }
  useLayoutEffect(syncScroll, [value])
  // ...and again on the next frame, every render. Typing scrolls the textarea to
  // keep the caret in view, which can land after this render's layout pass (and
  // does not reliably fire onScroll), leaving the highlight layer a line behind
  // the text until the next scroll happened to nudge it back.
  useEffect(() => {
    const id = requestAnimationFrame(syncScroll)
    return () => cancelAnimationFrame(id)
  })

  // Identical typography on both layers so glyphs align exactly.
  const typography = 'font-mono text-sm leading-[1.5] tracking-normal'

  return (
    <div className={className}>
    <div
      className={
        'relative rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-inner overflow-hidden focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all'
      }
      style={{ '--shell-gutter': gutter } as CSSProperties}
    >
      <pre
        ref={preRef}
        aria-hidden="true"
        // overflow-HIDDEN, not auto: this layer is scrolled programmatically, so
        // it needs to be a scroll container but must never paint a scrollbar of
        // its own - an `auto` one drew a second, dead scrollbar beside the
        // textarea's real one.
        className={typography + ' m-0 py-2 pr-3 whitespace-pre-wrap break-words absolute inset-0 overflow-hidden pointer-events-none text-gray-800 dark:text-gray-100'}
        // The highlight layer must wrap text in a box that is *pixel-identical*
        // to the textarea's, or the two accumulate a vertical drift when
        // scrolled. So this <pre> mirrors the textarea exactly: same padding-left
        // (the gutter reservation), same padding-right, same scrollbar-gutter, and
        // plain block-flowed lines - no flex row whose column widths could round
        // a sub-pixel differently from the textarea's padding. Line numbers are
        // absolutely positioned into the reserved gutter (out of flow) so they
        // can't perturb the wrap width. `scrollbar-gutter: stable` keeps both
        // text columns the same width whether or not the textarea is scrolling.
        //
        // overflow-anchor: none because this layer is scroll-driven, not
        // scrolled: when its content re-lays out (the highlighter's grammar
        // landing, a font swap) Chrome's scroll anchoring "helpfully" shifts its
        // scrollTop to keep the anchored line still - which is precisely the
        // desync, since the textarea underneath never moved.
        style={{ paddingLeft: 'var(--shell-gutter)', scrollbarGutter: 'stable', overflowAnchor: 'none' }}
      >
        {lines.map((html, i) => (
          <div key={i} className="relative">
            <span
              className="absolute text-right select-none text-gray-400 dark:text-gray-600"
              style={{ right: '100%', width: 'var(--shell-gutter)', paddingRight: '19px' }}
            >
              {i + 1}
            </span>
            <span dangerouslySetInnerHTML={{ __html: html.length ? html : ' ' }} />
          </div>
        ))}
      </pre>
      {/* The gutter rule, drawn on the frame rather than per line so it spans the
          whole box (past the last line) and never scrolls out from under the
          numbers. Sits between the numbers and the code, as the chat's Read card
          does. Inset by the layers' own py-2 so it starts level with the first
          line rather than running into the frame - the repository view's rule,
          being per line, sits inside that same padding. */}
      <div
        aria-hidden="true"
        className="absolute top-2 bottom-2 w-px bg-gray-200 dark:bg-gray-700 pointer-events-none"
        style={{ left: 'calc(var(--shell-gutter) - 11px)' }}
      />
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        rows={rows}
        // `block`: a textarea is inline-block by default, so the line box it
        // sits in reserves room for the font's descender under it and the
        // wrapper ends up ~8px taller than the textarea. The highlight layer is
        // `inset-0`, so it inherited those 8px, giving the two layers different
        // client heights - and therefore different maximum scrollTops, which is
        // what slid the highlighted text out of register near the bottom.
        className={
          typography +
          ' relative block w-full resize-none m-0 py-2 pr-3 whitespace-pre-wrap break-words border-0 bg-transparent text-transparent caret-gray-800 dark:caret-gray-100 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none'
        }
        style={{ paddingLeft: 'var(--shell-gutter)', scrollbarGutter: 'stable' }}
      />
    </div>
    <ResizeHandle targetRef={taRef} minHeight={64} />
    </div>
  )
}
