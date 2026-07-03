import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, RotateCcw, Search, X } from 'lucide-react'
import {
  type FilterableArtifact, parseScopedTag, collectTags, computeScopeCounts,
  fileMediaType, effectiveChangeType, TYPE_CATEGORY, CHANGE_TYPE_ORDER,
} from '../lib/artifactFilter'
import {
  defaultTagFilter, isDefaultTagFilter, clampChangeThreshold, ARTIFACT_CHANGE_CATEGORY as CHANGE_CATEGORY,
  DEFAULT_HIDDEN_CHANGE_TYPES,
  type ArtifactTagFilter,
} from '../lib/artifactPrefs'

// The artifact filter bar - a search box plus one dropdown per tag scope - shared by
// the diff viewer's ArtifactsPanel and the repository browser's
// RepositoryArtifactsView so both filter the same way. The pure filtering/search
// rules live in lib/artifactFilter; this file owns the UI.

// TagBadge renders one of a file's tags: a scoped label as a two-tone
// category/value pill, a free-form tag as a single solid pill.
export function TagBadge({ tag }: { tag: string }) {
  const scoped = parseScopedTag(tag)
  if (scoped) {
    return (
      <span className="inline-flex items-center text-[10px] rounded overflow-hidden border border-gray-200 dark:border-gray-600">
        <span className="px-1 py-0.5 bg-gray-100 dark:bg-gray-700/70 text-gray-500 dark:text-gray-400">{scoped.cat}</span>
        <span className="px-1 py-0.5 bg-gray-200/70 dark:bg-gray-600/60 text-gray-700 dark:text-gray-200 font-medium">{scoped.val}</span>
      </span>
    )
  }
  return <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300">{tag}</span>
}

// Stable empty default so `defaultOff`'s fallback isn't a fresh array each render.
const EMPTY_OFF: string[] = []

