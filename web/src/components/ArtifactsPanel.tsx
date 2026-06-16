import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { api } from '../stores/apiClient'
import type { ArtifactSet, ArtifactFile, ArtifactLogLine } from '../api'
import { LoaderCircle, Image as ImageIcon, ImageOff, ChevronDown, ChevronRight, TriangleAlert, RefreshCw, Maximize2 } from 'lucide-react'
import { InfoTooltip } from './InfoTooltip'
import { loadArtifactPrefs, saveArtifactPrefs, loadTagFilter, saveTagFilter, type ArtifactTagFilter } from '../lib/artifactPrefs'
import { stripAnsi } from '../lib/ansi'

const CHANGE_LABEL: Record<string, string> = {
  added: 'added',
  removed: 'removed',
  modified: 'modified',
  unchanged: 'unchanged',
}

const CHANGE_COLOR: Record<string, string> = {
  added: 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20',
  removed: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20',
  modified: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20',
  unchanged: 'text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-800',
}

// A subtle checkerboard so transparent screenshots read clearly in both themes.
const checkerStyle: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, rgba(0,0,0,0.06) 25%, transparent 25%), linear-gradient(-45deg, rgba(0,0,0,0.06) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(0,0,0,0.06) 75%), linear-gradient(-45deg, transparent 75%, rgba(0,0,0,0.06) 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
}

// The four ways to compare a before/after image pair. Persisted in the diff
// viewer's settings; see DiffViewer's SettingsPopup.
export type ImageDiffMode = 'side-by-side' | 'ab' | 'slider' | 'onion'

export const IMAGE_DIFF_MODES: { value: ImageDiffMode; label: string }[] = [
  { value: 'side-by-side', label: 'Side by side' },
  { value: 'ab', label: 'Before/After' },
  { value: 'slider', label: 'Before/after slider' },
  { value: 'onion', label: 'Onion skin' },
]

const IMG_CLASS = 'max-w-full max-h-[480px] rounded-md border border-gray-200 dark:border-gray-700 object-contain'
// Shared by the overlay modes: the base image sizes the box, the overlay is
// stretched to fill that same box so the two align pixel-for-pixel.
const OVERLAY_CLASS = 'absolute inset-0 w-full h-full object-contain rounded-md border border-gray-200 dark:border-gray-700'
const TAG_CLASS = 'absolute top-1 z-10 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-black/55 text-white pointer-events-none'

// Open an image in a new tab. In side-by-side mode the image is a target=_blank
// link, so left-click already does this; the overlay modes bind left-click/drag
// to comparison gestures, so they route the new-tab affordance to the middle
// mouse button (matching a browser's middle-click-to-open-in-new-tab on links).
function openInNewTab(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

// makeAuxOpen builds an onAuxClick handler that opens `pick()` in a new tab on a
// middle click. `pick` is a function so the chosen image can depend on state
// (e.g. which side is currently shown) or the cursor position at click time.
function makeAuxOpen(pick: (e: React.MouseEvent) => string) {
  return (e: React.MouseEvent) => {
    if (e.button !== 1) return
    e.preventDefault()
    openInNewTab(pick(e))
  }
}

// Default/bounds for the draggable image height (see useImageResize). The base
// matches IMG_CLASS's max-h-[480px] so a card opens at the same size as before.
const DEFAULT_IMG_MAX_H = 480
const MIN_IMG_MAX_H = 160
const MAX_IMG_MAX_H = 1600

// Shared drag-to-resize for a before/after pair: dragging the grip on EITHER
// image adjusts a single max-height that's applied to BOTH sides, so they always
// grow by the same amount even though only one was dragged. The pointermove
// listener lives on the window so the drag keeps tracking outside the grip.
function useImageResize() {
  const [maxHeight, setMaxHeight] = useState(DEFAULT_IMG_MAX_H)
  // Hold the latest value so a drag can read its start height without re-creating
  // the (stable) onResizeStart callback on every resize tick.
  const current = useRef(maxHeight)
  current.current = maxHeight
  const onResizeStart = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    // Suppress the click/drag from selecting text or following the image's <a> link.
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startH = current.current
    const onMove = (ev: PointerEvent) => {
      const next = startH + (ev.clientY - startY)
      setMaxHeight(Math.max(MIN_IMG_MAX_H, Math.min(MAX_IMG_MAX_H, next)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])
  return { maxHeight, onResizeStart }
}

// A corner grip (revealed on hover) that the user drags down/up to resize the
// image. Sits as a sibling of the <a>, so a normal click on the image still
// opens it in a new tab; only the grip starts a resize.
function ResizeGrip({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      title="Drag to resize both images"
      className="absolute bottom-1 right-1 z-10 flex items-center justify-center w-5 h-5 rounded bg-black/45 text-white/90 opacity-0 group-hover:opacity-100 transition-opacity cursor-nwse-resize touch-none select-none"
    >
      <Maximize2 className="w-3 h-3" />
    </div>
  )
}

function ImageCell({ url, label, maxHeight, onResizeStart }: { url?: string | null; label: string; maxHeight: number; onResizeStart: (e: React.PointerEvent) => void }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">{label}</div>
      {url ? (
        <div className="group relative inline-block">
          <a href={url} target="_blank" rel="noreferrer" className="block">
            <img
              src={url}
              loading="lazy"
              style={{ ...checkerStyle, maxHeight: `${maxHeight}px` }}
              className={IMG_CLASS}
            />
          </a>
          <ResizeGrip onPointerDown={onResizeStart} />
        </div>
      ) : (
        // No image on this side (the file was added or removed). Render a panel of
        // similar visual weight to the present image — same framing, a clear "No
        // image" empty state — rather than a tiny dashed box, so the added/removed
        // (none↔image) layout doesn't look lopsided next to its counterpart.
        // select-none so rapid clicking near it never highlights the label text.
        <div className="select-none flex flex-col items-center justify-center gap-1 w-44 h-32 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-gray-400 dark:text-gray-500">
          <ImageOff className="w-5 h-5" />
          <span className="text-[11px] font-medium">No image</span>
        </div>
      )}
    </div>
  )
}

// A stacked layer for the overlay comparison modes: the image when present, or a
// "No image" placeholder filling the same box when this side is absent (an
// added/removed file). Keeping a placeholder layer — rather than dropping to a
// side-by-side pair — lets the overlay modes preserve their own layout (the A/B
// buttons, the slider handle, the opacity blend) when only one side exists.
function LayerNode({ url, style }: { url?: string | null; style?: React.CSSProperties }) {
  if (url) {
    return <img src={url} style={{ ...checkerStyle, ...style }} className={OVERLAY_CLASS} draggable={false} />
  }
  return (
    <div style={style} className={`${OVERLAY_CLASS} select-none flex flex-col items-center justify-center gap-1 bg-gray-50 dark:bg-gray-800/50 text-gray-400 dark:text-gray-500`}>
      <ImageOff className="w-5 h-5" />
      <span className="text-[11px] font-medium">No image</span>
    </div>
  )
}

// A/B switch: both sides stay mounted and stacked; clicking (or the Before/After
// buttons) flips which one is shown for an instant, flicker-free hard switch. A
// missing side shows the "No image" placeholder in its slot. Middle-click opens
// the currently-shown image in a new tab.
function ABSwitch({ left, right }: { left?: string | null; right?: string | null }) {
  const [showAfter, setShowAfter] = useState(true)
  // At least one side is present (ImageDiffView only routes here otherwise); the
  // present image is the invisible sizer that gives the stacked box its size.
  const sizer = (right ?? left) as string
  const btn = (active: boolean) =>
    `text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
      active ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
    }`
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 mb-1">
        <button onClick={() => setShowAfter(false)} className={btn(!showAfter)}>Before</button>
        <button onClick={() => setShowAfter(true)} className={btn(showAfter)}>After</button>
      </div>
      <div
        // select-none: flipping the A/B view is a rapid click target, so without
        // this a quick double-click would highlight the "No image" placeholder text.
        className="relative inline-block cursor-pointer select-none"
        onClick={() => setShowAfter((s) => !s)}
        onAuxClick={makeAuxOpen(() => (showAfter ? right : left) || sizer)}
      >
        <img src={sizer} style={{ visibility: 'hidden' }} className={`${IMG_CLASS} block`} draggable={false} />
        <LayerNode url={right} style={{ visibility: showAfter ? 'visible' : 'hidden' }} />
        <LayerNode url={left} style={{ visibility: showAfter ? 'hidden' : 'visible' }} />
      </div>
    </div>
  )
}

