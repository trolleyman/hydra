import { useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'
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
  const lines = useMemo(() => highlightLines(value ?? '', 'bash'), [value])

  // Reserve room for the widest line number plus left/right breathing room. In
  // the monospace font 1ch is one digit, so `${digits}ch` fits the gutter text.
  const gutter = `calc(20px + ${String(lines.length).length}ch)`

  // Keep the highlight layer scrolled in lockstep with the textarea.
  function syncScroll() {
    if (taRef.current && preRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop
      preRef.current.scrollLeft = taRef.current.scrollLeft
    }
  }
  useLayoutEffect(syncScroll, [value])

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
        className={typography + ' m-0 py-2 pr-3 whitespace-pre-wrap break-words absolute inset-0 overflow-auto pointer-events-none text-gray-800 dark:text-gray-100'}
        // The highlight layer must wrap text in a box that is *pixel-identical*
        // to the textarea's, or the two accumulate a vertical drift when
        // scrolled. So this <pre> mirrors the textarea exactly: same padding-left
        // (the gutter reservation), same padding-right, same scrollbar-gutter, and
        // plain block-flowed lines - no flex row whose column widths could round
        // a sub-pixel differently from the textarea's padding. Line numbers are
        // absolutely positioned into the reserved gutter (out of flow) so they
        // can't perturb the wrap width. `scrollbar-gutter: stable` keeps both
        // text columns the same width whether or not the textarea is scrolling.
        style={{ paddingLeft: 'var(--shell-gutter)', scrollbarGutter: 'stable' }}
      >
        {lines.map((html, i) => (
          <div key={i} className="relative">
            <span
              className="absolute pr-2 text-right select-none text-gray-400 dark:text-gray-600"
              style={{ right: '100%', width: 'var(--shell-gutter)' }}
            >
              {i + 1}
            </span>
            <span dangerouslySetInnerHTML={{ __html: html.length ? html : ' ' }} />
          </div>
        ))}
      </pre>
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
        className={
          typography +
          ' relative w-full resize-none m-0 py-2 pr-3 whitespace-pre-wrap break-words border-0 bg-transparent text-transparent caret-gray-800 dark:caret-gray-100 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none'
        }
        style={{ paddingLeft: 'var(--shell-gutter)', scrollbarGutter: 'stable' }}
      />
    </div>
    <ResizeHandle targetRef={taRef} minHeight={64} />
    </div>
  )
}
