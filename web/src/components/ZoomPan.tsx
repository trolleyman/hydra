import { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize } from 'lucide-react'

// How far past fit you can magnify (8× the fit size). Enough to read individual
// pixels of a downscaled screenshot without letting the image run away entirely.
const MAX_SCALE = 8
// Minimap width in px; its height follows the content's aspect ratio.
const MM_W = 140

// ZoomPan wraps a piece of lightbox content — a plain image OR a before/after
// comparator — and layers magnify + pan on top of it, mode-agnostically:
//
//   * the scroll-wheel zooms toward the cursor (fit → up to MAX_SCALE),
//   * once zoomed in, dragging pans (at fit the wrapped content keeps its own
//     click / slider / onion gestures — pan only takes over above 1×), and
//   * a live minimap + a "Reset view" button appear in the bottom-right corner
//     while zoomed, the minimap draggable to pan.
//
// Panning is clamped so the magnified content always covers the frame — you can
// never drag it partly out of view. The wrapper sizes itself to the content at
// rest (inline-block) and clips the magnified content to that box, so the
// surrounding lightbox chrome (caption, mode controls) is unaffected. Remounting
// it (the lightbox keys its content by index) resets the zoom on navigation.
export function ZoomPan({ children, minimapSrc, className, style }: {
  children: React.ReactNode
  // The image shown inside the minimap (a representative side for a diff pair).
  // Omitted → the minimap shows just the viewport rectangle on a neutral panel.
  minimapSrc?: string | null
  className?: string
  style?: React.CSSProperties
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const mmRef = useRef<HTMLDivElement>(null)
  // scale + translation (px, content top-left relative to the frame) as one unit
  // so a wheel zoom can move all three together (keep the cursor point fixed).
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 })
  // The frame's rendered (fit) size — the bounds the clamp + minimap math need.
  const [dims, setDims] = useState({ w: 0, h: 0 })
  const [panning, setPanning] = useState(false)
  // Whether the next transform change should ease rather than jump. On for minimap
  // "click to go" + Reset (a quick glide to the new spot); off for direct image
  // drag-pan and wheel zoom, which must track the cursor 1:1.
  const [smooth, setSmooth] = useState(false)
  // Set while a drag actually moved, so the trailing click is swallowed (a pan
  // shouldn't also flip the A/B view or open anything).
  const movedRef = useRef(false)

  // Track the frame's fit size (covers image load + window resize) for clamping
  // and the minimap. A CSS transform doesn't change layout size, so this stays the
  // fit size even while magnified.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = () => setDims({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  // Clamp a translation so the scaled content always covers the frame — no empty
  // gutter from over-panning. At scale 1 both bounds collapse to 0.
  const clampT = useCallback((nx: number, ny: number, s: number): [number, number] => {
    const minX = dims.w * (1 - s)
    const minY = dims.h * (1 - s)
    return [Math.min(0, Math.max(minX, nx)), Math.min(0, Math.max(minY, ny))]
  }, [dims])

  // Zoom by `factor` keeping the content point under (cx, cy) — coords relative to
  // the frame's top-left — fixed, so the image grows toward the cursor.
  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    setView((v) => {
      const ns = Math.min(MAX_SCALE, Math.max(1, v.scale * factor))
      if (ns === v.scale) return v
      const px = (cx - v.tx) / v.scale
      const py = (cy - v.ty) / v.scale
      const [tx, ty] = clampT(cx - px * ns, cy - py * ns, ns)
      return { scale: ns, tx, ty }
    })
  }, [clampT])

  // Wheel must be a non-passive native listener so preventDefault can stop the
  // page/scroll from also reacting; React's synthetic onWheel can't guarantee that.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setSmooth(false)
      const r = el.getBoundingClientRect()
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const zoomed = view.scale > 1.001

  // Drag-to-pan, intercepted in the capture phase so that — once zoomed — it runs
  // BEFORE the wrapped content's own gesture (slider drag, A/B flip) and suspends
  // it. At fit (scale 1) it bails immediately, leaving those gestures intact. The
  // minimap / reset chrome (data-zoompan-ui) keep their own handlers.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (e.button !== 0 || !zoomed) return
    if ((e.target as Element).closest('[data-zoompan-ui]')) return
    e.preventDefault()
    e.stopPropagation()
    movedRef.current = false
    setPanning(true)
    setSmooth(false)
    const startX = e.clientX, startY = e.clientY
    const base = { tx: view.tx, ty: view.ty }
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY
      if (Math.abs(dx) + Math.abs(dy) > 3) movedRef.current = true
      setView((v) => {
        const [tx, ty] = clampT(base.tx + dx, base.ty + dy, v.scale)
        return { ...v, tx, ty }
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setPanning(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Swallow the click a pan would otherwise become (so it doesn't flip the A/B
  // view / open anything underneath).
  const onClickCapture = (e: React.MouseEvent) => {
    if (movedRef.current) { e.preventDefault(); e.stopPropagation(); movedRef.current = false }
  }

  // Recenter the view on the point clicked in the minimap, and keep recentring as
  // it's dragged — a click-anywhere + drag pan that mirrors the main image.
  const onMinimapDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setSmooth(true) // glide to the clicked spot rather than jumping
    const recenter = (clientX: number, clientY: number) => {
      const el = mmRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const fx = (clientX - r.left) / r.width
      const fy = (clientY - r.top) / r.height
      setView((v) => {
        const [tx, ty] = clampT(dims.w / 2 - fx * dims.w * v.scale, dims.h / 2 - fy * dims.h * v.scale, v.scale)
        return { ...v, tx, ty }
      })
    }
    recenter(e.clientX, e.clientY)
    const onMove = (ev: PointerEvent) => recenter(ev.clientX, ev.clientY)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const reset = () => { setSmooth(true); setView({ scale: 1, tx: 0, ty: 0 }) }

  const mmH = dims.w > 0 ? Math.round(MM_W * dims.h / dims.w) : 0
  // The fraction of the content currently visible, mapped into minimap px.
  const mmRect = {
    left: (-view.tx / (dims.w * view.scale)) * MM_W,
    top: (-view.ty / (dims.h * view.scale)) * mmH,
    width: MM_W / view.scale,
    height: mmH / view.scale,
  }

  return (
    <div
      ref={viewportRef}
      className={`relative inline-block overflow-hidden ${className ?? ''}`}
      style={{ ...style, touchAction: 'none', cursor: zoomed ? (panning ? 'grabbing' : 'grab') : undefined }}
      onPointerDownCapture={onPointerDownCapture}
      onClickCapture={onClickCapture}
    >
      <div
        style={{
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
          transformOrigin: '0 0',
          transition: smooth ? 'transform 200ms ease-out' : undefined,
        }}
      >
        {children}
      </div>

      {zoomed && dims.w > 0 && (
        // Minimap + reset, bottom-right. data-zoompan-ui so the pan handler above
        // ignores pointer-downs here and lets these drive themselves.
        <div data-zoompan-ui className="absolute bottom-2 right-2 z-10 flex flex-col items-end gap-1.5 select-none">
          <button
            type="button"
            onClick={reset}
            className="flex items-center gap-1 px-2 py-1 rounded bg-black/55 text-white/85 text-[10px] font-medium tracking-wide hover:bg-black/75 transition-colors cursor-pointer"
          >
            <Maximize className="w-3 h-3" />
            Reset view ({view.scale.toFixed(1)}×)
          </button>
          <div
            ref={mmRef}
            onPointerDown={onMinimapDown}
            className="relative rounded border border-white/40 bg-black/40 overflow-hidden cursor-pointer shadow-lg"
            style={{ width: MM_W, height: mmH }}
          >
            {minimapSrc && (
              <img src={minimapSrc} alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill opacity-70" />
            )}
            <div
              className="absolute border-2 border-white/90 bg-white/10 pointer-events-none"
              style={{ left: mmRect.left, top: mmRect.top, width: mmRect.width, height: mmRect.height }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