// Before/after slider: "after" is the base layer; "before" sits on top, clipped to
// the region left of the draggable handle, giving a sharp (hard-cut) boundary. A
// missing side shows the "No image" placeholder in its slot. Middle-click opens
// whichever side is currently visible under the cursor.
function SliderCompare({ left, right }: { left?: string | null; right?: string | null }) {
  const [pos, setPos] = useState(50)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const sizer = (right ?? left) as string

  const update = useCallback((clientX: number) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width === 0) return
    setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)))
  }, [])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => update(e.clientX)
    const onUp = () => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, update])

  return (
    <div
      ref={ref}
      className="relative inline-block select-none touch-none cursor-ew-resize"
      onPointerDown={(e) => {
        if (e.button !== 0) return // leave middle/right for the new-tab handler
        setDragging(true)
        update(e.clientX)
      }}
      onAuxClick={makeAuxOpen((e) => {
        const el = ref.current
        if (!el) return sizer
        const r = el.getBoundingClientRect()
        const x = ((e.clientX - r.left) / r.width) * 100
        return (x < pos ? left : right) || sizer
      })}
    >
      <span className={`${TAG_CLASS} left-1`}>Before</span>
      <span className={`${TAG_CLASS} right-1`}>After</span>
      <img src={sizer} style={{ visibility: 'hidden' }} className={`${IMG_CLASS} block`} draggable={false} />
      <LayerNode url={right} />
      <LayerNode url={left} style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
      <div className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)] pointer-events-none" style={{ left: `${pos}%` }}>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white shadow ring-1 ring-black/30" />
      </div>
    </div>
  )
}

// Onion skin: "before" is the base layer with "after" blended over it; the range
// slider controls the opacity of the "after" image (0 = before, 1 = after). A
// missing side shows the "No image" placeholder in its slot. Middle-click opens
// the side currently weighted by the blend.
function OnionCompare({ left, right }: { left?: string | null; right?: string | null }) {
  const [opacity, setOpacity] = useState(50)
  const sizer = (right ?? left) as string
  return (
    <div className="min-w-0">
      <div
        className="relative inline-block"
        onAuxClick={makeAuxOpen(() => (opacity >= 50 ? right : left) || sizer)}
      >
        <img src={sizer} style={{ visibility: 'hidden' }} className={`${IMG_CLASS} block`} draggable={false} />
        <LayerNode url={left} />
        <LayerNode url={right} style={{ opacity: opacity / 100 }} />
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Before</span>
        <input
          type="range" min={0} max={100} value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          className="flex-1 accent-blue-500 cursor-pointer"
        />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">After</span>
      </div>
    </div>
  )
}

// The default side-by-side pair. Holds one shared resize state so dragging the
// grip on either image grows both before/after cells by the same amount.
function SideBySide({ left, right }: { left?: string | null; right?: string | null }) {
  const { maxHeight, onResizeStart } = useImageResize()
  return (
    <div className="flex gap-3">
      <ImageCell url={left} label="Before" maxHeight={maxHeight} onResizeStart={onResizeStart} />
      <ImageCell url={right} label="After" maxHeight={maxHeight} onResizeStart={onResizeStart} />
    </div>
  )
}

