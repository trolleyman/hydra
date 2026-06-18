import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'

// Simple inline-markdown support. We deliberately do NOT pull in a full
// markdown library (or handle block constructs like #headings): the only goal
// is to highlight `code` spans and *italic* / **bold** emphasis in short bits
// of user-facing text (prompts, agent activity lines). Everything else is left
// as-is, and all whitespace/newlines are preserved so callers can render inside
// a `whitespace-pre-wrap` container.

type Seg =
  | { kind: 'text'; value: string }
  | { kind: 'code'; marker: string; value: string }
  | { kind: 'bold'; marker: string; value: string }
  | { kind: 'italic'; marker: string; value: string }

// Inline patterns, tried in order at each position. `**`/`__` must precede the
// single-char `*`/`_` so the longer marker wins. Each pattern is anchored to
// the current scan position and forbids newlines inside the span so an unclosed
// marker doesn't swallow the rest of the text.
const PATTERNS: { kind: 'code' | 'bold' | 'italic'; re: RegExp }[] = [
  { kind: 'code', re: /^`([^`\n]+)`/ },
  { kind: 'bold', re: /^\*\*([^\n]+?)\*\*/ },
  { kind: 'bold', re: /^__([^\n]+?)__/ },
  { kind: 'italic', re: /^\*([^\n]+?)\*/ },
  { kind: 'italic', re: /^_([^\n]+?)_/ },
]

// parseInline splits text into styled/plain segments. The concatenation of all
// segments' source (marker + value + marker) is exactly the input, so callers
// that need character-for-character fidelity (e.g. a textarea overlay) can rely
// on it.
function parseInline(text: string): Seg[] {
  const segs: Seg[] = []
  let buf = ''
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    let hit: { kind: 'code' | 'bold' | 'italic'; m: RegExpExecArray } | null = null
    for (const p of PATTERNS) {
      const m = p.re.exec(rest)
      if (m) {
        hit = { kind: p.kind, m }
        break
      }
    }
    if (hit) {
      if (buf) {
        segs.push({ kind: 'text', value: buf })
        buf = ''
      }
      const full = hit.m[0]
      const inner = hit.m[1]
      const marker = full.slice(0, (full.length - inner.length) / 2)
      segs.push({ kind: hit.kind, marker, value: inner })
      i += full.length
    } else {
      buf += text[i]
      i += 1
    }
  }
  if (buf) segs.push({ kind: 'text', value: buf })
  return segs
}

const CODE_CLASS =
  'rounded bg-gray-200/70 dark:bg-gray-700/60 px-1 py-px font-mono text-[0.9em] text-pink-600 dark:text-pink-300'

export interface RenderMarkdownOptions {
  // When true, text that begins with a `$` is rendered entirely as a code span
  // (the `$` included), overriding all other markdown parsing. Used for agent
  // activity lines that report a shell command being run.
  dollarCommand?: boolean
}

// renderMarkdown turns inline markdown into styled React nodes for read-only
// display, dropping the markers themselves (so `*hi*` shows as italic "hi").
export function renderMarkdown(text: string, opts: RenderMarkdownOptions = {}): ReactNode {
  if (opts.dollarCommand && text.startsWith('$')) {
    return <code className={CODE_CLASS}>{text}</code>
  }
  const segs = parseInline(text)
  return segs.map((s, i) => {
    switch (s.kind) {
      case 'code':
        return (
          <code key={i} className={CODE_CLASS}>
            {s.value}
          </code>
        )
      case 'bold':
        return (
          <strong key={i} className="font-semibold">
            {s.value}
          </strong>
        )
      case 'italic':
        return (
          <em key={i} className="italic">
            {s.value}
          </em>
        )
      default:
        return <span key={i}>{s.value}</span>
    }
  })
}

// renderMarkdownSource renders text for a textarea overlay: it keeps every
// character (markers included) so it stays perfectly aligned with the textarea
// underneath, but tints code spans and dims emphasis markers so the structure
// reads as highlighted source rather than rendered output.
function renderMarkdownSource(text: string): ReactNode {
  const segs = parseInline(text)
  return segs.map((s, i) => {
    if (s.kind === 'text') return <span key={i}>{s.value}</span>
    if (s.kind === 'code') {
      return (
        <span key={i} className="rounded bg-gray-200/70 dark:bg-gray-700/60 font-mono text-pink-600 dark:text-pink-300">
          {s.marker}
          {s.value}
          {s.marker}
        </span>
      )
    }
    const emphasis = s.kind === 'bold' ? 'font-semibold' : 'italic'
    return (
      <span key={i} className={emphasis}>
        <span className="opacity-40">{s.marker}</span>
        {s.value}
        <span className="opacity-40">{s.marker}</span>
      </span>
    )
  })
}

type HighlightedTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> & {
  value: string
  // Box-model classes shared by the textarea and the highlight backdrop. These
  // MUST control padding / font-size / line-height identically so the two
  // layers line up exactly; do not put text color here.
  textClassName?: string
  // Layout classes for the positioned wrapper (sizing, drag-over ring, etc).
  wrapperClassName?: string
}

// HighlightedTextarea is a drop-in textarea that renders live inline-markdown
// highlighting behind a transparent input. A backdrop div mirrors the textarea
// (same box model, same wrapped text) and is scroll-synced to it; the textarea
// keeps a visible caret but transparent text so only the highlighted backdrop
// shows through.
export const HighlightedTextarea = forwardRef<HTMLTextAreaElement, HighlightedTextareaProps>(
  function HighlightedTextarea({ value, textClassName = '', wrapperClassName = '', onScroll, ...rest }, ref) {
    const innerRef = useRef<HTMLTextAreaElement>(null)
    const backdropRef = useRef<HTMLDivElement>(null)
    useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement)

    function syncScroll() {
      const ta = innerRef.current
      const bd = backdropRef.current
      if (!ta || !bd) return
      bd.scrollTop = ta.scrollTop
      bd.scrollLeft = ta.scrollLeft
    }

    return (
      <div className={`relative ${wrapperClassName}`}>
        <div
          ref={backdropRef}
          aria-hidden="true"
          className={`absolute inset-0 overflow-hidden pointer-events-none whitespace-pre-wrap break-words text-gray-800 dark:text-gray-100 ${textClassName}`}
        >
          {renderMarkdownSource(value)}
          {/* Trailing newline keeps the backdrop's height matching the textarea
              when the value ends in a newline. */}
          {'\n'}
        </div>
        <textarea
          ref={innerRef}
          value={value}
          onScroll={(e) => {
            syncScroll()
            onScroll?.(e)
          }}
          className={`absolute inset-0 w-full h-full resize-none bg-transparent text-transparent caret-gray-800 dark:caret-gray-100 focus:outline-none ${textClassName}`}
          {...rest}
        />
      </div>
    )
  },
)
