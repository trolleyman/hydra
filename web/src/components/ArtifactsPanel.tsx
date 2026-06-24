import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { api } from '../stores/apiClient'
import type { ArtifactSet, ArtifactFile, ArtifactLogLine } from '../api'
import { LoaderCircle, Image as ImageIcon, ImageOff, ChevronDown, ChevronRight, TriangleAlert, RefreshCw } from 'lucide-react'
import { InfoTooltip } from './InfoTooltip'
import { loadArtifactPrefs, saveArtifactPrefs, loadTagFilter, saveTagFilter, type ArtifactTagFilter } from '../lib/artifactPrefs'
import { stripAnsi } from '../lib/ansi'
import {
  checkerStyle, IMG_CLASS, OVERLAY_CLASS, TAG_CLASS, makeAuxOpen,
  useMediaResize, ResizeGrip, DIFF_COLOR, DIFF_PIXEL_THRESHOLD,
} from './artifactDiffShared'
import { VideoDiffView, isVideoArtifact } from './VideoDiffView'

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

// The ways to compare a before/after image pair. Persisted in the diff viewer's
// settings; see DiffViewer's SettingsPopup.
export type ImageDiffMode = 'side-by-side' | 'ab' | 'slider' | 'onion' | 'difference'

export const IMAGE_DIFF_MODES: { value: ImageDiffMode; label: string }[] = [
  { value: 'side-by-side', label: 'Side by side' },
  { value: 'ab', label: 'Before/After' },
  { value: 'difference', label: 'Difference (magenta)' },
  { value: 'slider', label: 'Before/after slider' },
  { value: 'onion', label: 'Onion skin' },
]

function ImageCell({ url, label, maxHeight, onResizeStart, consumeDrag }: { url?: string | null; label: string; maxHeight: number; onResizeStart: (e: React.PointerEvent) => void; consumeDrag: () => boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">{label}</div>
      {url ? (
        // A press-and-drag anywhere on the image resizes it (onPointerDown); a plain
        // click still opens it in a new tab via the <a>, but consumeDrag() cancels
        // that navigation when the press turned into a drag. select-none so a drag
        // doesn't marquee-select. draggable={false} so the image isn't ghost-dragged.
        <div className="group relative inline-block select-none" onPointerDown={onResizeStart}>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="block"
            onClick={(e) => { if (consumeDrag()) e.preventDefault() }}
          >
            <img
              src={url}
              loading="lazy"
              draggable={false}
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
  const { maxHeight, onResizeStart, consumeDrag } = useMediaResize()
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
        // group: reveals the resize grip on hover. select-none: flipping the A/B
        // view is a rapid click target, so without this a quick double-click would
        // highlight the "No image" placeholder text. A press starts a resize drag
        // anywhere on the image (onPointerDown); a plain click still flips sides,
        // but consumeDrag() suppresses that flip when the press turned into a drag.
        className="group relative inline-block cursor-pointer select-none"
        onPointerDown={onResizeStart}
        onClick={() => { if (!consumeDrag()) setShowAfter((s) => !s) }}
        onAuxClick={makeAuxOpen(() => (showAfter ? right : left) || sizer)}
      >
        <img src={sizer} style={{ visibility: 'hidden', maxHeight: `${maxHeight}px` }} className={`${IMG_CLASS} block`} draggable={false} />
        <LayerNode url={right} style={{ maxHeight: `${maxHeight}px`, visibility: showAfter ? 'visible' : 'hidden' }} />
        <LayerNode url={left} style={{ maxHeight: `${maxHeight}px`, visibility: showAfter ? 'hidden' : 'visible' }} />
        <ResizeGrip onPointerDown={onResizeStart} />
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
  const { maxHeight, onResizeStart } = useMediaResize()
  const sizer = (right ?? left) as string
  return (
    <div className="min-w-0">
      <div
        // A press-and-drag anywhere on the blended image resizes it; the opacity
        // slider below is a separate row, so the box owns no left-click gesture and
        // onResizeStart needs no consumeDrag guard. group reveals the grip on hover.
        className="group relative inline-block select-none"
        onPointerDown={onResizeStart}
        onAuxClick={makeAuxOpen(() => (opacity >= 50 ? right : left) || sizer)}
      >
        <img src={sizer} style={{ visibility: 'hidden', maxHeight: `${maxHeight}px` }} className={`${IMG_CLASS} block`} draggable={false} />
        <LayerNode url={left} />
        <LayerNode url={right} style={{ opacity: opacity / 100 }} />
        <ResizeGrip onPointerDown={onResizeStart} />
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

// loadImage resolves to a decoded <img> for a same-origin artifact URL, so the
// difference view can read its pixels off a canvas without tainting it.
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`failed to load ${url}`))
    img.src = url
  })
}