// Render a before/after image pair in the selected comparison mode. The overlay
// modes keep their own layout even when one side is missing (added/removed file),
// substituting a "No image" placeholder; we only fall back to the side-by-side
// pair for that mode itself, or the degenerate case of no images at all.
function ImageDiffView({ left, right, mode }: { left?: string | null; right?: string | null; mode: ImageDiffMode }) {
  if (mode === 'side-by-side' || (!left && !right)) {
    return <SideBySide left={left} right={right} />
  }
  if (mode === 'ab') return <ABSwitch left={left} right={right} />
  if (mode === 'slider') return <SliderCompare left={left} right={right} />
  return <OnionCompare left={left} right={right} />
}

// --- Tags & filtering ---
//
// A file's tags come from a sibling JSON sidecar (<file>.meta) the artifact
// script writes; the backend normalizes them (see internal/artifacts). A
// "category::value" tag is a GitLab-style scoped label — at most one value per
// category — which the filter renders as a single-select dropdown; a plain tag
// (no "::") is free-form, rendered as a toggle chip.

// parseScopedTag splits "category::value" into its parts, or returns null for a
// free-form tag. Mirrors the backend's split (first "::", non-empty halves).
function parseScopedTag(tag: string): { cat: string; val: string } | null {
  const i = tag.indexOf('::')
  if (i <= 0) return null
  const cat = tag.slice(0, i)
  const val = tag.slice(i + 2)
  if (!cat || !val) return null
  return { cat, val }
}

type CollectedTags = {
  scoped: { cat: string; values: string[] }[]
  free: string[]
}

// collectTags gathers every tag across all files into the scoped categories (with
// their distinct values) and free-form tags that the filter bar offers.
function collectTags(sets: ArtifactSet[]): CollectedTags {
  const scoped = new Map<string, Set<string>>()
  const free = new Set<string>()
  for (const s of sets) {
    for (const f of s.files) {
      for (const t of f.tags ?? []) {
        const p = parseScopedTag(t)
        if (p) {
          if (!scoped.has(p.cat)) scoped.set(p.cat, new Set())
          scoped.get(p.cat)!.add(p.val)
        } else {
          free.add(t)
        }
      }
    }
  }
  return {
    scoped: [...scoped.entries()]
      .map(([cat, vals]) => ({ cat, values: [...vals].sort() }))
      .sort((a, b) => a.cat.localeCompare(b.cat)),
    free: [...free].sort(),
  }
}

// filterIsActive reports whether the filter would hide anything (any scoped
// category pinned to a value, or any free tag selected).
function filterIsActive(filter: ArtifactTagFilter): boolean {
  return Object.values(filter.scoped).some(Boolean) || filter.free.length > 0
}

// fileMatchesFilter reports whether a file passes the active filter: it must
// carry the selected value for every pinned scoped category (files lacking that
// category are excluded), and must include every selected free tag.
function fileMatchesFilter(file: ArtifactFile, filter: ArtifactTagFilter): boolean {
  const tags = file.tags ?? []
  for (const [cat, val] of Object.entries(filter.scoped)) {
    if (val && !tags.includes(`${cat}::${val}`)) return false
  }
  for (const t of filter.free) {
    if (!tags.includes(t)) return false
  }
  return true
}

// TagBadge renders one of a file's tags: a scoped label as a two-tone
// category/value pill, a free-form tag as a single solid pill.
function TagBadge({ tag }: { tag: string }) {
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

// TagFilterBar is the inline filter shown on the Artifacts header: one
// single-select segmented control per scoped category (All + each value) and a
// toggle chip per free-form tag. The selection is shared across every card.
function TagFilterBar({ tags, filter, onChange }: { tags: CollectedTags; filter: ArtifactTagFilter; onChange: (f: ArtifactTagFilter) => void }) {
  const seg = (active: boolean) =>
    `px-1.5 py-0.5 text-[11px] cursor-pointer transition-colors ${
      active ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-700/60 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
    }`
  const setScoped = (cat: string, val: string) => onChange({ ...filter, scoped: { ...filter.scoped, [cat]: val } })
  const toggleFree = (t: string) =>
    onChange({ ...filter, free: filter.free.includes(t) ? filter.free.filter((x) => x !== t) : [...filter.free, t] })

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {tags.scoped.map(({ cat, values }) => (
        <div key={cat} className="flex items-center gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{cat}</span>
          <div className="flex rounded border border-gray-200 dark:border-gray-700 overflow-hidden divide-x divide-gray-200 dark:divide-gray-700">
            <button className={seg(!filter.scoped[cat])} onClick={() => setScoped(cat, '')}>All</button>
            {values.map((v) => (
              <button key={v} className={seg(filter.scoped[cat] === v)} onClick={() => setScoped(cat, v)}>{v}</button>
            ))}
          </div>
        </div>
      ))}
      {tags.free.map((t) => (
        <button
          key={t}
          onClick={() => toggleFree(t)}
          className={`text-[11px] px-1.5 py-0.5 rounded border cursor-pointer transition-colors ${
            filter.free.includes(t)
              ? 'bg-blue-500 border-blue-500 text-white'
              : 'border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-700/60 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
          }`}
        >
          {t}
        </button>
      ))}
      {filterIsActive(filter) && (
        <button
          onClick={() => onChange({ scoped: {}, free: [] })}
          className="text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer underline"
        >
          Clear
        </button>
      )}
    </div>
  )
}

