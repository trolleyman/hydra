import { useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'
import hljs from '../lib/hljs'
import { ResizeHandle } from '../lib/ResizeHandle'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Split highlight.js HTML into one fragment per source line, re-opening any
// <span> tokens that stay open across a newline so each line is independently
// valid markup. This lets us render a row per logical line (with a line-number
// gutter) while keeping multi-line constructs (heredocs, `\` continuations,
// quoted strings) correctly coloured.
function splitHighlightedLines(html: string): string[] {
  const open: string[] = []
  const tag = /<span\b[^>]*>|<\/span>/g
  return html.split('\n').map((line) => {
    const prefix = open.join('')
    tag.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = tag.exec(line))) {
      if (m[0] === '</span>') open.pop()
      else open.push(m[0])
    }
    return prefix + line + '</span>'.repeat(open.length)
  })
}

// ShellEditor is a small textarea with live bash syntax highlighting and a
// line-number gutter. A transparent textarea sits on top of a highlighted <pre>
// layer that mirrors its text line-for-line, sharing identical typography,
// padding and wrap width so the caret and characters line up exactly. The
// gutter width and the textarea's left padding both read the same
// `--shell-gutter` length, keeping the two wrap columns the same width.
// Reuses the highlight.js `.hljs-*` token theme already defined in index.css.
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

  const lines = useMemo(() => {
    const src = value ?? ''
    let html: string
    try {
      html = hljs.highlight(src, { language: 'bash', ignoreIllegals: true }).value
    } catch {
      html = escapeHtml(src)
    }
    return splitHighlightedLines(html)
  }, [value])

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
        className={typography + ' m-0 py-2 pr-3 absolute inset-0 overflow-auto pointer-events-none text-gray-800 dark:text-gray-100'}
        // Reserve the scrollbar gutter on both layers so their text columns stay
        // the same width whether or not the textarea is scrolling. Without this,
        // the textarea's scrollbar narrows its wrap column relative to this <pre>,
        // and the differing wraps accumulate into a vertical drift once scrolled.
        style={{ scrollbarGutter: 'stable' }}
      >
        {lines.map((html, i) => (
          <div key={i} className="flex">
            <span
              className="shrink-0 box-border pl-3 pr-2 text-right select-none text-gray-400 dark:text-gray-600"
              style={{ width: 'var(--shell-gutter)' }}
            >
              {i + 1}
            </span>
            <span
              className="flex-1 min-w-0 whitespace-pre-wrap break-words"
              dangerouslySetInnerHTML={{ __html: html.length ? html : ' ' }}
            />
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