// TagScopeFilter renders one filter button for a single tag scope, so each scope
// gets its own trigger on the bar instead of one combined menu. The button's label
// is the category name (or "tags" for the free-form group); the dropdown lists a
// checkbox per value, every one ON by default. The `off` prop is the set of values
// the user has turned off (a file is hidden if it carries one). A fixed header row
// carries "all" (top-left, re-check everything) and "clear" (top-right, uncheck
// everything) so the menu's height never changes as you select. Shift-clicking a
// value isolates it (clears the others). The count badge shows how many values
// differ from the scope's default (see `defaultOff`), so a scope at its default -
// e.g. "changes" hiding only 'unchanged' - shows no badge; selection is shared
// across every card via the parent's filter state.
export function TagScopeFilter({
  label,
  values,
  off,
  counts,
  onToggle,
  onIsolate,
  onAll,
  onClear,
  footer,
  highlight = false,
  defaultOff = EMPTY_OFF,
}: {
  label: string
  values: string[]
  off: string[]
  // The values this scope hides at its default (e.g. the "changes" scope hides
  // 'unchanged'). The badge counts checkboxes whose on/off differs from this, so a
  // scope sitting at its default shows no badge. Defaults to "nothing hidden".
  defaultOff?: string[]
  // Per-value item counts (see computeScopeCounts); right-aligned and dimmed in
  // each row. Optional so a caller can omit them.
  counts?: Record<string, number>
  onToggle: (val: string) => void
  onIsolate: (val: string) => void
  onAll: () => void
  onClear: () => void
  // Extra controls rendered at the bottom of the dropdown, below the value list -
  // used by the "changes" scope for its "% changed" threshold slider.
  footer?: ReactNode
  // Force the trigger into its active (highlighted) style even when nothing is
  // hidden - e.g. the change threshold is set but no value checkbox is off.
  highlight?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // The dropdown is portal'd to <body> and positioned with fixed coords: the filter
  // bar it lives on is `sticky z-20`, which traps an in-flow absolute panel inside
  // that stacking context so the diff viewer's `sticky z-20` file headers paint over
  // it. Escaping to the body (like the regen menu in ArtifactsPanel) lets it sit
  // above everything. Coords are measured from the trigger below.
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null)
  const PANEL_WIDTH = 224 // w-56

  // Position the panel under the trigger, right-aligned to it and clamped into the
  // viewport; keep it pinned while scrolling/resizing.
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const el = ref.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const padding = 8
      const left = Math.max(padding, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - padding))
      setCoords({ left, top: rect.bottom + 6 })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open])

  // Close on an outside click or Escape, like the diff viewer's settings popup. The
  // panel lives in a portal, so a click inside it isn't inside `ref` - check both.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  // Count only currently-offered values that are off (stale entries for values no
  // longer present don't count), so "all on" / "all off" stay accurate.
  const hiddenCount = values.filter((v) => off.includes(v)).length
  const allOn = hiddenCount === 0
  const allOff = hiddenCount === values.length && values.length > 0
  // The badge counts values whose on/off differs from the scope's default, so a
  // scope at its default reads as "no active filter" (e.g. "changes" hiding only
  // 'unchanged' shows 0). For scopes that default to all-on this equals hiddenCount.
  const changedCount = values.filter((v) => off.includes(v) !== defaultOff.includes(v)).length
  // select-none: shift-click isolates a value, but the browser's shift-click
  // range-selects text (which starts on mousedown, so the onClick preventDefault
  // can't stop it) - making the row unselectable avoids the stray highlight.
  const rowClass = 'flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[11px] font-medium transition-colors cursor-pointer ${
          open || changedCount > 0 || highlight
            ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
            : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
        }`}
      >
        <span className="lowercase">{label}</span>
        {changedCount > 0 && (
          <span className="inline-flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-full bg-blue-500 text-white text-[10px] font-semibold leading-none">{changedCount}</span>
        )}
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && coords && createPortal(
        <div
          ref={panelRef}
          className="fixed w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-[9999] overflow-hidden text-left"
          style={{ left: coords.left, top: coords.top }}
        >
          {/* Fixed header: "all" left, "clear" right. Always present (regardless
              of selection) so toggling values never grows/shrinks the menu. */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-100 dark:border-gray-700/60 text-[11px] font-medium">
            <button
              onClick={onAll}
              className={`cursor-pointer ${allOn ? 'text-blue-600 dark:text-blue-300' : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'}`}
            >all</button>
            <button
              onClick={onClear}
              className={`cursor-pointer ${allOff ? 'text-blue-600 dark:text-blue-300' : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'}`}
            >clear</button>
          </div>
          <div className="max-h-72 overflow-auto py-1">
            {values.map((v) => (
              // Drive selection from onClick (not the input's onChange) so we can
              // read shiftKey: shift-click isolates this value, a plain click
              // toggles it. preventDefault stops the label's own checkbox toggle.
              <label
                key={v}
                className={rowClass}
                onClick={(e) => { e.preventDefault(); if (e.shiftKey) onIsolate(v); else onToggle(v) }}
              >
                <input type="checkbox" readOnly checked={!off.includes(v)} className="w-3.5 h-3.5 accent-blue-500 cursor-pointer shrink-0" />
                <span className="text-gray-700 dark:text-gray-300 truncate min-w-0">{v}</span>
                {counts?.[v] != null && (
                  // How many items carry this value under the current filters,
                  // ignoring this scope itself.
                  <span className="ml-auto shrink-0 tabular-nums text-[10px] text-gray-400 dark:text-gray-500">{counts[v]}</span>
                )}
              </label>
            ))}
          </div>
          <div className="px-3 py-1 border-t border-gray-100 dark:border-gray-700/60 text-[10px] text-gray-400 dark:text-gray-500">shift-click to isolate</div>
          {footer}
        </div>,
        document.body,
      )}
    </div>
  )
}

// ChangeThresholdControl is the "% changed" gate shown at the bottom of the
// "changes" filter dropdown. A modified file whose change_ratio is below this
// percentage is treated as identical (see effectiveChangeType): the slider says how
// much of an image's pixels - or a video's frames - must differ before the change
// "counts". 0 means any difference counts (the default).
function ChangeThresholdControl({ value, onChange }: { value: number; onChange: (pct: number) => void }) {
  return (
    // stopPropagation so dragging the slider near the menu edge never closes it.
    <div className="px-3 py-2 border-t border-gray-100 dark:border-gray-700/60" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-medium text-gray-600 dark:text-gray-300">% changed threshold</span>
        <span className="text-[11px] tabular-nums text-gray-500 dark:text-gray-400">{value}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={(e) => onChange(clampChangeThreshold(e.target.valueAsNumber))}
        className="w-full accent-blue-500 cursor-pointer"
      />
      <div className="mt-1 text-[10px] leading-snug text-gray-400 dark:text-gray-500">
        A modified file counts as identical until at least this share of its pixels (or video frames) differ.
      </div>
    </div>
  )
}

