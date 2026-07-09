import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type TextareaHTMLAttributes,
} from 'react'
import { renderMarkdownSource } from '../lib/markdown'

type HighlightedTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> & {
  value: string
  // Box-model classes shared by the textarea and the highlight backdrop. These
  // MUST control padding / font-size / line-height identically so the two
  // layers line up exactly; do not put text color here.
  textClassName?: string
  // Layout classes for the positioned wrapper (sizing, drag-over ring, etc).
  wrapperClassName?: string
  // Inline styles for the positioned wrapper. Useful when a consumer drives the
  // control's height imperatively (e.g. the chat composer's per-line auto-grow),
  // since the textarea itself is absolutely positioned and can't size the box.
  wrapperStyle?: CSSProperties
  // Text color for the highlight backdrop, and caret color for the (transparent)
  // textarea. Defaults match the neutral gray used by the spawn form; override to
  // blend into a differently-tinted surface (e.g. the stone-toned chat composer).
  textColorClassName?: string
  caretClassName?: string
}

// HighlightedTextarea is a drop-in textarea that renders live inline-markdown
// highlighting behind a transparent input. A backdrop div mirrors the textarea
// (same box model, same wrapped text) and is scroll-synced to it; the textarea
// keeps a visible caret but transparent text so only the highlighted backdrop
// shows through.
export const HighlightedTextarea = forwardRef<HTMLTextAreaElement, HighlightedTextareaProps>(
  function HighlightedTextarea(
    {
      value,
      textClassName = '',
      wrapperClassName = '',
      wrapperStyle,
      textColorClassName = 'text-gray-800 dark:text-gray-100',
      caretClassName = 'caret-gray-800 dark:caret-gray-100',
      onScroll,
      style,
      ...rest
    },
    ref,
  ) {
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

    // Re-sync after every render, on the next frame: the textarea's scroll
    // offset can be set imperatively (e.g. SpawnForm restoring a per-project
    // saved offset after the draft loads) without firing onScroll, so this
    // catches those and keeps the highlight backdrop aligned.
    useEffect(() => {
      const id = requestAnimationFrame(syncScroll)
      return () => cancelAnimationFrame(id)
    })

    return (
      <div className={`relative ${wrapperClassName}`} style={wrapperStyle}>
        <div
          ref={backdropRef}
          aria-hidden="true"
          // Reserve the scrollbar gutter on both layers (matching the textarea
          // below). Without this, once the textarea overflows its scrollbar
          // narrows its wrap column relative to this backdrop, the two layers
          // wrap text at different widths, and the mismatch drifts the visible
          // (highlighted) text away from the real (selectable) text.
          style={{ scrollbarGutter: 'stable' }}
          className={`absolute inset-0 overflow-hidden pointer-events-none whitespace-pre-wrap break-words ${textColorClassName} ${textClassName}`}
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
          // Match the backdrop's reserved scrollbar gutter so both layers wrap
          // text at the same width (see the backdrop above).
          style={{ scrollbarGutter: 'stable', ...style }}
          className={`absolute inset-0 w-full h-full resize-none bg-transparent text-transparent ${caretClassName} focus:outline-none ${textClassName}`}
          {...rest}
        />
      </div>
    )
  },
)
