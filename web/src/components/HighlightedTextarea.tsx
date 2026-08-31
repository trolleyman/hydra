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
import { autoPairEdit, backspacePairEdit, fenceEnterEdit } from '../lib/autoPair'
import { useAutoPairStore, useSpellcheckStore } from '../lib/composerPrefs'

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
  // Optional colour classes for a backdrop-rendered placeholder. When set, the
  // textarea keeps its real placeholder for accessibility but makes it
  // transparent; the backdrop draws the visible copy with a small leading inset
  // so a focused empty field's caret does not cut through its first glyph.
  placeholderClassName?: string
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
      placeholderClassName,
      renderContent = renderMarkdownSource,
      placeholder,
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
    const spellcheck = useSpellcheckStore((s) => s.enabled)

    function syncScroll() {
      const ta = innerRef.current
      const bd = backdropRef.current
      if (!ta || !bd) return
      bd.scrollTop = ta.scrollTop
      bd.scrollLeft = ta.scrollLeft
    }

    // Auto-pairing (lib/autoPair), when the preference is on: a typed opener
    // brings its closer along, a typed closer steps over the one already there,
    // Backspace between an empty pair clears both, a mark typed over a selection
    // wraps it, and Enter on a just-opened fence steps into its body instead of
    // adding a line that is already there. Returns whether it handled the key.
    // Skipped for shortcuts (Cmd, or Ctrl without Alt - AltGr sets both) and
    // mid-composition, where the "key" is not a character the user is typing.
    function pairingKeys(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (!autoPair || e.nativeEvent.isComposing || e.metaKey || (e.ctrlKey && !e.altKey)) return false
      const ta = e.currentTarget
      const start = ta.selectionStart ?? 0
      const end = ta.selectionEnd ?? 0
      const edit =
        e.key === 'Backspace'
          ? backspacePairEdit(ta.value, start, end)
          : e.key === 'Enter'
            ? fenceEnterEdit(ta.value, start, end)
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
          // Make this a real vertical scroll container, just like the textarea.
          // Some native textarea editors reserve their scrollbar INSIDE the
          // reported client width, so measuring that width still leaves an
          // overflow-hidden mirror a few pixels too wide. Giving both layers an
          // actual, stable scroll column makes their wrap boundary identical;
          // index.css keeps this backing scrollbar transparent.
          // overflow-anchor: none for the same reason ShellEditor's highlight
          // layer sets it: this layer is scroll-DRIVEN, so letting Chrome's
          // scroll anchoring adjust its scrollTop when the highlighted content
          // re-lays out is exactly a desync from the textarea below.
          style={{ scrollbarGutter: 'stable', overflowAnchor: 'none' }}
          // prompt-input-font pins Roboto Flex on BOTH layers so their metrics
          // match exactly and the backdrop's *italic* runs can slant via the
          // font's slnt axis without drifting the textarea caret (see index.css).
          className={`highlighted-textarea-backdrop prompt-input-font absolute inset-0 overflow-x-hidden overflow-y-scroll pointer-events-none whitespace-pre-wrap break-words ${textColorClassName} ${textClassName}`}
        >
          {value || !placeholderClassName
            ? renderContent(value)
            : <span className={`inline-block pl-0.5 ${placeholderClassName}`}>{placeholder}</span>}
          {/* Trailing newline keeps the backdrop's height matching the textarea
              when the value ends in a newline. */}
          {'\n'}
        </div>
        <textarea
          ref={innerRef}
          value={value}
          placeholder={placeholder}
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
          // The browser's own spellchecker, off unless the Browser setting turns
          // it on (see lib/composerPrefs). Before {...rest} so a caller that has
          // its own opinion - the config editors, which are never prose - still
          // wins.
          spellCheck={spellcheck}
          // Match the backdrop's reserved scrollbar gutter so both layers wrap
          // text at the same width (see the backdrop above).
          style={{ scrollbarGutter: 'stable', ...style }}
          className={`prompt-input-font absolute inset-0 w-full h-full resize-none bg-transparent text-transparent ${placeholderClassName ? 'placeholder:text-transparent' : ''} ${caretClassName} focus:outline-none ${textClassName}`}
          {...rest}
        />
      </div>
    )
  },
)