// ArtifactFilterBar is the whole filter group - search box, reset button, a dropdown
// per user-defined tag scope, the free-form "tags" group, and the built-in "type"
// (image/video) and "changes" (added/removed/modified/unchanged) scopes. It derives
// every offered value from `files` (plus `pendingTags`, the tags a side exposes
// before the set finishes) and computes the per-value counts itself, so a caller
// only has to own the `filter`/`search` state and apply computeVisibleFiles. Returns
// null when there's nothing to filter (no tags, no media, no change filter).
export function ArtifactFilterBar({
  files,
  pendingTags,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  showChangeFilter = false,
  className,
}: {
  files: FilterableArtifact[]
  // Extra tags surfaced before all files exist (the diff panel's pending_tags).
  pendingTags?: string[]
  filter: ArtifactTagFilter
  onFilterChange: (f: ArtifactTagFilter) => void
  search: string
  onSearchChange: (s: string) => void
  // Offer the built-in change-type ("changes") scope. The diff viewer shows it
  // (files have a before/after change_type); the single-ref repository view doesn't.
  showChangeFilter?: boolean
  className?: string
}) {
  // Every tag offered by any file, partitioned into scoped categories and free-form
  // tags. Drives the per-scope dropdowns.
  const collectedTags = useMemo(() => collectTags(files, pendingTags), [files, pendingTags])
  const hasTags = collectedTags.scoped.length > 0 || collectedTags.free.length > 0

  // The built-in "type" filter (image / video), derived from the files' own
  // extensions rather than their tags. Values are the media types actually present.
  const fileTypes = useMemo(() => {
    const types = new Set<string>()
    for (const f of files) types.add(fileMediaType(f))
    return [...types].sort()
  }, [files])
  const showTypeFilter = fileTypes.length > 0
  // Values turned off (hidden), mirroring the user scopes' inverted model.
  const typeOff = filter.scoped[TYPE_CATEGORY] ?? []

  // The built-in "changes" filter (added / removed / modified / unchanged), derived
  // from each file's change_type. Always lists all four change types (even ones no
  // file currently has) so added/removed are a constant, predictable option - their
  // per-value counts read 0 when absent. Unchanged is hidden by default (seeded in
  // loadTagFilter).
  const changeTypes = CHANGE_TYPE_ORDER
  const changeOff = filter.scoped[CHANGE_CATEGORY] ?? []
  // The active "% changed" gate (see ChangeThresholdControl / effectiveChangeType).
  const changeThreshold = clampChangeThreshold(filter.changeThreshold)

  // Per-value item counts for each dropdown (see computeScopeCounts). `shownFilter`
  // is the current filter with this scope cleared, so each value's count reflects
  // the other active filters but not its own toggle.
  const scopeCounts = useCallback(
    (cat: string, values: string[]): Record<string, number> => {
      const threshold = clampChangeThreshold(filter.changeThreshold)
      const hasValue = (f: FilterableArtifact, v: string) =>
        cat === TYPE_CATEGORY ? fileMediaType(f) === v
          : cat === CHANGE_CATEGORY ? effectiveChangeType(f, threshold) === v
            : (f.tags ?? []).includes(`${cat}::${v}`)
      const shownFilter: ArtifactTagFilter = { ...filter, scoped: { ...filter.scoped, [cat]: [] } }
      return computeScopeCounts(files, values, hasValue, shownFilter)
    },
    [files, filter],
  )
  const freeCounts = useCallback(
    (values: string[]): Record<string, number> => {
      const hasValue = (f: FilterableArtifact, v: string) => (f.tags ?? []).includes(v)
      const shownFilter: ArtifactTagFilter = { ...filter, free: [] }
      return computeScopeCounts(files, values, hasValue, shownFilter)
    },
    [files, filter],
  )

  // Nothing to offer - no tags, no media for the type filter, and the change filter
  // is off. Render nothing so the caller's header doesn't carry an empty bar.
  if (!hasTags && !showTypeFilter && !showChangeFilter) return null

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}>
      {/* Search box, leftmost: a split-word fuzzy match + rank over each file's name
          and tags (see searchScore). Narrows the grid live and reorders the best
          matches first; non-matching cards drop out entirely. */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400 dark:text-gray-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="search"
          aria-label="Search artifacts by name or tag"
          className="h-7 w-36 pl-7 pr-6 rounded-md border text-[11px] bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-600 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
        {search && (
          <button
            onClick={() => onSearchChange('')}
            title="Clear search"
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 cursor-pointer"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      {/* Reset to defaults - shown only when the filter has moved off its default
          (any tag/value hidden, or the changes filter no longer hides only
          'unchanged'). Restores every scope to "show all" + the change default. */}
      {!isDefaultTagFilter(filter) && (
        <button
          onClick={() => onFilterChange(defaultTagFilter())}
          title="Reset filters"
          className="flex items-center gap-1 h-7 px-2.5 rounded-md border text-[11px] font-medium cursor-pointer transition-colors bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600"
        >
          <RotateCcw className="w-3 h-3" />
          <span className="lowercase">reset</span>
        </button>
      )}
      {collectedTags.scoped.map(({ cat, values }) => (
        <TagScopeFilter
          key={cat}
          label={cat}
          values={values}
          off={filter.scoped[cat] ?? []}
          counts={scopeCounts(cat, values)}
          onToggle={(val) => {
            const cur = filter.scoped[cat] ?? []
            const next = cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val]
            onFilterChange({ ...filter, scoped: { ...filter.scoped, [cat]: next } })
          }}
          onIsolate={(val) => onFilterChange({ ...filter, scoped: { ...filter.scoped, [cat]: values.filter((x) => x !== val) } })}
          onAll={() => onFilterChange({ ...filter, scoped: { ...filter.scoped, [cat]: [] } })}
          onClear={() => onFilterChange({ ...filter, scoped: { ...filter.scoped, [cat]: [...values] } })}
        />
      ))}
      {collectedTags.free.length > 0 && (
        <TagScopeFilter
          label="tags"
          values={collectedTags.free}
          off={filter.free}
          counts={freeCounts(collectedTags.free)}
          onToggle={(t) =>
            onFilterChange({ ...filter, free: filter.free.includes(t) ? filter.free.filter((x) => x !== t) : [...filter.free, t] })
          }
          onIsolate={(t) => onFilterChange({ ...filter, free: collectedTags.free.filter((x) => x !== t) })}
          onAll={() => onFilterChange({ ...filter, free: [] })}
          onClear={() => onFilterChange({ ...filter, free: [...collectedTags.free] })}
        />
      )}
      {/* Built-in type scope - image vs video, derived from the file extensions
          rather than a tag. */}
      {showTypeFilter && (
        <TagScopeFilter
          label={TYPE_CATEGORY}
          values={fileTypes}
          off={typeOff}
          counts={scopeCounts(TYPE_CATEGORY, fileTypes)}
          onToggle={(val) => {
            const next = typeOff.includes(val) ? typeOff.filter((x) => x !== val) : [...typeOff, val]
            onFilterChange({ ...filter, scoped: { ...filter.scoped, [TYPE_CATEGORY]: next } })
          }}
          onIsolate={(val) => onFilterChange({ ...filter, scoped: { ...filter.scoped, [TYPE_CATEGORY]: fileTypes.filter((x) => x !== val) } })}
          onAll={() => onFilterChange({ ...filter, scoped: { ...filter.scoped, [TYPE_CATEGORY]: [] } })}
          onClear={() => onFilterChange({ ...filter, scoped: { ...filter.scoped, [TYPE_CATEGORY]: [...fileTypes] } })}
        />
      )}
      {/* Built-in change-type scope, last (rightmost) - added/removed/modified/
          unchanged, with unchanged hidden by default. Only the diff viewer offers
          it; a single ref has no diff. */}
      {showChangeFilter && (
        <TagScopeFilter
          label="changes"
          values={changeTypes}
          off={changeOff}
          defaultOff={DEFAULT_HIDDEN_CHANGE_TYPES}
          counts={scopeCounts(CHANGE_CATEGORY, changeTypes)}
          onToggle={(val) => {
            const next = changeOff.includes(val) ? changeOff.filter((x) => x !== val) : [...changeOff, val]
            onFilterChange({ ...filter, scoped: { ...filter.scoped, [CHANGE_CATEGORY]: next } })
          }}
          onIsolate={(val) => onFilterChange({ ...filter, scoped: { ...filter.scoped, [CHANGE_CATEGORY]: changeTypes.filter((x) => x !== val) } })}
          onAll={() => onFilterChange({ ...filter, scoped: { ...filter.scoped, [CHANGE_CATEGORY]: [] } })}
          onClear={() => onFilterChange({ ...filter, scoped: { ...filter.scoped, [CHANGE_CATEGORY]: [...changeTypes] } })}
          highlight={changeThreshold > 0}
          footer={
            <ChangeThresholdControl
              value={changeThreshold}
              onChange={(pct) => onFilterChange({ ...filter, changeThreshold: pct })}
            />
          }
        />
      )}
    </div>
  )
}