// DiffCanvas renders the "after" image with every pixel that differs from the
// "before" image painted bright magenta. The two are aligned at the top-left and
// compared over the union of their bounds, so a size change (or pixels present on
// only one side) reads as a difference too. It only runs with both sides present;
// the caller handles the single-side case. Same-origin artifact URLs keep the
// canvas untainted so getImageData works.
function DiffCanvas({ left, right, maxHeight }: { left: string; right: string; maxHeight: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    Promise.all([loadImage(left), loadImage(right)])
      .then(([la, ra]) => {
        if (cancelled) return
        const canvas = ref.current
        if (!canvas) return
        const w = Math.max(la.naturalWidth, ra.naturalWidth)
        const h = Math.max(la.naturalHeight, ra.naturalHeight)
        if (w === 0 || h === 0) { setState('error'); return }
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) { setState('error'); return }

        // The visible canvas starts as the "after" image (the base); a scratch
        // canvas holds "before" so we can read both pixel buffers and overwrite
        // only the differing pixels with magenta.
        ctx.clearRect(0, 0, w, h)
        ctx.drawImage(ra, 0, 0)
        const after = ctx.getImageData(0, 0, w, h)

        const scratch = document.createElement('canvas')
        scratch.width = w
        scratch.height = h
        const sctx = scratch.getContext('2d', { willReadFrequently: true })
        if (!sctx) { setState('error'); return }
        sctx.drawImage(la, 0, 0)
        const before = sctx.getImageData(0, 0, w, h).data

        const out = after.data
        for (let i = 0; i < out.length; i += 4) {
          const d =
            Math.abs(out[i] - before[i]) +
            Math.abs(out[i + 1] - before[i + 1]) +
            Math.abs(out[i + 2] - before[i + 2]) +
            Math.abs(out[i + 3] - before[i + 3])
          if (d > DIFF_PIXEL_THRESHOLD) {
            out[i] = DIFF_COLOR[0]
            out[i + 1] = DIFF_COLOR[1]
            out[i + 2] = DIFF_COLOR[2]
            out[i + 3] = 255
          }
        }
        ctx.putImageData(after, 0, 0)
        setState('ready')
      })
      .catch(() => { if (!cancelled) setState('error') })
    return () => { cancelled = true }
  }, [left, right])

  return (
    <div className="relative inline-block" onAuxClick={makeAuxOpen(() => right)}>
      <span className={`${TAG_CLASS} left-1`}>Diff</span>
      <canvas
        ref={ref}
        style={{ ...checkerStyle, maxHeight: `${maxHeight}px` }}
        className={`${IMG_CLASS} block ${state === 'ready' ? '' : 'opacity-0'}`}
      />
      {state !== 'ready' && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-gray-400 dark:text-gray-500">
          {state === 'error' ? 'Could not compute diff' : 'Computing diff…'}
        </div>
      )}
    </div>
  )
}