function FileRow({ file, mode }: { file: ArtifactFile; mode: ImageDiffMode }) {
  const ct = file.change_type as string
  return (
    <div className="p-3 min-w-0 max-w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">{file.name}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${CHANGE_COLOR[ct] ?? ''}`}>{CHANGE_LABEL[ct] ?? ct}</span>
        {(file.tags ?? []).map((t) => <TagBadge key={t} tag={t} />)}
      </div>
      <ImageDiffView left={file.left_url} right={file.right_url} mode={mode} />
    </div>
  )
}

// Lay the per-file before/after blocks out as flex-wrap items so a tall, narrow
// artifact (e.g. a phone screenshot) only claims the width it needs and several
// can share a row, while a wide desktop screenshot wraps onto its own line. Each
// file's name + before + after stays a single, unbreakable block.
function FileGrid({ files, mode }: { files: ArtifactFile[]; mode: ImageDiffMode }) {
  return (
    <div className="flex flex-wrap gap-3 pt-1">
      {files.map((f) => <FileRow key={f.name} file={f} mode={mode} />)}
    </div>
  )
}

// formatElapsed renders a running duration compactly: "12s", or "1m 05s" once it
// passes a minute.
function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

// ElapsedTime shows how long an in-flight generation has been running, ticking
// once a second. startedAt is a Unix time in seconds (from the backend, so it
// survives reloads/reconnects).
function ElapsedTime({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return <>{formatElapsed(Math.max(0, Math.floor(now / 1000 - startedAt)))}</>
}

// LogView shows the live stdout+stderr log of a generating artifact: scrollable,
// monospaced, auto-following the tail unless the user scrolls up, with stderr
// lines in red.
function LogView({ log, emptyText = 'Waiting for output…' }: { log: ArtifactLogLine[]; emptyText?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Whether to keep pinned to the bottom; flips off only when the user scrolls up.
  const stick = useRef(true)
  // Last observed scrollTop, so onScroll can tell a user scroll-up (which should
  // unstick) from content growth pushing the gap open (which must not).
  const lastTop = useRef(0)

  // Re-pin to the tail whenever the content's height changes — a new line OR an
  // existing line wrapping/reflowing (e.g. when the vertical scrollbar appears and
  // narrows the box). Keying off height instead of log.length catches the reflow
  // cases that don't add a line, so streaming never drifts off the bottom.
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const ro = new ResizeObserver(() => {
      const el = ref.current
      if (el && stick.current) {
        el.scrollTop = el.scrollHeight
        lastTop.current = el.scrollTop
      }
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    // Re-stick once the user scrolls back to the bottom. Only an actual upward
    // scroll unsticks — content growth widens the gap without moving scrollTop, so
    // a queued scroll event seeing that gap must NOT unclamp, or a fast log (or a
    // single wrapped line) would unstick itself from the tail.
    if (atBottom) stick.current = true
    else if (el.scrollTop < lastTop.current - 1) stick.current = false
    lastTop.current = el.scrollTop
  }

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="h-64 max-h-64 overflow-auto rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 p-2 font-mono text-[11px] leading-relaxed"
    >
      <div ref={contentRef}>
        {log.length === 0 ? (
          <div className="text-gray-400 dark:text-gray-500">{emptyText}</div>
        ) : (
          log.map((l, i) => (
            <div
              key={i}
              className={`whitespace-pre-wrap break-words ${
                (l.stream as string) === 'stderr' ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-300'
              }`}
            >
              {stripAnsi(l.text)}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// LogColumnFrame is one side's labelled column wrapper, shared by the live and
// persisted log panes so both lay out identically.
function LogColumnFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">{label}</div>
      {children}
    </div>
  )
}

// NoLog is the placeholder for an absent side (the script was added/removed on
// the branch). Sized to match the log box so the side-by-side layout stays
// balanced when only one side has a log.
function NoLog() {
  return (
    <div className="my-2 flex items-center justify-center h-64 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 text-[11px] text-gray-400 dark:text-gray-500">
      No log
    </div>
  )
}

// LogColumn is one side's labelled log pane for the persisted (already-fetched)
// view. A null log means the side is absent, shown as the "No log" placeholder.
function LogColumn({ label, log }: { label: string; log: ArtifactLogLine[] | null }) {
  return (
    <LogColumnFrame label={label}>
      {log === null ? <NoLog /> : <LogView log={log} />}
    </LogColumnFrame>
  )
}

// LiveLogColumn renders one side's log while the set is still generating. Once a
// side settles, the backend clears its live `log` (it lives only in memory while
// in-flight) and exposes the persisted log at `logUrl` — but the OTHER side may
// still be building, so the set as a whole stays "generating". Rather than revert
// the finished side to "Waiting for output…", fetch its persisted log and keep
// showing the final output until the whole set settles.
function LiveLogColumn({ label, log, logUrl }: { label: string; log: ArtifactLogLine[]; logUrl?: string | null }) {
  // This side has finished if it has no live lines left but a persisted log URL.
  const settled = log.length === 0 && !!logUrl
  const [settledLog, setSettledLog] = useState<ArtifactLogLine[] | null>(null)

  useEffect(() => {
    if (!settled || !logUrl) {
      setSettledLog(null)
      return
    }
    let cancelled = false
    fetch(logUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { lines?: ArtifactLogLine[] } | null) => {
        if (!cancelled && j) setSettledLog(j.lines ?? [])
      })
      .catch(() => { /* ignore; fall back to the loading placeholder */ })
    return () => { cancelled = true }
  }, [settled, logUrl])

  return (
    <LogColumnFrame label={label}>
      {settled ? (
        <LogView log={settledLog ?? []} emptyText="Loading log…" />
      ) : (
        <LogView log={log} />
      )}
    </LogColumnFrame>
  )
}

// LogPanes shows two persisted (already-fetched) logs side by side, so the left
// and right generations read as separate streams instead of interleaving.
function LogPanes({ left, right }: { left: ArtifactLogLine[] | null; right: ArtifactLogLine[] | null }) {
  return (
    <div className="flex gap-2 my-2">
      <LogColumn label="Before" log={left} />
      <LogColumn label="After" log={right} />
    </div>
  )
}

// LiveLogPanes shows both in-flight builds side by side while the set generates,
// each side falling back to its persisted log once it finishes (see LiveLogColumn).
function LiveLogPanes({ set }: { set: ArtifactSet }) {
  return (
    <div className="flex gap-2 my-2">
      <LiveLogColumn label="Before" log={set.left_log ?? []} logUrl={set.left_log_url} />
      <LiveLogColumn label="After" log={set.right_log ?? []} logUrl={set.right_log_url} />
    </div>
  )
}

// PersistedLogView lets a settled card reopen its build log: a "Show build log"
// toggle that lazily fetches each side's persisted log (left_log_url /
// right_log_url) and renders them in the same side-by-side panes as the live log.
function PersistedLogView({ leftUrl, rightUrl, open, onOpenChange }: { leftUrl?: string | null; rightUrl?: string | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [logs, setLogs] = useState<{ left: ArtifactLogLine[] | null; right: ArtifactLogLine[] | null } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Lazily fetch each side's log the first time the view is open — driven by an
  // effect (not the click handler) so a restored-open state also loads the log.
  // Keyed by url-pair via a ref so the fetch runs once per pair (and refetches if
  // a regenerate swaps the urls), without `logs`/`loading` in the deps — which
  // would re-fire the effect mid-flight and cancel the request.
  const fetchedKey = useRef<string | null>(null)
  useEffect(() => {
    if (!open || (!leftUrl && !rightUrl)) return
    const key = `${leftUrl ?? ''}|${rightUrl ?? ''}`
    if (fetchedKey.current === key) return
    fetchedKey.current = key
    let cancelled = false
    setLoading(true)
    setErr(null)
    setLogs(null)
    ;(async () => {
      try {
        // A side with no URL (absent on that version) stays null → "No log" pane.
        const fetchSide = async (u?: string | null): Promise<ArtifactLogLine[] | null> => {
          if (!u) return null // side absent or no log → "No log" pane
          const r = await fetch(u)
          if (!r.ok) return null
          const j = (await r.json()) as { lines?: ArtifactLogLine[] }
          return j.lines ?? []
        }
        const [left, right] = await Promise.all([fetchSide(leftUrl), fetchSide(rightUrl)])
        if (!cancelled) setLogs({ left, right })
      } catch (e) {
        if (!cancelled) { setErr(e instanceof Error ? e.message : String(e)); fetchedKey.current = null }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, leftUrl, rightUrl])

  if (!leftUrl && !rightUrl) return null

  const toggle = () => onOpenChange(!open)

  return (
    <div className="pt-1.5">
      <button
        onClick={toggle}
        className="text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
      >
        {open ? 'Hide' : 'Show'} build log
      </button>
      {open && (
        loading ? (
          <div className="my-2 text-xs text-gray-400 dark:text-gray-500">Loading log…</div>
        ) : err ? (
          <div className="my-2 text-xs text-red-500 dark:text-red-400">Failed to load log: {err}</div>
        ) : (
          <LogPanes left={logs?.left ?? null} right={logs?.right ?? null} />
        )
      )}
    </div>
  )
}

function ArtifactSetCard({ set, mode, filter, onRefresh, projectId, agentId }: { set: ArtifactSet; mode: ImageDiffMode; filter: ArtifactTagFilter; onRefresh: (name: string) => void; projectId: string | null; agentId: string }) {
  const status = set.status as string
  // Apply the (shared) tag filter to this card's files. The grid shows only
  // matches; the header still reports the true diff size so "x/y changed" makes
  // it obvious the filter is hiding some.
  const isFiltered = filterIsActive(filter)
  const visibleFiles = isFiltered ? set.files.filter((f) => fileMatchesFilter(f, filter)) : set.files
  const changedFiles = visibleFiles.filter((f) => f.change_type !== 'unchanged')
  const unchangedFiles = visibleFiles.filter((f) => f.change_type === 'unchanged')
  const totalChanged = set.files.filter((f) => f.change_type !== 'unchanged').length
  const changedLabel = isFiltered && changedFiles.length !== totalChanged ? `${changedFiles.length}/${totalChanged} changed` : `${totalChanged} changed`
  const noChanges = status === 'ready' && !set.changed
  // One side failed while the other rendered (status stays "ready"): surface a
  // warning but still show the surviving side's images. Both-sides-failed is the
  // whole-set "error" status instead, so at most one of these is set here.
  const failedSide: 'left' | 'right' | null = set.left_error ? 'left' : set.right_error ? 'right' : null
  const failedSideError = set.left_error || set.right_error

  // Restore any saved view prefs for this card (persisted per project+agent+name).
  // loadArtifactPrefs returns null when the saved status no longer matches the
  // current one, so a regenerate / generating→ready transition falls back to the
  // status-derived defaults below rather than a stale toggle. Read once on mount
  // via the lazy useState initializers.
  const loadPrefs = () => loadArtifactPrefs(projectId, agentId, set.name, status)

  // Every state (generating / error / no-changes / changed) renders inside the
  // same bordered card so switching between them never shifts the layout (e.g.
  // hitting refresh after a failure) and the refresh button is always reachable —
  // including when there are no visual changes. Default to collapsed for the
  // no-changes case (nothing worth showing until asked) and while generating
  // (the live log is opt-in, not in your face); the initial status is evaluated
  // once on mount, and the card stays mounted across status changes (keyed by
  // name) so a manual expand/collapse or regenerate keeps its state.
  const [collapsed, setCollapsed] = useState(() => loadPrefs()?.collapsed ?? ((status === 'ready' && !set.changed) || status === 'generating'))
  const [showUnchanged, setShowUnchanged] = useState(() => loadPrefs()?.showUnchanged ?? false)
  const [buildLogOpen, setBuildLogOpen] = useState(() => loadPrefs()?.buildLogOpen ?? false)

  // Persist the view prefs whenever a toggle changes (and re-key them under the
  // current status, so they only restore while that status holds).
  useEffect(() => {
    saveArtifactPrefs(projectId, agentId, set.name, status, { collapsed, showUnchanged, buildLogOpen })
  }, [projectId, agentId, set.name, status, collapsed, showUnchanged, buildLogOpen])

  // Header progress while generating: both sides' latest progress lines joined by
  // a "·" (the two builds run in parallel), e.g. "building frontend · home 7/24".
  const progressText = [set.left_progress, set.right_progress].filter(Boolean).join(' · ')

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 overflow-hidden">
      {/* Give the header a resting tint that's distinct from the card body
          (bg-white / dark:bg-gray-800) on its own, not only on hover — a 60%
          gray-800 over a gray-800 body was indistinguishable at rest. */}
      <div className="flex items-stretch bg-gray-100 dark:bg-gray-700/40">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer text-left"
        >
          {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
          <ImageIcon className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400 shrink-0" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate shrink-0">{set.name}</span>
          {status === 'generating' && (
            // Live header: spinner, the latest stdout line as progress (truncated so
            // it can't push the refresh button off the row), then how long the job
            // has been running, separated by a "·". Expand the card for the full log.
            <span className="flex items-center gap-1.5 min-w-0 text-xs text-gray-400 dark:text-gray-500">
              <LoaderCircle className="w-3 h-3 shrink-0 animate-spin" />
              <span className="truncate">{progressText || 'generating…'}</span>
              {set.started_at ? (
                <span className="shrink-0">· <ElapsedTime startedAt={set.started_at} /></span>
              ) : null}
            </span>
          )}
          {status === 'error' && (
            <span className="flex items-center gap-1 text-xs text-red-500 dark:text-red-400 shrink-0">
              <TriangleAlert className="w-3 h-3" /> failed
            </span>
          )}
          {status === 'ready' &&
            (noChanges ? (
              <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">no visual changes</span>
            ) : (
              // Highlight the change count so a card with visual changes stands
              // out at a glance from the muted "no visual changes" cards. When the
              // filter hides some, the label reads "shown/total changed".
              <span className="text-xs font-medium text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/40 rounded-full px-2 py-0.5 shrink-0">{changedLabel}</span>
            ))}
          {status === 'ready' && failedSide && (
            // One side failed to render; flag it in the header so it's visible
            // even while the card is collapsed (the images shown are one-sided).
            <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 shrink-0">
              <TriangleAlert className="w-3 h-3" /> {failedSide === 'left' ? 'before' : 'after'} failed
            </span>
          )}
        </button>
        {/* Bust the per-commit cache and regenerate — chiefly to retry a failure,
            whose error is otherwise cached until the ref changes, but always
            available (even with no visual changes) so a render can be re-run. */}
        <button
          onClick={() => onRefresh(set.name)}
          title="Regenerate this artifact"
          aria-label="Regenerate this artifact"
          className="shrink-0 px-3 flex items-center text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {!collapsed && (
        <div className="px-3 pb-2">
          {/* While generating, stream both builds' live logs side by side; a side
              that finishes first shows its final log instead of "waiting". */}
          {status === 'generating' && <LiveLogPanes set={set} />}
          {status === 'error' && (
            <>
              <div className="my-2 px-3 py-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 font-mono text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">
                {set.error ? stripAnsi(set.error) : 'Artifact generation failed.'}
              </div>
              <PersistedLogView leftUrl={set.left_log_url} rightUrl={set.right_log_url} open={buildLogOpen} onOpenChange={setBuildLogOpen} />
            </>
          )}
          {status === 'ready' && (
            // Unified ready layout: the changed files (if any) up front, with the
            // unchanged ones always behind a "Show N unchanged" toggle — so a card
            // with no visual changes reads the same as a mixed one (the unchanged
            // artifacts stay tucked away, not dumped on expand). This avoids the
            // jarring case where a card expanded to view the log suddenly explodes
            // all its unchanged artifacts onto the screen once a render settles to
            // "no visual changes". Only the genuinely empty case gets a placeholder.
            <>
              {failedSide && (
                // One side died; show its error but keep rendering the side that
                // succeeded (its files surface as added/removed in the grid).
                <div className="my-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-300">
                  <div className="flex items-center gap-1.5 font-medium">
                    <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                    The {failedSide === 'left' ? 'before (left)' : 'after (right)'} side failed to render — showing the {failedSide === 'left' ? 'after' : 'before'} side only.
                  </div>
                  {failedSideError && (
                    <pre className="mt-1.5 font-mono whitespace-pre-wrap break-words text-amber-800/90 dark:text-amber-200/80">{stripAnsi(failedSideError)}</pre>
                  )}
                </div>
              )}
              {set.files.length === 0 ? (
                <div className="my-2 text-xs text-gray-400 dark:text-gray-500">No artifacts produced.</div>
              ) : visibleFiles.length === 0 ? (
                <div className="my-2 text-xs text-gray-400 dark:text-gray-500">No files match the current tag filter.</div>
              ) : (
                <>
                  {/* Skip the grid entirely when nothing changed — an empty
                      FileGrid still emits a pt-1 spacer row, which (with the
                      toggles' own top padding) opened a big gap under the header
                      in the no-visual-changes case. */}
                  {changedFiles.length > 0 && <FileGrid files={changedFiles} mode={mode} />}
                  {unchangedFiles.length > 0 && (
                    <div className="pt-1.5">
                      <button
                        onClick={() => setShowUnchanged((s) => !s)}
                        className="text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer"
                      >
                        {showUnchanged ? 'Hide' : 'Show'} {unchangedFiles.length} unchanged
                      </button>
                      {showUnchanged && <FileGrid files={unchangedFiles} mode={mode} />}
                    </div>
                  )}
                </>
              )}
              <PersistedLogView leftUrl={set.left_log_url} rightUrl={set.right_log_url} open={buildLogOpen} onOpenChange={setBuildLogOpen} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

type ArtifactSide = 'left' | 'right'

// Server→client message on the artifacts WebSocket. Mirrors internal/http/artifacts_ws.go.
// log/progress carry a `side` so the two builds (before/after) stay in separate
// panes instead of interleaving into one stream.
type ArtifactWSMessage =
  | { type: 'snapshot'; scripts: ArtifactSet[] }
  | { type: 'set'; set: ArtifactSet }
  | { type: 'log'; script: string; side: ArtifactSide; line: ArtifactLogLine }
  | { type: 'progress'; script: string; side: ArtifactSide; progress: string }

function artifactsWsUrl(projectId: string | null, agentId: string, baseRef?: string, headRef?: string, includeUncommitted?: boolean): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const pid = projectId ? encodeURIComponent(projectId) : '_'
  const params = new URLSearchParams()
  if (baseRef) params.set('base_ref', baseRef)
  if (headRef) params.set('head_ref', headRef)
  if (includeUncommitted) params.set('include_uncommitted', 'true')
  const qs = params.toString() ? `?${params.toString()}` : ''
  return `${protocol}//${host}/ws/projects/${pid}/agents/${encodeURIComponent(agentId)}/artifacts${qs}`
}

export function ArtifactsPanel({ projectId, agentId, baseRef, headRef, includeUncommitted, refreshKey, imageDiffMode }: {
  projectId: string | null
  agentId: string
  baseRef?: string
  headRef?: string
  includeUncommitted?: boolean
  refreshKey: number
  imageDiffMode: ImageDiffMode
}) {
  const [sets, setSets] = useState<ArtifactSet[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Connection mode: WS while live, polling if the socket can't connect or drops.
  const [mode, setMode] = useState<'connecting' | 'ws' | 'poll'>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Manual-refresh state for the polling fallback (the WS path sends a message
  // instead): stash the script name and bump the nonce to re-run the poll effect.
  const [refreshNonce, setRefreshNonce] = useState(0)
  const refreshScriptRef = useRef<string | null>(null)

  // Tag filter, shared across every card for this agent. Reload it when the
  // project/agent changes; persist it only on an explicit user change (a save
  // effect would race the reload and clobber the new key with the old value).
  const [tagFilter, setTagFilter] = useState<ArtifactTagFilter>(() => loadTagFilter(projectId, agentId))
  useEffect(() => { setTagFilter(loadTagFilter(projectId, agentId)) }, [projectId, agentId])
  const updateTagFilter = useCallback((f: ArtifactTagFilter) => {
    setTagFilter(f)
    saveTagFilter(projectId, agentId, f)
  }, [projectId, agentId])

  // Apply a server→client WS message to local state.
  const applyMessage = useCallback((msg: ArtifactWSMessage) => {
    setError(null)
    if (msg.type === 'snapshot') {
      setSets(msg.scripts ?? [])
    } else if (msg.type === 'set') {
      setSets((prev) => (prev ? prev.map((s) => (s.name === msg.set.name ? msg.set : s)) : [msg.set]))
    } else if (msg.type === 'log') {
      setSets((prev) => prev?.map((s) => {
        if (s.name !== msg.script) return s
        return msg.side === 'left'
          ? { ...s, left_log: [...(s.left_log ?? []), msg.line] }
          : { ...s, right_log: [...(s.right_log ?? []), msg.line] }
      }) ?? prev)
    } else if (msg.type === 'progress') {
      setSets((prev) => prev?.map((s) => {
        if (s.name !== msg.script) return s
        return msg.side === 'left' ? { ...s, left_progress: msg.progress } : { ...s, right_progress: msg.progress }
      }) ?? prev)
    }
  }, [])

  // Primary path: stream updates over a WebSocket so progress/log update instantly.
  // Falls back to polling (below) if the socket fails to open or later drops.
  useEffect(() => {
    let cancelled = false
    setMode('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(artifactsWsUrl(projectId, agentId, baseRef, headRef, includeUncommitted))
    } catch {
      setMode('poll')
      return
    }
    wsRef.current = ws
    ws.onopen = () => { if (!cancelled) setMode('ws') }
    ws.onmessage = (e) => {
      if (cancelled) return
      try { applyMessage(JSON.parse(e.data) as ArtifactWSMessage) } catch { /* ignore malformed frames */ }
    }
    ws.onclose = () => {
      wsRef.current = null
      // Fall back to polling on any non-deliberate close (initial-connect failure
      // or a mid-session drop, e.g. the daemon restarting).
      if (!cancelled) setMode('poll')
    }
    return () => {
      cancelled = true
      ws.onclose = null
      ws.close()
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [projectId, agentId, baseRef, headRef, includeUncommitted, refreshKey, applyMessage])

  // Fallback path: poll the HTTP endpoint while the WS is unavailable.
  useEffect(() => {
    if (mode !== 'poll') return
    let cancelled = false
    const clear = () => { if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null } }
    const refreshScript = refreshScriptRef.current
    refreshScriptRef.current = null

    const tick = async (first: boolean) => {
      try {
        const resp = await api.default.getAgentArtifacts(projectId ?? '', agentId, baseRef, headRef, includeUncommitted, first ? refreshScript ?? undefined : undefined)
        if (cancelled) return
        setSets(resp.scripts)
        setError(null)
        if (resp.scripts.some((s) => (s.status as string) === 'generating')) {
          pollTimerRef.current = setTimeout(() => tick(false), 2500)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    clear()
    tick(true)
    return () => { cancelled = true; clear() }
  }, [mode, projectId, agentId, baseRef, headRef, includeUncommitted, refreshKey, refreshNonce])

  const requestRefresh = useCallback((name: string) => {
    // Optimistically flip the card to a fresh "generating" state so the spinner,
    // a zeroed elapsed clock and an empty log show immediately.
    setSets((prev) => prev?.map((s) => (s.name === name
      ? {
          ...s,
          status: 'generating' as unknown as ArtifactSet['status'],
          error: null,
          left_progress: null,
          right_progress: null,
          left_log: [],
          right_log: [],
          left_log_url: null,
          right_log_url: null,
          started_at: Math.floor(Date.now() / 1000),
        }
      : s)) ?? prev)
    const ws = wsRef.current
    if (mode === 'ws' && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'refresh', script: name }))
    } else {
      // Polling fallback: forward the name to the next poll so the backend
      // discards the cached (possibly errored) result and regenerates.
      refreshScriptRef.current = name
      setRefreshNonce((n) => n + 1)
    }
  }, [mode])

  // Every tag offered by any file, partitioned into scoped categories and
  // free-form tags. Drives the filter bar; empty → no filter bar is shown.
  const collectedTags = useMemo(() => collectTags(sets ?? []), [sets])
  const hasTags = collectedTags.scoped.length > 0 || collectedTags.free.length > 0

  if (error) {
    return (
      <div className="mb-4 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400">
        Failed to load artifacts: {error}
      </div>
    )
  }
  // Render nothing until we know there are configured scripts.
  if (!sets || sets.length === 0) return null

  // Generation progress (#38): how many artifact scripts have settled (ready or
  // failed) versus how many are still generating. Shown only while work is in
  // flight; WS pushes (or the poll above) keep it ticking until everything settles.
  const generatingCount = sets.filter((s) => (s.status as string) === 'generating').length
  const settledCount = sets.length - generatingCount

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <ImageIcon className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Artifacts</h3>
        {generatingCount > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] font-normal text-gray-400 dark:text-gray-500">
            <LoaderCircle className="w-3 h-3 animate-spin" />
            Generating {settledCount}/{sets.length}
          </span>
        )}
        <InfoTooltip title="Artifacts">
          <p>Artifacts are visual snapshots — typically screenshots — rendered from your code so you can see what a change <em>looks like</em>, side by side with the base branch.</p>
          <p>Each one is produced by a project-defined <strong>artifact script</strong>. Hydra checks out both the base ref and the head ref (or your uncommitted working tree), runs the script against each with <code className="text-blue-300">$HYDRA_ARTIFACT_OUTPUT</code>, <code className="text-blue-300">$HYDRA_ARTIFACT_SOURCE</code> and <code className="text-blue-300">$HYDRA_ARTIFACT_REF</code> set, and compares the images it writes. Results are cached per commit, so re-viewing a diff is free.</p>
          <p>Configure them in <code className="text-blue-300">.hydra/config.toml</code> with <code className="text-blue-300">[[artifacts]]</code> blocks (<code className="text-blue-300">name</code>, <code className="text-blue-300">command</code>, optional <code className="text-blue-300">timeout_sec</code>) — for example a script that builds the app and screenshots a page, so visual UI changes show up here in the diff viewer.</p>
          <p>A script with no visual changes — or one still generating — collapses to a single header row; click it to expand. The two sides (base and head) build in parallel, so the expanded card shows their <strong>build logs side by side</strong> (Before / After, stderr in red); once finished, reopen them any time with <strong>Show build log</strong>. The refresh button (top-right of each card) re-runs a script — handy to retry a failure or re-render even when nothing visibly changed.</p>
          <p>The header shows each side's latest <code className="text-blue-300">stdout</code> line as live progress. To surface a cleaner message, print a line prefixed with <code className="text-blue-300">::hydra:progress::</code> (e.g. <code className="text-blue-300">echo "::hydra:progress:: capturing home 3/24"</code>) — Hydra strips the prefix, shows the rest as the progress line, and from then on ignores ordinary <code className="text-blue-300">stdout</code> for the header, so a noisy build can't hijack it. The full output still lands in the build log.</p>
          <p><strong>Tags &amp; filter.</strong> Alongside an image <code className="text-blue-300">home.png</code> the script can write a JSON sidecar <code className="text-blue-300">home.png.meta</code> like <code className="text-blue-300">{'{'}"tags": ["theme::dark", "viewport::phone"]{'}'}</code>. Tags show as labels on each file and as a filter on this bar. A <code className="text-blue-300">category::value</code> tag is a <em>scoped</em> label — only one value per category is kept (the last wins) and it filters as a single-select dropdown; plain tags are free-form toggles. Handy when a script emits many shots (light/dark, phone/desktop) and you want to see just one slice.</p>
        </InfoTooltip>
        {/* Filter lives right on the header bar (not behind a popover) so picking a
            theme / viewport / tag is a single click. Shown only once some file
            carries tags; ml-auto floats it to the right of the bar. */}
        {hasTags && (
          <div className="ml-auto">
            <TagFilterBar tags={collectedTags} filter={tagFilter} onChange={updateTagFilter} />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {sets.map((s) => <ArtifactSetCard key={s.name} set={s} mode={imageDiffMode} filter={tagFilter} onRefresh={requestRefresh} projectId={projectId} agentId={agentId} />)}
      </div>
    </div>
  )
}
