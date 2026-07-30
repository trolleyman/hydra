import { useCallback, useRef, useState } from 'react'
import { useZoomScale } from '../lib/zoomScale'

// The pin layer over a picture: it draws the review comments already anchored to
// this image, and - when arming is on - turns a click into a new point and a drag
// into a new box.
//
// It lives INSIDE the zoom frame's transformed content, so a pin travels and
// magnifies with the pixels it points at rather than sliding off them the moment
// you zoom. What it must not do is grow with them, so each marker divides the
// frame's scale back out (useZoomScale). The layer is sized by its parent
// (`absolute inset-0` over the picture's own box), which is why the parent has to
// hug the image exactly - a layer over a letterboxed container would put every pin
// at the wrong fraction.
//
// Placement is deliberately NOT bare click-to-pin. The picture is already
// draggable (pan) and clickable (the comparator's A/B flip), so an always-armed
// layer would scatter pins during ordinary looking-around. It arms explicitly, and
// while armed it owns the pointer.

/** A pin to draw: normalized position, plus what to label it with. */
export interface ImagePin {
  /** Stable identity for React, and what a click reports back. */
  id: string
  /** Fractions (0..1) of the picture's width/height. */
  x: number
  y: number
  /** Present together when the pin is a box rather than a point. */
  w?: number
  h?: number
  /** What the marker reads - a comment's "#4". */
  label: string
  /** Draws it as still-unpublished (a draft the agent has not been told about). */
  draft?: boolean
  /** Draws it as dealt with, so a worked-through review gets quieter rather than
   *  more cluttered - the same argument OpenComments makes on the agent's side. */
  resolved?: boolean
  /** Drawn as the one being looked at. */
  active?: boolean
}

/** A position the user has just marked out, before it becomes a comment. */
export interface PendingPin {
  x: number
  y: number
  w?: number
  h?: number
}

// Below this a drag is a click that wobbled, not a box. In fractions of the
// picture, so it means the same thing on a thumbnail and on a 4K screenshot.
const MIN_BOX = 0.01

export function ImagePins({ pins, pending, armed, onPlace, onSelect }: {
  pins: ImagePin[]
  /** The pin being composed right now, drawn like a placed one but unnumbered. */
  pending?: PendingPin | null
  /** Whether a press on the picture places a pin. Off, the layer is inert and
   *  passes every gesture through to the picture underneath. */
  armed: boolean
  onPlace?: (pin: PendingPin) => void
  onSelect?: (id: string) => void
}) {
  const scale = useZoomScale()
  const ref = useRef<HTMLDivElement>(null)
  // The drag in progress, as (start, current) in fractions. Null between drags.
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

  // Where a pointer event falls on the picture, 0..1. Read off the layer's own box,
  // which is the picture's box - so this is correct at any zoom without having to
  // know the zoom, since the box the browser reports is already transformed.
  const fractionAt = useCallback((e: React.PointerEvent): { x: number; y: number } | null => {
    const box = ref.current?.getBoundingClientRect()
    if (!box || box.width <= 0 || box.height <= 0) return null
    return {
      x: clamp01((e.clientX - box.left) / box.width),
      y: clamp01((e.clientY - box.top) / box.height),
    }
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!armed || e.button !== 0) return
    const at = fractionAt(e)
    if (!at) return
    // Claim the gesture before ZoomPan's capture-phase pan handler sees it: while
    // armed, a drag draws a box rather than panning the picture.
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    setDrag({ x0: at.x, y0: at.y, x1: at.x, y1: at.y })
  }, [armed, fractionAt])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag) return
    const at = fractionAt(e)
    if (!at) return
    setDrag((d) => (d ? { ...d, x1: at.x, y1: at.y } : d))
  }, [drag, fractionAt])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!drag) return
    e.stopPropagation()
    setDrag(null)
    const w = Math.abs(drag.x1 - drag.x0)
    const h = Math.abs(drag.y1 - drag.y0)
    // A drag too small to have been meant as a box is the click it actually was.
    if (w < MIN_BOX || h < MIN_BOX) {
      onPlace?.({ x: drag.x0, y: drag.y0 })
      return
    }
    onPlace?.({ x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w, h })
  }, [drag, onPlace])

  const live = drag
    ? {
        x: Math.min(drag.x0, drag.x1),
        y: Math.min(drag.y0, drag.y1),
        w: Math.abs(drag.x1 - drag.x0),
        h: Math.abs(drag.y1 - drag.y0),
      }
    : null

  return (
    <div
      ref={ref}
      // Inert unless armed, so an unarmed layer cannot swallow a pan or a click on
      // the picture. Individual markers re-enable their own pointer events below.
      className={`absolute inset-0 ${armed ? 'cursor-crosshair' : 'pointer-events-none'}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      {pins.map((p) => (
        <PinMarker key={p.id} pin={p} scale={scale} onSelect={onSelect} />
      ))}
      {pending && <PinMarker pin={{ ...pending, id: '__pending', label: '', draft: true, active: true }} scale={scale} />}
      {live && live.w >= MIN_BOX && live.h >= MIN_BOX && (
        <div
          className="absolute border-2 border-blue-400 bg-blue-400/15 pointer-events-none"
          style={{
            left: `${live.x * 100}%`,
            top: `${live.y * 100}%`,
            width: `${live.w * 100}%`,
            height: `${live.h * 100}%`,
            borderWidth: 2 / scale,
          }}
        />
      )}
    </div>
  )
}

// One marker. A box draws its region and hangs its number off the top-left corner;
// a point is just the number. Both counter-scale so they stay legible at any
// magnification - the pin marks a place, and a place has no size.
function PinMarker({ pin, scale, onSelect }: { pin: ImagePin; scale: number; onSelect?: (id: string) => void }) {
  const isBox = !!(pin.w && pin.h)
  const tone = pin.resolved
    ? 'bg-gray-500/80 text-white/70'
    : pin.draft
      ? 'bg-amber-500 text-white'
      : 'bg-blue-600 text-white'
  const ring = pin.active ? 'ring-2 ring-white' : 'ring-1 ring-black/30'
  return (
    <>
      {isBox && (
        <div
          className={`absolute pointer-events-none ${pin.resolved ? 'border-gray-400/70' : pin.draft ? 'border-amber-400' : 'border-blue-500'}`}
          style={{
            left: `${pin.x * 100}%`,
            top: `${pin.y * 100}%`,
            width: `${(pin.w ?? 0) * 100}%`,
            height: `${(pin.h ?? 0) * 100}%`,
            borderStyle: 'solid',
            borderWidth: 2 / scale,
            background: pin.resolved ? 'transparent' : 'rgba(59,130,246,0.12)',
          }}
        />
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); if (onSelect) onSelect(pin.id) }}
        onPointerDown={(e) => e.stopPropagation()}
        // The marker sits ON the point, so it is centred on it rather than hung
        // below-right of it: a pin whose tip is not where you clicked is a pin that
        // lies about where the remark was made.
        style={{
          left: `${pin.x * 100}%`,
          top: `${pin.y * 100}%`,
          transform: `translate(-50%, -50%) scale(${1 / scale})`,
          transformOrigin: 'center',
        }}
        className={`absolute pointer-events-auto flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-2xs font-semibold tabular-nums shadow-md ${tone} ${ring} ${onSelect ? 'cursor-pointer' : 'cursor-default'}`}
        aria-label={pin.label ? `Comment ${pin.label}` : 'New comment'}
      >
        {pin.label || <span className="w-1.5 h-1.5 rounded-full bg-white" />}
      </button>
    </>
  )
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
