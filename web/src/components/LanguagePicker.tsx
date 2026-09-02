import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Search } from 'lucide-react'
import { languageDisplayName, searchLanguages } from '../lib/languageCatalog'

export function LanguagePicker({ detected, selected, onSelect }: {
  detected: string
  selected: string | null
  onSelect: (language: string | null) => void
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const language = selected ?? detected
  const results = useMemo(() => searchLanguages(query), [query])

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const width = Math.min(320, window.innerWidth - 16)
    setPosition({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    })
    inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    const closeOnScroll = () => setOpen(false)
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', closeOnScroll)
    window.addEventListener('scroll', closeOnScroll, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', closeOnScroll)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [open])

  const choose = (next: string | null) => {
    onSelect(next)
    setOpen(false)
    setQuery('')
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Syntax highlighting: ${languageDisplayName(language)}`}
        aria-expanded={open}
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value) }}
        className="shrink-0 rounded px-1.5 py-1 text-[11px] text-gray-400 dark:text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer transition-colors duration-100"
      >
        {languageDisplayName(language)}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Select syntax highlighting language"
          className="fixed z-[100] w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl"
          style={position}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="border-b border-gray-100 dark:border-gray-700 p-2">
            <div className="flex items-center gap-2 rounded-lg bg-gray-100 dark:bg-gray-900 px-2.5 py-2 focus-within:ring-2 focus-within:ring-blue-500/40">
              <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search languages, aliases, extensions"
                className="min-w-0 flex-1 bg-transparent text-xs text-gray-800 dark:text-gray-100 placeholder:text-gray-400 outline-none"
              />
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            <button
              type="button"
              onClick={() => choose(null)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer transition-colors duration-100"
            >
              <span className="min-w-0 flex-1 text-xs font-medium text-gray-700 dark:text-gray-200">
                {languageDisplayName(detected)}
              </span>
              {selected == null && <Check className="h-3.5 w-3.5 text-blue-500" />}
            </button>
            {results.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => choose(option.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer transition-colors duration-100"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-gray-700 dark:text-gray-200">{option.label}</span>
                  <span className="block truncate text-[10px] text-gray-400">
                    {option.id}{option.extensions.length ? ` - ${option.extensions.map((ext) => `.${ext}`).join(', ')}` : ''}
                  </span>
                </span>
                {selected === option.id && <Check className="h-3.5 w-3.5 text-blue-500" />}
              </button>
            ))}
            {results.length === 0 && <div className="px-3 py-8 text-center text-xs text-gray-400">No languages found</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