// DiffCompare is the "difference" mode: a Before / After / Diff switch like the
// A/B view, where the Diff tab shows the after image with every changed pixel in
// bright magenta (see DiffCanvas). When only one side exists (added/removed file)
// there is nothing to diff, so the Diff tab just shows the side that's present.
function DiffCompare({ left, right }: { left?: string | null; right?: string | null }) {
  const [view, setView] = useState<'before' | 'after' | 'diff'>('diff')
  const { maxHeight, onResizeStart } = useMediaResize()
  const sizer = (right ?? left) as string
  const btn = (active: boolean) =>
    `text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
      active ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
    }`
  const canDiff = !!left && !!right
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 mb-1">
        <button onClick={() => setView('before')} className={btn(view === 'before')}>Before</button>
        <button onClick={() => setView('after')} className={btn(view === 'after')}>After</button>
        <button onClick={() => setView('diff')} className={btn(view === 'diff')}>Diff</button>
      </div>
      {view === 'diff' && canDiff ? (
        // A press-and-drag anywhere on the diff canvas resizes it; there's no
        // left-click gesture here, so onResizeStart needs no consumeDrag guard.
        <div className="group relative inline-block" onPointerDown={onResizeStart}>
          <DiffCanvas left={left} right={right} maxHeight={maxHeight} />
          <ResizeGrip onPointerDown={onResizeStart} />
        </div>
      ) : (
        // Before/After (or the Diff tab with only one side present): show the
        // chosen image, stacked over a hidden sizer so the box keeps its size. A
        // press-and-drag anywhere resizes (group reveals the grip on hover too).
        <div
          className="group relative inline-block select-none"
          onPointerDown={onResizeStart}
          onAuxClick={makeAuxOpen(() => (view === 'before' ? left : right) || sizer)}
        >
          <img src={sizer} style={{ visibility: 'hidden', maxHeight: `${maxHeight}px` }} className={`${IMG_CLASS} block`} draggable={false} />
          <LayerNode url={view === 'before' ? left : (right ?? left)} style={{ maxHeight: `${maxHeight}px` }} />
          <ResizeGrip onPointerDown={onResizeStart} />
        </div>
      )}
    </div>
  )
}

