import { useLayoutEffect, useMemo, useRef } from 'react'
import hljs from 'highlight.js'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// ShellEditor is a small textarea with live bash syntax highlighting. A
// transparent textarea sits on top of a highlighted <pre> layer that mirrors its
// text, sharing identical typography/padding so the caret and characters line up.
// Reuses the highlight.js `.hljs-*` token theme already defined in index.css.
export function ShellEditor({
  value,
  onChange,
  placeholder,
  rows = 3,
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

  const highlighted = useMemo(() => {
    if (!value) return ''
    try {
      let html = hljs.highlight(value, { language: 'bash', ignoreIllegals: true }).value
      // A trailing newline isn't rendered by the textarea but collapses in the
      // <pre>, which would desync the last line — pad it so heights match.
      if (value.endsWith('\n')) html += ' '
      return html
    } catch {
      return escapeHtml(value)
    }
  }, [value])

  // Keep the highlight layer scrolled in lockstep with the textarea.
  function syncScroll() {
    if (taRef.current && preRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop
      preRef.current.scrollLeft = taRef.current.scrollLeft
    }
  }
  useLayoutEffect(syncScroll, [value])

  // Identical box metrics on both layers so glyphs align exactly.
  const shared =
    'm-0 px-3 py-2 font-mono text-sm leading-[1.5] tracking-normal whitespace-pre-wrap break-words border border-transparent'

  return (
    <div
      className={
        'relative rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-inner overflow-hidden focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all ' +
        className
      }
    >
      <pre
        ref={preRef}
        aria-hidden="true"
        className={shared + ' absolute inset-0 overflow-auto pointer-events-none text-gray-800 dark:text-gray-100'}
      >
        <code className="hljs language-bash bg-transparent p-0" dangerouslySetInnerHTML={{ __html: highlighted || '' }} />
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
          shared +
          ' relative w-full resize-y bg-transparent text-transparent caret-gray-800 dark:caret-gray-100 placeholder-gray-300 dark:placeholder-gray-600 focus:outline-none'
        }
      />
    </div>
  )
}
