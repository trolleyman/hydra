// Browse-and-search grid over the whole lucide icon set, for the project icon
// setting. Mounted only while the picker is open, so the ~1750-icon chunk (see
// lucideIcons.ts) is fetched on first open and never for someone who just types
// a name or pastes an emoji.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { loadLucideIcons, looksLikeIconName, normalizeIconName, type LucideIconEntry } from '../../lib/lucideIcons'

// Rendering all ~1750 icons at once is thousands of SVG nodes and visibly janks
// the settings pane, so an unfiltered (or broad) query shows the first slice and
// says how many more there are.
const MAX_SHOWN = 240

export function IconPicker({ value, onPick }: { value: string; onPick: (name: string) => void }) {
  const [icons, setIcons] = useState<LucideIconEntry[] | null>(null)
  // Open on what is already in the field, so a name that did not resolve lands
  // on the near misses ("FolderDot" -> the folder icons) instead of icon zero.
  const [query, setQuery] = useState(() => (looksLikeIconName(value) ? value : ''))
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    void loadLucideIcons().then((set) => {
      if (live) setIcons(set.list)
    })
    searchRef.current?.focus()
    return () => {
      live = false
    }
  }, [])

  const selected = normalizeIconName(value)
  const matches = useMemo(() => {
    if (!icons) return []
    const q = normalizeIconName(query)
    if (!q) return icons
    // Names that start with the query first - typing "folder" should lead with
    // the folder icons, not with "download-folder"-ish incidental matches.
    const starts: LucideIconEntry[] = []
    const contains: LucideIconEntry[] = []
    for (const entry of icons) {
      const n = normalizeIconName(entry.name)
      if (n.startsWith(q)) starts.push(entry)
      else if (n.includes(q)) contains.push(entry)
    }
    return starts.concat(contains)
  }, [icons, query])

  const shown = matches.slice(0, MAX_SHOWN)

  return (
    <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <Search className="w-4 h-4 shrink-0 text-gray-400 dark:text-gray-500" />
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search icons"
          className="flex-1 min-w-0 text-sm bg-transparent text-gray-800 dark:text-gray-100 placeholder-gray-300 dark:placeholder-gray-500 focus:outline-none"
        />
        {icons && (
          <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500 tabular-nums">
            {matches.length > shown.length ? `${shown.length} of ${matches.length}` : `${matches.length}`}
          </span>
        )}
      </div>

      {!icons ? (
        <p className="px-3 py-6 text-xs text-center text-gray-400 dark:text-gray-500">Loading icons...</p>
      ) : shown.length === 0 ? (
        <p className="px-3 py-6 text-xs text-center text-gray-400 dark:text-gray-500">No icon matches "{query}"</p>
      ) : (
        <div className="max-h-56 overflow-y-auto p-2 grid grid-cols-[repeat(auto-fill,minmax(2rem,1fr))] gap-1">
          {shown.map(({ name, icon: Icon }) => {
            const isSelected = normalizeIconName(name) === selected
            return (
              // A grid of 240 buttons is exactly the long-list case where a
              // portal-mounting Tooltip per row is a real cost (see CLAUDE.md) -
              // the icon name rides a native title instead.
              <button
                key={name}
                type="button"
                title={name}
                aria-label={name}
                onClick={() => onPick(name)}
                className={`h-8 flex items-center justify-center rounded-md border transition-colors cursor-pointer ${
                  isSelected
                    ? 'border-blue-400 dark:border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300'
                    : 'border-transparent text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700/50'
                }`}
              >
                <Icon size={18} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