// The default side-by-side pair. Holds one shared resize state so dragging the
// grip on either image grows both before/after cells by the same amount.
function SideBySide({ left, right }: { left?: string | null; right?: string | null }) {
  const { maxHeight, onResizeStart, consumeDrag } = useMediaResize()
  return (
    <div className="flex gap-3">
      <ImageCell url={left} label="Before" maxHeight={maxHeight} onResizeStart={onResizeStart} consumeDrag={consumeDrag} />
      <ImageCell url={right} label="After" maxHeight={maxHeight} onResizeStart={onResizeStart} consumeDrag={consumeDrag} />
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
  if (mode === 'difference') return <DiffCompare left={left} right={right} />
  if (mode === 'slider') return <SliderCompare left={left} right={right} />
  return <OnionCompare left={left} right={right} />
}

// --- Tags & filtering ---
//
// A file's tags come from a sibling JSON sidecar (<file>.meta) the artifact
// script writes; the backend normalizes them (see internal/artifacts). A
// "category::value" tag is a GitLab-style scoped label — at most one value per
// category on a given file. Every value's checkbox is ON by default (show all);
// the filter records only what the user turns OFF, hiding files that carry a
// hidden value. A plain tag (no "::") is free-form and works the same way.

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

// The built-in "type" filter scope. Unlike the user-defined tag scopes (which
// come from each file's .meta sidecar), this one is intrinsic — derived from the
// file's extension — so it's offered whenever a set spans more than one type
// (e.g. PNG screenshots alongside a .webm). The name is reserved: a user
// `type::…` tag is ignored so it can't collide with the built-in.
const TYPE_CATEGORY = 'type'

// fileMediaType classifies a file as 'video' or 'image' for the built-in type
// filter, matching how FileRow routes it (isVideoArtifact → the video viewer).
function fileMediaType(file: ArtifactFile): string {
  return isVideoArtifact(file.name) ? 'video' : 'image'
}

type CollectedTags = {
  scoped: { cat: string; values: string[] }[]
  free: string[]
}

// collectTags gathers every tag across all files into the scoped categories (with
// their distinct values) and free-form tags that the filter bar offers. It also
// folds in each set's `pending_tags` — the tags a side that settled early exposes
// while the other side is still generating — so the filter appears as soon as we
// know what tags there are likely to be, not only once the whole set is ready.
function collectTags(sets: ArtifactSet[]): CollectedTags {
  const scoped = new Map<string, Set<string>>()
  const free = new Set<string>()
  const add = (t: string) => {
    const p = parseScopedTag(t)
    if (p) {
      if (p.cat === TYPE_CATEGORY) return // reserved for the built-in type filter
      if (!scoped.has(p.cat)) scoped.set(p.cat, new Set())
      scoped.get(p.cat)!.add(p.val)
    } else {
      free.add(t)
    }
  }
  for (const s of sets) {
    for (const t of s.pending_tags ?? []) add(t)
    for (const f of s.files) {
      for (const t of f.tags ?? []) add(t)
    }
  }
  return {
    scoped: [...scoped.entries()]
      .map(([cat, vals]) => ({ cat, values: [...vals].sort() }))
      .sort((a, b) => a.cat.localeCompare(b.cat)),
    free: [...free].sort(),
  }
}

// filterIsActive reports whether the filter would hide anything — i.e. any
// scoped category or the free-form group has at least one value turned off.
function filterIsActive(filter: ArtifactTagFilter): boolean {
  return Object.values(filter.scoped).some((off) => off.length > 0) || filter.free.length > 0
}

// fileMatchesFilter reports whether a file passes the filter. Each array lists
// the values turned OFF. For a scoped category, the file is dropped if its value
// for that category is hidden — files lacking the category carry none of the
// hidden values, so they're unaffected. For free-form tags, the file is dropped
// only if every free tag it carries is hidden (a file tagged both an on and an
// off tag stays; an untagged file is never dropped on this axis).
function fileMatchesFilter(file: ArtifactFile, filter: ArtifactTagFilter): boolean {
  const tags = file.tags ?? []
  for (const [cat, off] of Object.entries(filter.scoped)) {
    if (off.length === 0) continue
    // The built-in "type" scope matches the file's intrinsic media type, not a
    // tag it carries; like every other scope, the file is dropped when its
    // value for that category is turned off.
    if (cat === TYPE_CATEGORY) {
      if (off.includes(fileMediaType(file))) return false
    } else if (off.some((v) => tags.includes(`${cat}::${v}`))) {
      return false
    }
  }
  if (filter.free.length > 0) {
    const freeTags = tags.filter((t) => !parseScopedTag(t))
    if (freeTags.length > 0 && freeTags.every((t) => filter.free.includes(t))) return false
  }
  return true
}

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

// TagScopeFilter renders one filter button for a single tag scope, so each
// scope gets its own trigger on the Artifacts header instead of one combined
// menu. The button's label is the category name (or "tags" for the free-form
// group); the dropdown lists a checkbox per value, every one ON by default. The
// `off` prop is the set of values the user has turned off (a file is hidden if
// it carries one). A fixed header row carries "all" (top-left, re-check
// everything) and "clear" (top-right, uncheck everything) so the menu's height
// never changes as you select. Shift-clicking a value isolates it (clears the
// others). The count badge shows how many values are hidden; selection is shared
// across every card via the parent's filter state.
function TagScopeFilter({
  label,
  values,
  off,
  onToggle,
  onIsolate,
  onAll,
  onClear,
}: {
  label: string
  values: string[]
  off: string[]
  onToggle: (val: string) => void
  onIsolate: (val: string) => void
  onAll: () => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on an outside click or Escape, like the diff viewer's settings popup.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  // Count only currently-offered values that are off (stale entries for values
  // no longer present don't count), so "all on" / the badge stay accurate.
  const hiddenCount = values.filter((v) => off.includes(v)).length
  const allOn = hiddenCount === 0
  const allOff = hiddenCount === values.length && values.length > 0
  // select-none: shift-click isolates a value, but the browser's shift-click
  // range-selects text (which starts on mousedown, so the onClick preventDefault
  // can't stop it) — making the row unselectable avoids the stray highlight.
  const rowClass = 'flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[11px] font-medium transition-colors cursor-pointer ${
          open || hiddenCount > 0
            ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
            : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
        }`}
      >
        <span className="lowercase">{label}</span>
        {hiddenCount > 0 && (
          <span className="inline-flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-full bg-blue-500 text-white text-[10px] font-semibold leading-none">{hiddenCount}</span>
        )}
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden text-left">
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
                <span className="text-gray-700 dark:text-gray-300 truncate">{v}</span>
              </label>
            ))}
          </div>
          <div className="px-3 py-1 border-t border-gray-100 dark:border-gray-700/60 text-[10px] text-gray-400 dark:text-gray-500">shift-click to isolate</div>
        </div>
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
        {file.unverified && (
          <span
            className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20"
            title="Compared by byte hash only — install ffmpeg for frame-accurate video diffs. This “modified” result may be spurious (e.g. only container metadata changed)."
          >
            <TriangleAlert className="w-3 h-3" />
            byte-compared
          </span>
        )}
      </div>
      {(file.tags ?? []).length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2 max-w-full">
          {(file.tags ?? []).map((t) => <TagBadge key={t} tag={t} />)}
        </div>
      )}
      {isVideoArtifact(file.name) ? (
        <VideoDiffView left={file.left_url} right={file.right_url} mode={mode} fps={file.fps} />
      ) : (
        <ImageDiffView left={file.left_url} right={file.right_url} mode={mode} />
      )}
    </div>
  )
}

// Lay the per-file before/after blocks out as flex-wrap items so a tall, narrow
// artifact (e.g. a phone screenshot) only claims the width it needs and several
// can share a row, while a wide desktop screenshot wraps onto its own line. Each
// file's name + before + after stays a single, unbreakable block.
function FileGrid({ files, mode }: { files: ArtifactFile[]; mode: ImageDiffMode }) {
  return (
    // pt-3 so the gap above the first file row matches the card body's px-3 left
    // inset — the top and left spacing around the grid read as equal. items-start
    // so each card sizes to its own content height instead of stretching to match
    // a taller neighbour on the same row (flex's default align-items: stretch),
    // which left a short, small-image card half-empty below its image.
    <div className="flex flex-wrap items-start gap-3 pt-3">
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
export function ElapsedTime({ startedAt }: { startedAt: number }) {
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
export function LogView({ log, emptyText = 'Waiting for output…' }: { log: ArtifactLogLine[]; emptyText?: string }) {
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
  // including when there are no visual changes. Default to collapsed (the card is
  // opt-in: click to expand) when nothing is saved for this agent; the saved
  // per-agent state, when present, wins. The card is keyed by project+agent+name
  // at the call site, so switching agents remounts it and re-reads that agent's
  // saved state instead of leaking the previous agent's toggle.
  const [collapsed, setCollapsed] = useState(() => loadPrefs()?.collapsed ?? true)
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

  // The built-in "type" filter (image / video), derived from the files' own
  // extensions rather than their tags. Offered whenever a set spans more than one
  // type, so a reviewer can isolate the videos (or the stills); shown after the
  // user-defined tag scopes.
  const fileTypes = useMemo(() => {
    const types = new Set<string>()
    for (const s of sets ?? []) for (const f of s.files) types.add(fileMediaType(f))
    return [...types].sort()
  }, [sets])
  const showTypeFilter = fileTypes.length > 1
  // Values turned off (hidden), mirroring the user scopes' inverted model.
  const typeOff = tagFilter.scoped[TYPE_CATEGORY] ?? []

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
      {/* Reserve the filter bar's height (its segmented controls / chips are
          taller than the bare title) so the header stays the same height whether
          or not tags are present — the filter loading in must not jump the layout. */}
      <div className="flex flex-wrap items-center gap-2 mb-2 min-h-[1.625rem]">
        <ImageIcon className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
        <h3 className="text-xs font-semibold tracking-wide text-gray-500 dark:text-gray-400">Artifacts</h3>
        {generatingCount > 0 && (
          <span className="flex items-center gap-1.5 text-[11px] font-normal text-gray-400 dark:text-gray-500">
            <LoaderCircle className="w-3 h-3 animate-spin" />
            Generating {settledCount}/{sets.length}
          </span>
        )}
        <InfoTooltip title="Artifacts" width={560}>
          <p>Artifacts are visual snapshots — typically screenshots, or videos (screen recordings) — rendered from your code so you can see what a change <em>looks like</em>, side by side with the base branch.</p>
          <p>Each one is produced by a project-defined <strong>artifact script</strong>. Hydra checks out both the base ref and the head ref (or your uncommitted working tree), runs the script against each with <code className="text-blue-300">$HYDRA_ARTIFACT_OUTPUT</code>, <code className="text-blue-300">$HYDRA_ARTIFACT_SOURCE</code> and <code className="text-blue-300">$HYDRA_ARTIFACT_REF</code> set, and compares the images it writes. Results are cached per commit, so re-viewing a diff is free.</p>
          <p>Configure them in <code className="text-blue-300">.hydra/config.toml</code> with <code className="text-blue-300">[[artifacts]]</code> blocks (<code className="text-blue-300">name</code>, <code className="text-blue-300">command</code>, optional <code className="text-blue-300">timeout_sec</code>) — for example a script that builds the app and screenshots a page, so visual UI changes show up here in the diff viewer.</p>
          <p><strong>Images &amp; video.</strong> <code className="text-blue-300">.png .jpg .gif</code> are diffed pixel-by-pixel (so cosmetic re-encodes are ignored); <code className="text-blue-300">.webm</code> video is diffed frame-by-frame when <strong>ffmpeg</strong> is installed, falling back to a byte-hash comparison otherwise (shown with a <em>byte-compared</em> badge, since that verdict may be spurious). Other types — <code className="text-blue-300">.webp .avif .svg .bmp .pdf</code> — are byte-hash compared. Encode video as <strong>lossless</strong> <code className="text-blue-300">.webm</code> (e.g. <code className="text-blue-300">ffmpeg … -c:v libvpx-vp9 -lossless 1</code>) so identical frames stay identical.</p>
          <p>A script with no visual changes — or one still generating — collapses to a single header row; click it to expand. The two sides (base and head) build in parallel, so the expanded card shows their <strong>build logs side by side</strong> (Before / After, stderr in red); once finished, reopen them any time with <strong>Show build log</strong>. The refresh button (top-right of each card) re-runs a script — handy to retry a failure or re-render even when nothing visibly changed.</p>
          <p>The header shows each side's latest <code className="text-blue-300">stdout</code> line as live progress. To surface a cleaner message, print a line prefixed with <code className="text-blue-300">::hydra:progress::</code> (e.g. <code className="text-blue-300">echo "::hydra:progress:: capturing home 3/24"</code>) — Hydra strips the prefix, shows the rest as the progress line, and from then on ignores ordinary <code className="text-blue-300">stdout</code> for the header, so a noisy build can't hijack it. The full output still lands in the build log.</p>
          <p><strong>Tags &amp; filter.</strong> Alongside an image <code className="text-blue-300">home.png</code> the script can write a JSON sidecar <code className="text-blue-300">home.png.meta</code> like <code className="text-blue-300">{'{'}"tags": ["theme::dark", "viewport::phone"]{'}'}</code>. Tags show as labels on each file and as a filter on this bar. A <code className="text-blue-300">category::value</code> tag is a <em>scoped</em> label — only one value per category is kept on a file (the last wins), and each category gets a filter button listing its values. Every value starts <em>on</em>; uncheck one to hide the files carrying it, or use <strong>all</strong> / <strong>clear</strong> (top of the menu) to toggle them in bulk. Shift-click a value to isolate it (hide everything else). Plain tags work the same way under a "tags" button. Handy when a script emits many shots (light/dark, phone/desktop) and you want to see just one slice. A built-in <strong>type</strong> filter (image / video, from each file's extension) appears after your tags whenever a set mixes both.</p>
        </InfoTooltip>
        {/* One compact filter button per tag scope on the header bar — a button
            for each scoped category (theme / viewport / …) and one "tags" button
            for free-form tags — so each opens just its own slice instead of one
            combined menu. Shown only once some file (or a settled side, via
            pending_tags) carries tags; ml-auto floats them to the right. */}
        {(hasTags || showTypeFilter) && (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {collectedTags.scoped.map(({ cat, values }) => (
              <TagScopeFilter
                key={cat}
                label={cat}
                values={values}
                off={tagFilter.scoped[cat] ?? []}
                onToggle={(val) => {
                  const cur = tagFilter.scoped[cat] ?? []
                  const next = cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val]
                  updateTagFilter({ ...tagFilter, scoped: { ...tagFilter.scoped, [cat]: next } })
                }}
                onIsolate={(val) => updateTagFilter({ ...tagFilter, scoped: { ...tagFilter.scoped, [cat]: values.filter((x) => x !== val) } })}
                onAll={() => updateTagFilter({ ...tagFilter, scoped: { ...tagFilter.scoped, [cat]: [] } })}
                onClear={() => updateTagFilter({ ...tagFilter, scoped: { ...tagFilter.scoped, [cat]: [...values] } })}
              />
            ))}
            {collectedTags.free.length > 0 && (
              <TagScopeFilter
                label="tags"
                values={collectedTags.free}
                off={tagFilter.free}
                onToggle={(t) =>
                  updateTagFilter({ ...tagFilter, free: tagFilter.free.includes(t) ? tagFilter.free.filter((x) => x !== t) : [...tagFilter.free, t] })
                }
                onIsolate={(t) => updateTagFilter({ ...tagFilter, free: collectedTags.free.filter((x) => x !== t) })}
                onAll={() => updateTagFilter({ ...tagFilter, free: [] })}
                onClear={() => updateTagFilter({ ...tagFilter, free: [...collectedTags.free] })}
              />
            )}
            {/* Built-in type scope, last — image vs video, derived from the file
                extensions rather than a tag. */}
            {showTypeFilter && (
              <TagScopeFilter
                label={TYPE_CATEGORY}
                values={fileTypes}
                off={typeOff}
                onToggle={(val) => {
                  const next = typeOff.includes(val) ? typeOff.filter((x) => x !== val) : [...typeOff, val]
                  updateTagFilter({ ...tagFilter, scoped: { ...tagFilter.scoped, [TYPE_CATEGORY]: next } })
                }}
                onIsolate={(val) => updateTagFilter({ ...tagFilter, scoped: { ...tagFilter.scoped, [TYPE_CATEGORY]: fileTypes.filter((x) => x !== val) } })}
                onAll={() => updateTagFilter({ ...tagFilter, scoped: { ...tagFilter.scoped, [TYPE_CATEGORY]: [] } })}
                onClear={() => updateTagFilter({ ...tagFilter, scoped: { ...tagFilter.scoped, [TYPE_CATEGORY]: [...fileTypes] } })}
              />
            )}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {/* Key by project+agent+name (not just name): switching agents reuses
            this same mounted panel, so a name-only key would let one agent's
            cards keep the previous agent's expand/collapse state (and its save
            effect would then clobber the new agent's saved prefs). Re-keying per
            agent remounts each card so it re-reads that agent's saved state. */}
        {sets.map((s) => <ArtifactSetCard key={`${projectId ?? '_'}-${agentId}-${s.name}`} set={s} mode={imageDiffMode} filter={tagFilter} onRefresh={requestRefresh} projectId={projectId} agentId={agentId} />)}
      </div>
    </div>
  )
}
