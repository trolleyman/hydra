import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize } from 'lucide-react'

// How far past fit you can magnify (8× the fit size). Enough to read individual
// pixels of a downscaled screenshot without letting the image run away entirely.
const MAX_SCALE = 8
// Minimap width in px on a roomy frame; its height follows the content's aspect
// ratio. On small (phone) frames it caps at a quarter of the frame's width instead
// so it doesn't crowd the image it maps - and since the minimap shares the frame's
// aspect ratio, that same cap bounds its height to a quarter of the frame's too.
const MM_W = 140

// How far along the grow one axis of the frame is: 0 at the content's fit size,
// 1 once it has expanded to fill the box it may grow into. The frame's slide off
// centre (fx/fy) is proportional to this - see relaxF.
function growProgress(availLen: number, contentLen: number, vpLen: number) {
  if (availLen <= contentLen) return 0
  return Math.min(1, Math.max(0, (vpLen - contentLen) / (availLen - contentLen)))
}

// Measure an element's rendered (layout) size and keep it fresh across image load
// + window resize. A CSS transform doesn't change layout size, so a transformed
// element still reports its untransformed (fit) size here.
function useMeasure(ref: React.RefObject<HTMLElement | null>) {
  const [d, setD] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setD({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [ref])
  return d
}

// ZoomPan wraps a piece of lightbox content - a plain image OR a before/after
// comparator - and layers magnify + pan on top of it, mode-agnostically:
//
//   * the scroll-wheel zooms toward the cursor (fit → up to MAX_SCALE),
//   * once zoomed in, dragging pans (at fit the wrapped content keeps its own
//     click / slider / onion gestures - pan only takes over above 1×), and
//   * a live minimap + a "Reset view" button appear in the bottom-right corner
//     while zoomed, the minimap draggable to pan.
//
// Panning is clamped so the magnified content always covers the frame - you can
// never drag it partly out of view. The wrapper sizes itself to the content at
// rest (inline-block) and clips the magnified content to that box, so the
// surrounding lightbox chrome (caption, mode controls) is unaffected. Remounting
// it (the lightbox keys its content by index) resets the zoom on navigation.
//
// GROW MODE (maxWidth + maxHeight given): the frame no longer stays locked to the
// content's fit size - as you zoom, it expands into the empty lightbox space up to
// maxWidth × maxHeight. This matters for off-square images: a very vertical shot
// fits tall-and-narrow, wasting the horizontal space, so a plain scale-in-place
// would only ever show a thin sliver. Letting the frame widen with zoom reveals the
// image's full width at magnification instead. The content's own fit size (cw × ch)
// and the growing viewport (vp) are tracked separately so the pan clamp + minimap
// stay correct; at fit the frame still hugs the content exactly (shadow/rounding
// unchanged). Without the props the frame stays content-sized (the diff comparator,
// whose width is externally driven, opts out this way).
export function ZoomPan({ children, minimapSrc, className, style, maxWidth, maxHeight, onVerticalSlide }: {
  children: React.ReactNode
  // The image shown inside the minimap (a representative side for a diff pair).
  // Omitted → the minimap shows just the viewport rectangle on a neutral panel.
  minimapSrc?: string | null
  className?: string
  style?: React.CSSProperties
  // CSS caps the frame may grow to while zoomed (e.g. '90vw' / '85vh'). Both must be
  // set to enable grow mode; omit to keep the frame locked to the content's fit size.
  maxWidth?: string
  maxHeight?: string
  // Reports the frame's vertical grow-slide (fy, px) whenever it changes, plus the CSS
  // transition to match. In grow mode the frame slides via a CSS transform to keep the
  // cursor point fixed - but a transform doesn't move the element's layout box, so any
  // chrome laid out BELOW the frame (the lightbox caption) keeps its old position and
  // detaches: the image slides down over it (zoom near the top) or up away from it
  // (zoom near the bottom). The caller shifts that chrome by the same fy to stay glued.
  // Horizontal slide isn't reported - a centred caption doesn't detach vertically from
  // it. Must be a stable identity (useCallback) so it doesn't re-fire every render.
  onVerticalSlide?: (fy: number, transition: string | undefined) => void
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const availRef = useRef<HTMLDivElement>(null)
  const mmRef = useRef<HTMLDivElement>(null)
  // scale + translation (px, content top-left relative to the frame) as one unit
  // so a wheel zoom can move all three together (keep the cursor point fixed).
  // fx/fy is a separate GROW-phase offset that slides the (still-hugging) frame
  // within its available slack so the cursor point stays fixed before there is any
  // room to pan - see clampF / zoomAt. In locked mode fx/fy stay 0.
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0, fx: 0, fy: 0 })
  const [panning, setPanning] = useState(false)
  // How the next transform change should move: 'none' tracks the pointer 1:1 - used
  // for both drag-pan (must stay glued to the cursor) AND wheel-zoom, which is direct
  // manipulation too: an eased wheel step looks smooth on a single notch but on a
  // fast scroll the overlapping eases fight the frame's grow/pan and read as a
  // "drifts right then back left" wobble, so the zoom tracks the wheel exactly
  // instead. 'glide' is a longer ease reserved for go-there jumps (minimap click,
  // Reset view), where a single deliberate move benefits from easing.
  const [transition, setTransition] = useState<'none' | 'glide'>('none')
  // Set while a drag actually moved, so the trailing click is swallowed (a pan
  // shouldn't also flip the A/B view or open anything).
  const movedRef = useRef(false)
  // Active touch points (pointerId → position) + the live pinch, if two fingers
  // are down: the previous frame's finger distance and midpoint, which each move
  // diffs against to zoom toward / pan with the fingers. See the pinch effect.
  const touchesRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ dist: number; mx: number; my: number } | null>(null)
  // Cancels an in-flight single-finger pan (set by the pan handler below) - the
  // second finger of a pinch must kill it, or the two gestures fight over tx/ty.
  const cancelPanRef = useRef<(() => void) | null>(null)

  const grow = !!(maxWidth && maxHeight)
  // The content's fit size (cw × ch). In grow mode we measure the (inline-block)
  // content wrapper directly, since the frame is now a different, growing box; in
  // the locked mode the frame hugs the content so measuring the frame is equivalent
  // (and matches the pre-grow behaviour exactly).
  const frameDims = useMeasure(viewportRef)
  const contentDims = useMeasure(contentRef)
  const availDims = useMeasure(availRef)
  const content = grow ? contentDims : frameDims
  // The box the frame may grow into. Locked mode never grows, so it equals content.
  const avail = grow ? availDims : content

  // The visible viewport (frame) size at scale s: the scaled content, capped by the
  // available box. Never below the content's fit size at s = 1, so at rest the frame
  // hugs the content. Content always covers it (vp ≤ content*s), so the cover clamp
  // below has a valid range.
  const vpAt = useCallback((s: number) => ({
    w: Math.min(content.w * s, avail.w),
    h: Math.min(content.h * s, avail.h),
  }), [content.w, content.h, avail.w, avail.h])
  const vp = vpAt(view.scale)

  // Clamp a translation so the scaled content always covers the frame - no empty
  // gutter from over-panning. At scale 1 (frame == content) both bounds collapse to 0.
  const clampT = useCallback((nx: number, ny: number, s: number): [number, number] => {
    if (!content.w || !content.h) return [0, 0]
    const { w: vw, h: vh } = vpAt(s)
    const minX = vw - content.w * s
    const minY = vh - content.h * s
    return [Math.min(0, Math.max(minX, nx)), Math.min(0, Math.max(minY, ny))]
  }, [content.w, content.h, vpAt])

  // Clamp the GROW-phase frame offset to the slack between the frame and the box it
  // may grow into (avail - vp), split evenly either side of centre. While an axis is
  // still growing there is slack, so the frame can slide toward the cursor; once it
  // caps (vp == avail) the slack is 0, fx/fy collapse to 0, and the pan (tx/ty) takes
  // over. Locked mode (no grow) never slides.
  const clampF = useCallback((fx: number, fy: number, s: number): [number, number] => {
    if (!grow || !content.w || !content.h) return [0, 0]
    const { w: vw, h: vh } = vpAt(s)
    const sx = Math.max(0, avail.w - vw) / 2
    const sy = Math.max(0, avail.h - vh) / 2
    return [Math.max(-sx, Math.min(sx, fx)), Math.max(-sy, Math.min(sy, fy))]
  }, [grow, content.w, content.h, avail.w, avail.h, vpAt])

  // Shrink the frame's slide back toward centre as the frame shrinks, retracing the
  // way it came. Used INSTEAD of the cursor-anchored slide whenever the frame is
  // getting smaller (see zoomAt).
  //
  // Anchoring the cursor is the right feel on the way IN, but wrong on the way OUT.
  // Throughout the grow phase the frame holds the whole image (content*s == vp), so
  // the slide isn't revealing anything - it's shoving the entire picture sideways.
  // Anchor a zoom-out to a cursor that's off to one side and the image walks that
  // way instead of settling back to the middle; worse, it can slide out from under
  // the cursor entirely, and since the wheel only reaches the frame it's actually
  // over, the zoom-out strands there - parked to one side at partial zoom. That's the
  // "zooms out to the left/right, not the middle" bug.
  //
  // For a fixed anchor the slide is proportional to the grow progress (fx = (px -
  // w/2)*(1 - s), and progress ∝ s - 1), so rescaling fx by the progress ratio walks
  // back down exactly the path a zoom-in drew - and lands at 0, dead centre, at fit.
  const relaxF = useCallback((v: { fx: number; fy: number; scale: number }, ns: number): [number, number] => {
    const before = vpAt(v.scale)
    const after = vpAt(ns)
    const ratio = (availLen: number, contentLen: number, b: number, a: number) => {
      const p0 = growProgress(availLen, contentLen, b)
      return p0 > 0 ? growProgress(availLen, contentLen, a) / p0 : 0
    }
    return [
      v.fx * ratio(avail.w, content.w, before.w, after.w),
      v.fy * ratio(avail.h, content.h, before.h, after.h),
    ]
  }, [avail.w, avail.h, content.w, content.h, vpAt])

  // Zoom by `factor` keeping the content point under (cx, cy) - coords relative to
  // the frame's top-left - fixed, so the image grows toward the cursor.
  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    setView((v) => {
      const ns = Math.min(MAX_SCALE, Math.max(1, v.scale * factor))
      if (ns === v.scale) return v
      // Clamp the base first so the kept-fixed point is measured from where the
      // content actually sits (matters right after a resize).
      const [bx, by] = clampT(v.tx, v.ty, v.scale)
      const px = (cx - bx) / v.scale
      const py = (cy - by) / v.scale
      const [ntx, nty] = clampT(cx - px * ns, cy - py * ns, ns)
      // Grow phase: the pan can't move (content still fills the frame, so tx/ty are
      // pinned to 0), so instead slide the frame toward the cursor to keep (px, py)
      // fixed. Without this the image zooms toward its centre while growing and only
      // snaps to the cursor once it caps - the little "drifts one way then back"
      // wobble. Screen-x of a content point is C + fx + (px - w/2)*scale, so holding
      // it fixed across scale -> ns gives dfx = (px - w/2)*(scale - ns) (same for y).
      //
      // Zooming OUT retraces that slide back to centre instead of anchoring the
      // cursor - see relaxF for why the two directions differ.
      const [nfx, nfy] = ns < v.scale
        ? clampF(...relaxF(v, ns), ns)
        : clampF(
            v.fx + (px - content.w / 2) * (v.scale - ns),
            v.fy + (py - content.h / 2) * (v.scale - ns),
            ns,
          )
      return { scale: ns, tx: ntx, ty: nty, fx: nfx, fy: nfy }
    })
  }, [clampT, clampF, relaxF, content.w, content.h])

  // Wheel must be a non-passive native listener so preventDefault can stop the
  // page/scroll from also reacting; React's synthetic onWheel can't guarantee that.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setTransition('none')
      const r = el.getBoundingClientRect()
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // Two-finger pinch: the touch counterpart of the wheel (which has no touch
  // equivalent - touchAction: 'none' on the frame also disables the browser's own
  // pinch there). Touch points are collected in the capture-phase pointerdown
  // below; once two are down, each move zooms by the finger-distance ratio toward
  // the midpoint (zoomAt handles the clamps + grow mode) and pans with the
  // midpoint's travel, so the image tracks the fingers like any native viewer.
  // Listeners live on window for the whole mount: they no-op unless a tracked
  // touch moves, and gestures must survive fingers wandering off the frame.
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const touches = touchesRef.current
      if (ev.pointerType !== 'touch' || !touches.has(ev.pointerId)) return
      touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
      const p = pinchRef.current
      const el = viewportRef.current
      if (!p || touches.size < 2 || !el) return
      const [a, b] = [...touches.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const r = el.getBoundingClientRect()
      if (p.dist > 0 && dist > 0) zoomAt(mx - r.left, my - r.top, dist / p.dist)
      // Follow the midpoint: functional update, so it composes with the zoomAt
      // update above in the same batch (v is already the zoomed view).
      const dmx = mx - p.mx
      const dmy = my - p.my
      if (dmx || dmy) {
        setView((v) => {
          const [ntx, nty] = clampT(v.tx + dmx, v.ty + dmy, v.scale)
          return { ...v, tx: ntx, ty: nty }
        })
      }
      pinchRef.current = { dist, mx, my }
    }
    // A lifted or cancelled finger leaves the pinch; the survivor doesn't resume
    // a pan (its start state is long stale) - a fresh touch starts one cleanly.
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerType !== 'touch') return
      touchesRef.current.delete(ev.pointerId)
      if (touchesRef.current.size < 2) pinchRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [zoomAt, clampT])

  // The stored translation, re-clamped for the CURRENT content/available size, so a
  // window resize (which changes the cover bounds) can't leave a stale gutter. Pure
  // derivation - used for the transform, the minimap, and as the base for gestures -
  // rather than a resize effect that writes state back.
  const [tx, ty] = clampT(view.tx, view.ty, view.scale)
  // Same re-clamp for the grow-phase frame offset, so a window resize (which changes
  // the slack) can't leave the frame parked off-centre with no room for it.
  const [fx, fy] = clampF(view.fx, view.fy, view.scale)

  const zoomed = view.scale > 1.001

  // Drag-to-pan, intercepted in the capture phase so that - once zoomed - it runs
  // BEFORE the wrapped content's own gesture (slider drag, A/B flip) and suspends
  // it. At fit (scale 1) it bails immediately, leaving those gestures intact. The
  // minimap / reset chrome (data-zoompan-ui) keep their own handlers. Touch points
  // are ALSO tracked here (before the zoomed gate, so a pinch can start at fit);
  // the second finger forms a pinch, kills any single-finger pan, and suspends the
  // inner gestures itself.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') {
      touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touchesRef.current.size === 2) {
        const [a, b] = [...touchesRef.current.values()]
        pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
        cancelPanRef.current?.()
        movedRef.current = true // a pinch is never also a click
        setTransition('none')
        e.preventDefault()
        e.stopPropagation()
        return
      }
    }
    if (e.button !== 0 || !zoomed) return
    // Let controls that own their own horizontal drag through even while zoomed - the
    // before/after slider divider and the onion opacity range (both data-no-tile-drag /
    // <input>) keep working; only "empty" image area pans. Plus our own minimap chrome.
    if ((e.target as Element).closest('[data-zoompan-ui], input, [data-no-tile-drag]')) return
    e.preventDefault()
    e.stopPropagation()
    movedRef.current = false
    setPanning(true)
    setTransition('none')
    const startX = e.clientX, startY = e.clientY
    const id = e.pointerId
    const base = { tx, ty }
    const onMove = (ev: PointerEvent) => {
      // Only this pan's own pointer drives it - another finger landing elsewhere
      // (or forming a pinch) must not yank the view around.
      if (ev.pointerId !== id) return
      const dx = ev.clientX - startX, dy = ev.clientY - startY
      if (Math.abs(dx) + Math.abs(dy) > 3) movedRef.current = true
      setView((v) => {
        const [ntx, nty] = clampT(base.tx + dx, base.ty + dy, v.scale)
        return { ...v, tx: ntx, ty: nty }
      })
    }
    // pointercancel too: if the browser takes the pointer away mid-pan the drag
    // must still end, or the listeners leak and the view sticks in panning mode.
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      stop()
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      cancelPanRef.current = null
      setPanning(false)
    }
    cancelPanRef.current = stop
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Swallow the click a pan would otherwise become (so it doesn't flip the A/B
  // view / open anything underneath).
  const onClickCapture = (e: React.MouseEvent) => {
    if (movedRef.current) { e.preventDefault(); e.stopPropagation(); movedRef.current = false }
  }

  // Recenter the view on the point clicked in the minimap, and keep recentring as
  // it's dragged - a click-anywhere + drag pan that mirrors the main image. The
  // initial press GLIDES to the clicked spot (a deliberate go-there jump), but the
  // moment the pointer starts dragging the ease switches off: an eased recenter
  // restarted on every move would trail the pointer by its whole 200ms curve, so
  // the view would chase where the cursor used to be instead of tracking it.
  const onMinimapDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setTransition('glide') // glide to the clicked spot rather than jumping
    const recenter = (clientX: number, clientY: number) => {
      const el = mmRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const fx = (clientX - r.left) / r.width
      const fy = (clientY - r.top) / r.height
      setView((v) => {
        const { w: vw, h: vh } = vpAt(v.scale)
        const [ntx, nty] = clampT(vw / 2 - fx * content.w * v.scale, vh / 2 - fy * content.h * v.scale, v.scale)
        return { ...v, tx: ntx, ty: nty }
      })
    }
    recenter(e.clientX, e.clientY)
    const startX = e.clientX, startY = e.clientY
    const id = e.pointerId
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return // another finger's moves aren't this drag
      // Ignore the sub-pixel jitter a plain click can emit - a real drag switches
      // to 1:1 tracking, a click keeps its glide.
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) <= 2) return
      setTransition('none') // dragging now - track the pointer 1:1
      recenter(ev.clientX, ev.clientY)
    }
    // pointercancel too, so an interrupted pointer never leaks the listeners.
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const reset = () => { setTransition('glide'); setView({ scale: 1, tx: 0, ty: 0, fx: 0, fy: 0 }) }

  // The CSS ease matching the current movement kind - applied to the content
  // transform and mirrored onto the minimap's viewport rect so they move together.
  const transitionMs = transition === 'glide' ? 200 : 0
  const transitionCss = transitionMs > 0 ? `${transitionMs}ms ease-out` : undefined

  // Keep any below-the-frame chrome (the lightbox caption) glued to the frame's
  // visual bottom by reporting the vertical slide - see onVerticalSlide. Layout
  // effect so the caption shifts in the same paint as the frame, never a frame late.
  useLayoutEffect(() => {
    onVerticalSlide?.(fy, transitionCss)
  }, [fy, transitionCss, onVerticalSlide])
  // Reset the caller's shift when this frame unmounts (navigating to an image that
  // renders a different frame, or closing), so a leftover slide can't strand it.
  useEffect(() => () => onVerticalSlide?.(0, undefined), [onVerticalSlide])

  const mmW = content.w > 0 ? Math.min(MM_W, Math.round(content.w / 4)) : MM_W
  const mmH = content.w > 0 ? Math.round(mmW * content.h / content.w) : 0
  // The fraction of the content currently visible, mapped into minimap px.
  const mmRect = {
    left: (-tx / (content.w * view.scale)) * mmW,
    top: (-ty / (content.h * view.scale)) * mmH,
    width: (vp.w / (content.w * view.scale)) * mmW,
    height: (vp.h / (content.h * view.scale)) * mmH,
  }

  // In grow mode the frame is a sized, block-level box the content overflows and is
  // clipped by; its size eases along with the zoom so growing feels of a piece with
  // the magnification. In locked mode it stays inline-block, hugging the content.
  const frameSizeStyle: React.CSSProperties = grow && content.w > 0
    ? {
        width: vp.w,
        height: vp.h,
        // Slide toward the cursor during the grow phase (fx/fy). Eased with the same
        // timing as the size + the content transform so the whole zoom moves as one.
        transform: `translate(${fx}px, ${fy}px)`,
        transition: transitionCss && `width ${transitionCss}, height ${transitionCss}, transform ${transitionCss}`,
      }
    : {}

  return (
    <>
      {/* An invisible probe sized to the caps, so we can read the grow ceiling in px
          (it tracks vw/vh + window resize). Fixed + hidden → no layout footprint. */}
      {grow && (
        <div
          ref={availRef}
          aria-hidden
          style={{ position: 'fixed', top: 0, left: 0, width: maxWidth, height: maxHeight, visibility: 'hidden', pointerEvents: 'none' }}
        />
      )}
      <div
        ref={viewportRef}
        className={`relative overflow-hidden ${grow ? 'block' : 'inline-block'} ${className ?? ''}`}
        style={{ ...style, ...frameSizeStyle, touchAction: 'none', cursor: zoomed ? (panning ? 'grabbing' : 'grab') : undefined }}
        onPointerDownCapture={onPointerDownCapture}
        onClickCapture={onClickCapture}
      >
        <div
          ref={contentRef}
          className={grow ? 'inline-block' : undefined}
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${view.scale})`,
            transformOrigin: '0 0',
            transition: transitionCss && `transform ${transitionCss}`,
          }}
        >
          {children}
        </div>

      </div>

      {/* Minimap + reset, pinned to the bottom-right of the SCREEN (portaled to
          <body>) rather than to the frame. The frame grows as you zoom, so anchoring
          the controls to it made them drift outward with each notch - jarring. Fixed
          screen placement keeps them put. It has to be a portal, not just position:
          fixed here: the lightbox's animate-in leaves a transform on an ancestor,
          which would capture a fixed descendant and reintroduce the drift. Living
          outside the frame also means the frame's capture-phase pan handler never
          sees these pointer-downs, so they drive themselves cleanly (the
          data-zoompan-ui marker is kept as a belt-and-braces guard). */}
      {zoomed && content.w > 0 && createPortal(
        <div data-zoompan-ui className="fixed bottom-4 right-4 z-[101] flex flex-col items-end gap-1.5 select-none">
          <button
            type="button"
            onClick={reset}
            className="flex items-center gap-1 px-2 py-1 rounded bg-black/55 text-white/85 text-3xs font-medium tracking-wide hover:bg-black/75 transition-colors cursor-pointer"
          >
            <Maximize className="w-3 h-3" />
            Reset view ({view.scale.toFixed(1)}×)
          </button>
          <div
            ref={mmRef}
            data-zoompan-minimap
            onPointerDown={onMinimapDown}
            className="relative rounded border border-white/40 bg-black/40 overflow-hidden cursor-pointer shadow-lg"
            style={{ width: mmW, height: mmH }}
          >
            {minimapSrc && (
              <img src={minimapSrc} alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill opacity-70" />
            )}
            <div
              className="absolute border-2 border-white/90 bg-white/10 pointer-events-none"
              style={{ left: mmRect.left, top: mmRect.top, width: mmRect.width, height: mmRect.height, transition: transitionCss && `all ${transitionCss}` }}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
