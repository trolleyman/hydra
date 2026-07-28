import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { renderMarkdownSource } from '../lib/markdown'
import { applyEdit, enterEdit, ensureCaretVisible, moveCaret, visualLineTarget } from '../lib/textareaEdit'
import { autoPairEdit, backspacePairEdit } from '../lib/autoPair'
import { useAutoPairStore } from '../lib/composerPrefs'

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
  // Override how the backdrop renders the value. Defaults to inline-markdown
  // highlighting; the chat composer swaps in a bash highlighter when the text is
  // a "!command". MUST preserve the value's exact characters/whitespace so the
  // backdrop stays glyph-aligned with the transparent textarea below it.
  renderContent?: (value: string) => ReactNode
}

// HighlightedTextarea is a drop-in textarea that renders live inline-markdown
// highlighting behind a transparent input. A backdrop div mirrors the textarea
// (same box model, same wrapped text) and is scroll-synced to it; the textarea
// keeps a visible caret but transparent text so only the highlighted backdrop
// shows through.
//
// It also carries the editing behaviours every composer shares (lib/textareaEdit):
// Enter continues a markdown list, Home/End walk VISUAL lines, and the caret's
// line is kept fully in view (padding included) when the box scrolls. Plus
// auto-pairing (lib/autoPair), when the Browser setting is on. The consumer's own
// onKeyDown runs first and wins - a handler that calls preventDefault
// (Enter-to-send, Ctrl+Enter-to-submit) is left alone.
export const HighlightedTextarea = forwardRef<HTMLTextAreaElement, HighlightedTextareaProps>(
  function HighlightedTextarea(
    {
      value,
      textClassName = '',
      wrapperClassName = '',
      wrapperStyle,
      textColorClassName = 'text-gray-800 dark:text-gray-100',
      caretClassName = 'caret-gray-800 dark:caret-gray-100',
      renderContent = renderMarkdownSource,
      onScroll,
      onKeyDown,
      onInput,
      style,
      ...rest
    },
    ref,
  ) {
    const innerRef = useRef<HTMLTextAreaElement>(null)
    const backdropRef = useRef<HTMLDivElement>(null)
    useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement)
    const autoPair = useAutoPairStore((s) => s.enabled)

    function syncScroll() {
      const ta = innerRef.current
      const bd = backdropRef.current
      if (!ta || !bd) return
      bd.scrollTop = ta.scrollTop
      bd.scrollLeft = ta.scrollLeft
    }

    // Auto-pairing (lib/autoPair), when the preference is on: a typed opener
    // brings its closer along, a typed closer steps over the one already there,
    // Backspace between an empty pair clears both, and a mark typed over a
    // selection wraps it. Returns whether it handled the key. Skipped for
    // shortcuts (Cmd, or Ctrl without Alt - AltGr sets both) and mid-composition,
    // where the "key" is not a character the user is typing into the text.
    function pairingKeys(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (!autoPair || e.nativeEvent.isComposing || e.metaKey || (e.ctrlKey && !e.altKey)) return false
      const ta = e.currentTarget
      const start = ta.selectionStart ?? 0
      const end = ta.selectionEnd ?? 0
      const edit =
        e.key === 'Backspace'
          ? backspacePairEdit(ta.value, start, end)
          : autoPairEdit(e.key, ta.value, start, end)
      if (!edit) return false
      e.preventDefault()
      applyEdit(ta, edit)
      requestAnimationFrame(() => ensureCaretVisible(ta))
      return true
    }

    // The shared editing keys, run only after the consumer's own onKeyDown has
    // passed on the keystroke (see the component comment).
    function editingKeys(e: React.KeyboardEvent<HTMLTextAreaElement>) {
      if (pairingKeys(e)) return
      const ta = e.currentTarget
      if (e.key === 'Enter' && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const edit = enterEdit(ta.value, ta.selectionStart ?? 0, ta.selectionEnd ?? 0)
        if (edit) {
          e.preventDefault()
          applyEdit(ta, edit)
          requestAnimationFrame(() => ensureCaretVisible(ta))
        }
        return
      }
      if ((e.key === 'End' || e.key === 'Home') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const caret = ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd
        const to = visualLineTarget(ta, caret ?? 0, e.key === 'End' ? 'end' : 'start')
        if (to != null) {
          e.preventDefault()
          moveCaret(ta, to, e.shiftKey)
          ensureCaretVisible(ta)
        }
      }
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
          // prompt-input-font pins Roboto Flex on BOTH layers so their metrics
          // match exactly and the backdrop's *italic* runs can slant via the
          // font's slnt axis without drifting the textarea caret (see index.css).
          className={`prompt-input-font absolute inset-0 overflow-hidden pointer-events-none whitespace-pre-wrap break-words ${textColorClassName} ${textClassName}`}
        >
          {renderContent(value)}
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
          onKeyDown={(e) => {
            onKeyDown?.(e)
            if (!e.defaultPrevented) editingKeys(e)
          }}
          // Typing that pushes the caret onto a new line scrolls it barely into
          // frame, clipping the box's bottom padding (and with it the bottom
          // edge of anything the backdrop draws around the line, e.g. a fenced
          // code block). Re-do the scroll properly once the edit has laid out.
          onInput={(e) => {
            onInput?.(e)
            const ta = e.currentTarget
            requestAnimationFrame(() => ensureCaretVisible(ta))
          }}
          // Match the backdrop's reserved scrollbar gutter so both layers wrap
          // text at the same width (see the backdrop above).
          style={{ scrollbarGutter: 'stable', ...style }}
          className={`prompt-input-font absolute inset-0 w-full h-full resize-none bg-transparent text-transparent ${caretClassName} focus:outline-none ${textClassName}`}
          {...rest}
        />
      </div>
    )
  },
)
