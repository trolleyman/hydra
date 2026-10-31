import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { HighlightedTextarea } from '../../components/HighlightedTextarea'
import type { MarkdownComposerHandle, MarkdownComposerProps } from './MarkdownComposer'

// Compact note surfaces share the same Markdown contract in either editor mode.
// Chat and Spawn own their native source input and attachment/history handlers.
export const SourceMarkdownComposer = forwardRef<MarkdownComposerHandle, MarkdownComposerProps>(function SourceMarkdownComposer({
  value, onChange, onKeyDown, editable = true, autoFocus = false, placeholder,
  ariaLabel = 'Message', dataDesktopImagePaste = false, spellCheck, className = '',
}, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [minimumHeight, setMinimumHeight] = useState(0)
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    // Notes have an intrinsic height; review replies can still fill their card.
    textarea.style.height = '0px'
    const height = textarea.scrollHeight
    textarea.style.height = ''
    setMinimumHeight((current) => current === height ? current : height)
  }, [value, className])
  useImperativeHandle(ref, () => ({
    editor: null,
    focus: (position = 'end') => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      const offset = position === 'start' ? 0 : position === 'end' ? textarea.value.length : position
      textarea.setSelectionRange(offset, offset)
    },
  }), [])
  return (
    <HighlightedTextarea
      ref={textareaRef}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        const handled = onKeyDown?.(event.nativeEvent, { editor: null, markdown: value, empty: value.trim() === '' })
        if (handled || event.nativeEvent.defaultPrevented) event.preventDefault()
      }}
      disabled={!editable}
      autoFocus={autoFocus}
      placeholder={placeholder}
      aria-label={ariaLabel}
      data-desktop-image-paste={dataDesktopImagePaste || undefined}
      {...(spellCheck === undefined ? {} : { spellCheck })}
      wrapperClassName="h-full w-full min-h-0"
      wrapperStyle={{ minHeight: minimumHeight || '1lh' }}
      textClassName={className}
      style={{ color: 'transparent' }}
    />
  )
})
