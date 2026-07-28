import { forwardRef, useEffect, useImperativeHandle, useRef, type InputHTMLAttributes, type ReactNode } from 'react'

type HighlightedInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'value'> & {
  value: string
  // Box-model classes shared by the input and the highlight backdrop. These MUST
  // control padding / font-size / line-height identically so the two layers line
  // up exactly; do not put text color here.
  textClassName?: string
  // Layout + chrome classes for the positioned wrapper. The border, background
  // and focus ring belong HERE (via focus-within:), not on the input - the input
  // is transparent and sits over the backdrop, so a ring on it would be drawn
  // above the text it is meant to frame.
  wrapperClassName?: string
  // Text color for the backdrop, and caret color for the (transparent) input.
  textColorClassName?: string
  caretClassName?: string
  // How the backdrop renders the value. MUST preserve the value's exact
  // characters so the backdrop stays glyph-aligned with the input below it.
  renderContent: (value: string) => ReactNode
}

// HighlightedInput is the single-line sibling of HighlightedTextarea: a backdrop
// div mirrors the input (same box model, same text) while the input itself keeps
// a visible caret but transparent text, so only the highlighted backdrop shows.
//
// Simpler than the textarea version in one way and fussier in another: there is
// no wrapping to mirror, but a single line scrolls HORIZONTALLY once the value
// outgrows the box, and an <input> fires `scroll` far less reliably than a
// textarea does. So the backdrop is re-synced from several events plus once per
// render - a couple of assignments each, and the alternative is text that
// silently drifts out of register with its own caret.
export const HighlightedInput = forwardRef<HTMLInputElement, HighlightedInputProps>(
  function HighlightedInput(
    {
      value,
      textClassName = '',
      wrapperClassName = '',
      textColorClassName = 'text-gray-800 dark:text-gray-100',
      caretClassName = 'caret-gray-800 dark:caret-gray-100',
      renderContent,
      onScroll,
      onInput,
      onKeyUp,
      onSelect,
      ...rest
    },
    ref,
  ) {
    const innerRef = useRef<HTMLInputElement>(null)
    const backdropRef = useRef<HTMLDivElement>(null)
    useImperativeHandle(ref, () => innerRef.current as HTMLInputElement)

    function syncScroll() {
      const el = innerRef.current
      const bd = backdropRef.current
      if (!el || !bd) return
      bd.scrollLeft = el.scrollLeft
    }

    // Re-sync after every render, on the next frame - covers the paths that move
    // the input's scroll offset without firing anything we listen to (a value
    // set from outside, the browser restoring a scrolled field).
    useEffect(() => {
      const id = requestAnimationFrame(syncScroll)
      return () => cancelAnimationFrame(id)
    })

    return (
      <div className={`relative ${wrapperClassName}`}>
        <div
          ref={backdropRef}
          aria-hidden="true"
          className={`absolute inset-0 overflow-hidden whitespace-pre pointer-events-none border border-transparent ${textColorClassName} ${textClassName}`}
        >
          {renderContent(value)}
        </div>
        <input
          ref={innerRef}
          type="text"
          value={value}
          onScroll={(e) => { syncScroll(); onScroll?.(e) }}
          onInput={(e) => { syncScroll(); onInput?.(e) }}
          onKeyUp={(e) => { syncScroll(); onKeyUp?.(e) }}
          onSelect={(e) => { syncScroll(); onSelect?.(e) }}
          className={`relative w-full bg-transparent text-transparent border border-transparent focus:outline-none ${caretClassName} ${textClassName}`}
          {...rest}
        />
      </div>
    )
  },
)
