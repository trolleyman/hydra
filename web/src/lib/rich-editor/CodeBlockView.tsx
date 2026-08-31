import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { CODE_LANGUAGES } from './codeLanguages'

interface PopoverPosition {
  left: number
  top: number
  maxHeight: number
  side: 'top' | 'bottom'
}

function canonicalLanguage(value: string): string {
  const trimmed = value.trim()
  const lower = trimmed.toLowerCase()
  return CODE_LANGUAGES.find(([id, name]) => id.toLowerCase() === lower || name.toLowerCase() === lower)?.[0] ?? trimmed
}

export function CodeBlockView({ editor, getPos, node, updateAttributes }: NodeViewProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState<PopoverPosition | null>(null)
  const controlRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLFormElement>(null)
  const optionsId = useId()
  const language = String(node.attrs.language ?? '')
  const label = CODE_LANGUAGES.find(([value]) => value === language)?.[1] ?? (language || 'Plain text')
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return CODE_LANGUAGES.filter(([value, name]) => !needle
      || value.includes(needle)
      || name.toLowerCase().includes(needle))
  }, [query])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!controlRef.current?.contains(event.target as Node)
        && !popoverRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const trigger = triggerRef.current
      const popover = popoverRef.current
      if (!trigger || !popover) return
      const anchor = trigger.getBoundingClientRect()
      const gutter = 8
      const gap = 5
      const width = popover.offsetWidth || 208
      const wantedHeight = popover.scrollHeight
      const below = window.innerHeight - anchor.bottom - gutter
      const above = anchor.top - gutter
      const side = below < Math.min(wantedHeight, 240) && above > below ? 'top' : 'bottom'
      const available = Math.max(96, (side === 'top' ? above : below) - gap)
      const height = Math.min(wantedHeight, available)
      const left = Math.min(
        Math.max(gutter, anchor.right - width),
        Math.max(gutter, window.innerWidth - width - gutter),
      )
      setPosition({
        left,
        top: side === 'top' ? anchor.top - gap - height : anchor.bottom + gap,
        maxHeight: available,
        side,
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, options.length])

  const apply = (next: string) => {
    updateAttributes({ language: canonicalLanguage(next) || null })
    setOpen(false)
    requestAnimationFrame(() => { if (!editor.isDestroyed) editor.commands.focus() })
  }

  return (
    <NodeViewWrapper
      className="rich-code-block"
      onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.button !== 0
          || controlRef.current?.contains(event.target as Node)
          || (event.target instanceof Element && event.target.closest('.rich-code-block-content'))) return
        const position = getPos()
        if (typeof position !== 'number') return
        event.preventDefault()
        editor.chain().focus().setTextSelection(position + 1 + node.content.size).run()
      }}
    >
      {/* Keep document content before non-document controls so drag selection
          through code cannot collect the language label as source text. */}
      <NodeViewContent className="rich-code-block-content" />
      <div ref={controlRef} className="rich-code-language" contentEditable={false}>
        <button
          ref={triggerRef}
          type="button"
          className="rich-code-language-trigger"
          aria-label={`Code block language: ${label}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setQuery(language)
            setOpen((value) => !value)
          }}
        >
          <span>{label}</span>
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </button>
        {open && createPortal(
          <form
            ref={popoverRef}
            className="rich-code-language-popover"
            data-side={position?.side}
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              maxHeight: position?.maxHeight,
              visibility: position ? 'visible' : 'hidden',
            } satisfies CSSProperties}
            onSubmit={(event) => {
              event.preventDefault()
              apply(query)
            }}
          >
            <input
              autoFocus
              value={query}
              role="combobox"
              aria-label="Code block language"
              aria-expanded="true"
              aria-controls={optionsId}
              placeholder="Language or plain text"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setOpen(false)
                  requestAnimationFrame(() => { if (!editor.isDestroyed) editor.commands.focus() })
                }
              }}
            />
            <div id={optionsId} role="listbox" aria-label="Languages">
              {options.map(([value, name]) => (
                <button
                  key={value}
                  type="button"
                  role="option"
                  aria-selected={value === language}
                  onClick={() => apply(value)}
                >
                  <span>{name}</span>
                  {value === language && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                </button>
              ))}
            </div>
            {query.trim() && !CODE_LANGUAGES.some(([value]) => value === query.trim()) && (
              <button type="submit" className="rich-code-language-custom">
                Use "{query.trim()}"
              </button>
            )}
          </form>,
          document.body,
        )}
      </div>
    </NodeViewWrapper>
  )
}
