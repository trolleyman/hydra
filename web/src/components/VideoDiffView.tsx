// Video (.webm) counterpart to ArtifactsPanel's still-image diff modes. It mirrors
// the same comparison modes (side-by-side / before-after / slider / onion) and
// reuses the shared width-driven sizing, checkerboard and pixel-diff constants, so
// a .webm artifact follows the very same diff-viewer setting as an image one. The
// before/after mode carries the magenta pixel-diff as a "Highlight" tab (the twin
// of the image ABSwitch), so there's no separate difference mode.
//
// The extra problem video has over images is TIME: to compare an animation you have
// to look at the SAME frame on each side. So both <video> elements are driven by one
// shared transport (play/pause + scrubber) and a sync loop keeps the two within a
// frame of each other — see useVideoSync. Only one mode renders at a time, so at most
// two videos are ever attached; each mode registers its <video>s with the controller
// via callback refs and the controller re-seeks them to the shared clock on attach,
// which makes switching modes (a remount) seamless.
//
// WebP animations aren't handled here — the browser plays them in an <img> with no
// seek/sync API, so they can't be frame-aligned; only .webm gets the video viewer.
import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, Pause, Repeat, VideoOff, StepBack, StepForward } from 'lucide-react'
import {
  checkerStyle, IMG_CLASS, OVERLAY_CLASS, TAG_CLASS, makeAuxOpen,
  DIFF_COLOR, DIFF_PIXEL_THRESHOLD,
} from './artifactDiffShared'
import type { ImageDiffMode } from './ArtifactsPanel'

// Extensions routed to the video viewer instead of the image one.
export function isVideoArtifact(name: string): boolean {
  return /\.webm$/i.test(name)
}

// Max drift (seconds) between the two videos before the sync loop nudges the
// follower onto the master's clock. ~1.5 frames at 60fps — tight enough that the
// pair reads as one animation, loose enough not to thrash on normal jitter.
const SYNC_TOL = 0.08
// HTML5 video exposes no frame rate, so a single-frame step needs one supplied. A
// command can declare it in the artifact's <file>.meta sidecar ({"fps": 60}); this
// is the fallback when the sidecar omits it. 30fps is the common case for screen
// recordings/animation artifacts — at worst a missing-sidecar step is a touch
// coarse/fine, which is fine for eyeballing a frame-by-frame diff.
const DEFAULT_FPS = 30
// The Highlight view recomputes a full-frame pixel diff on a timer rather than
// every animation frame; getImageData over a large frame is costly, so ~20fps
// keeps it responsive without pinning a core.
const DIFF_MIN_INTERVAL = 50

// useVideoSync is the shared brain for a before/after video pair: it owns the two
// <video> elements (registered via the attach callback refs), keeps them on a
// common clock, and exposes the transport state/controls the UI binds to. The
// element with the longer duration is the master clock; the other is corrected to
// follow it, so the timeline always spans the full animation.
function useVideoSync(fps?: number | null) {
  const leftEl = useRef<HTMLVideoElement | null>(null)
  const rightEl = useRef<HTMLVideoElement | null>(null)

  // Frame duration for the step buttons: from the sidecar fps when present and
  // sane, else the default. Held in a ref so frameStep stays a stable callback.
  const frameDurRef = useRef(1 / DEFAULT_FPS)
  frameDurRef.current = 1 / (fps && fps > 0 ? fps : DEFAULT_FPS)

  const [playing, setPlaying] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)
  const [loop, setLoop] = useState(true)

  // Refs mirror the state the attach/sync callbacks read, so those stay stable
  // (no re-attach on every render) while still seeing the latest values.
  const playingRef = useRef(playing); playingRef.current = playing
  const rateRef = useRef(rate); rateRef.current = rate
  const loopRef = useRef(loop); loopRef.current = loop
  const currentTimeRef = useRef(0)
  // Mirrors `duration` for the frame-step callback, which clamps to the timeline.
  const durationRef = useRef(0)
  // True while the user drags the scrubber: the sync loop must not fight the drag
  // by writing currentTime back from a video that's mid-seek.
  const scrubbingRef = useRef(false)

  const recompute = useCallback(() => {
    const els = [leftEl.current, rightEl.current]
    let max = 0
    for (const el of els) if (el && Number.isFinite(el.duration)) max = Math.max(max, el.duration)
    durationRef.current = max
    setDuration(max)
  }, [])

  // Bring a freshly-attached element onto the shared clock and play state. Called
  // on attach and again on loadedmetadata (a cached element may already be ready).
  const configure = useCallback((el: HTMLVideoElement) => {
    el.muted = true
    el.playsInline = true
    el.loop = loopRef.current
    el.playbackRate = rateRef.current
    const t = currentTimeRef.current
    try { el.currentTime = Number.isFinite(el.duration) ? Math.min(t, el.duration) : t } catch { /* not seekable yet */ }
    if (playingRef.current) void el.play().catch(() => { /* autoplay blocked; transport can resume */ })
    else el.pause()
  }, [])

  const attachLeft = useCallback((el: HTMLVideoElement | null) => {
    leftEl.current = el
    if (!el) return
    el.onloadedmetadata = () => { recompute(); configure(el) }
    if (el.readyState >= 1) { recompute(); configure(el) }
  }, [recompute, configure])

  const attachRight = useCallback((el: HTMLVideoElement | null) => {
    rightEl.current = el
    if (!el) return
    el.onloadedmetadata = () => { recompute(); configure(el) }
    if (el.readyState >= 1) { recompute(); configure(el) }
  }, [recompute, configure])

  // Sync loop: pick the longer side as master, surface its clock to the scrubber,
  // and pull the follower onto it whenever they drift past SYNC_TOL.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const l = leftEl.current, r = rightEl.current
      const ld = l && Number.isFinite(l.duration) ? l.duration : -1
      const rd = r && Number.isFinite(r.duration) ? r.duration : -1
      const master = l && r ? (ld >= rd ? l : r) : (l ?? r)
      if (master) {
        const t = master.currentTime
        if (!scrubbingRef.current && Math.abs(t - currentTimeRef.current) > 0.04) {
          currentTimeRef.current = t
          setCurrentTime(t)
        }
        const other = master === l ? r : l
        if (other && !scrubbingRef.current) {
          const target = Number.isFinite(other.duration) ? Math.min(t, other.duration) : t
          if (Math.abs(other.currentTime - target) > SYNC_TOL) {
            try { other.currentTime = target } catch { /* ignore transient seek errors */ }
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    for (const el of [leftEl.current, rightEl.current]) {
      if (!el) continue
      if (playing) void el.play().catch(() => {})
      else el.pause()
    }
  }, [playing])

  useEffect(() => {
    for (const el of [leftEl.current, rightEl.current]) if (el) el.playbackRate = rate
  }, [rate])

  useEffect(() => {
    for (const el of [leftEl.current, rightEl.current]) if (el) el.loop = loop
  }, [loop])

  const togglePlay = useCallback(() => setPlaying((p) => !p), [])
  const seek = useCallback((t: number) => {
    currentTimeRef.current = t
    setCurrentTime(t)
    for (const el of [leftEl.current, rightEl.current]) {
      if (!el) continue
      try { el.currentTime = Number.isFinite(el.duration) ? Math.min(t, el.duration) : t } catch { /* ignore */ }
    }
  }, [])
  // Pause playback for the duration of a drag and resume afterwards if it was
  // playing, so the picture holds still under the scrubber instead of running on.
  // We touch the elements directly rather than `playing` so the play/pause button
  // doesn't flicker mid-drag.
  const wasPlayingRef = useRef(false)
  const beginScrub = useCallback(() => {
    scrubbingRef.current = true
    wasPlayingRef.current = playingRef.current
    for (const el of [leftEl.current, rightEl.current]) if (el) el.pause()
  }, [])
  const endScrub = useCallback(() => {
    scrubbingRef.current = false
    if (wasPlayingRef.current) {
      for (const el of [leftEl.current, rightEl.current]) if (el) void el.play().catch(() => {})
    }
  }, [])
  // Nudge the pair one frame forward (+1) or back (-1). Stepping is a paused,
  // examine-this-frame gesture, so it stops playback first, then seeks; the loop
  // keeps the follower aligned to the new clock as usual.
  const frameStep = useCallback((dir: 1 | -1) => {
    setPlaying(false)
    const max = durationRef.current || Infinity
    seek(Math.max(0, Math.min(currentTimeRef.current + dir * frameDurRef.current, max)))
  }, [seek])
  const getLeft = useCallback(() => leftEl.current, [])
  const getRight = useCallback(() => rightEl.current, [])

  return {
    attachLeft, attachRight, getLeft, getRight,
    playing, currentTime, duration, rate, loop,
    togglePlay, seek, setRate, setLoop, beginScrub, endScrub, frameStep,
  }
}

type Controller = ReturnType<typeof useVideoSync>

// A bare attached <video>. muted/playsInline are set both as attributes (so the
// browser's autoplay policy is satisfied at parse time) and again in configure.
function VideoNode({ url, attach, className, style }: {
  url: string
  attach: (el: HTMLVideoElement | null) => void
  className?: string
  style?: React.CSSProperties
}) {
  return <video ref={attach} src={url} muted playsInline preload="auto" className={className} style={style} />
}

// The "this side is absent" placeholder (an added/removed file), matching the
// image viewer's "No image" panel.
function NoVideo({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div style={style} className={`${className ?? ''} select-none flex flex-col items-center justify-center gap-1 bg-gray-50 dark:bg-gray-800/50 text-gray-400 dark:text-gray-500`}>
      <VideoOff className="w-5 h-5" />
      <span className="text-[11px] font-medium">No video</span>
    </div>
  )
}

// A stacked layer for the overlay modes: the attached video when present, else the
// "No video" placeholder filling the same box (keeps the overlay layout intact when
// only one side exists).
function VideoLayer({ url, attach, style }: {
  url?: string | null
  attach: (el: HTMLVideoElement | null) => void
  style?: React.CSSProperties
}) {
  if (url) return <VideoNode url={url} attach={attach} className={OVERLAY_CLASS} style={{ ...checkerStyle, ...style }} />
  return <NoVideo className={OVERLAY_CLASS} style={style} />
}

// A hidden in-flow video that gives the overlay box its intrinsic size (the
// absolute layers can't), mirroring the image modes' hidden <img> sizer. Metadata
// is enough to know the dimensions, so it doesn't autoplay or fully buffer.
function VideoSizer({ url }: { url: string }) {
  return <video src={url} muted preload="metadata" className={`${IMG_CLASS} block`} style={{ visibility: 'hidden' }} />
}

// Side-by-side cell, the video twin of ImageCell. flex-1 so the pair splits the
// tile width evenly and each width-driven (w-full) frame fills its half.
function VideoCell({ url, attach, label }: {
  url?: string | null
  attach: (el: HTMLVideoElement | null) => void
  label: string
}) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">{label}</div>
      {url ? (
        // A plain click opens the .webm in a new tab via the <a>; the frame fills
        // the cell width and its height follows the aspect ratio.
        <a href={url} target="_blank" rel="noreferrer" className="block">
          <VideoNode url={url} attach={attach} className={IMG_CLASS} style={checkerStyle} />
        </a>
      ) : (
        <NoVideo className="w-full h-32 rounded-md border border-gray-200 dark:border-gray-700" />
      )}
    </div>
  )
}

function VideoSideBySide({ controller, left, right }: { controller: Controller; left?: string | null; right?: string | null }) {
  return (
    <div className="flex gap-3 w-full">
      <VideoCell url={left} attach={controller.attachLeft} label="Before" />
      <VideoCell url={right} attach={controller.attachRight} label="After" />
    </div>
  )
}

const tabBtn = (active: boolean, disabled = false) =>
  `text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded transition-colors ${
    disabled ? 'opacity-40 cursor-not-allowed bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500'
      : active ? 'bg-blue-500 text-white cursor-pointer'
        : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 cursor-pointer'
  }`

// Before/After/Highlight switch (twin of the image ABSwitch). Both videos stay
// mounted and in sync; Before/After flip which is visible. Highlight overlays the
// magenta pixel-diff, recomputed continuously as the synced pair plays/scrubs (the
// source videos stay mounted, hidden, under the canvas so they keep decoding).
// Highlight is disabled when only one side exists (an added/removed file — nothing
// to diff). Clicking the frame flips Before↔After (not while Highlight is shown).
function VideoAB({ controller, left, right }: { controller: Controller; left?: string | null; right?: string | null }) {
  const canDiff = !!left && !!right
  const [view, setView] = useState<'before' | 'after' | 'highlight'>('after')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizer = (right ?? left) as string
  const diffActive = view === 'highlight' && canDiff
  // In Highlight (or a one-sided file) show the after frame under the canvas; else
  // the chosen side.
  const showRight = view === 'after' || view === 'highlight'

  useEffect(() => {
    if (!diffActive) return
    let raf = 0
    let cancelled = false
    let lastTs = 0
    const scratch = document.createElement('canvas')
    const draw = (ts: number) => {
      if (cancelled) return
      raf = requestAnimationFrame(draw)
      if (ts - lastTs < DIFF_MIN_INTERVAL) return
      lastTs = ts
      const l = controller.getLeft(), r = controller.getRight(), canvas = canvasRef.current
      if (!l || !r || !canvas) return
      const w = Math.max(l.videoWidth, r.videoWidth), h = Math.max(l.videoHeight, r.videoHeight)
      if (!w || !h) return
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      // After is the base; before goes to a scratch canvas so we can read both and
      // overwrite only the differing pixels with magenta (same scheme as images).
      ctx.clearRect(0, 0, w, h)
      try { ctx.drawImage(r, 0, 0) } catch { return }
      const after = ctx.getImageData(0, 0, w, h)
      scratch.width = w; scratch.height = h
      const sctx = scratch.getContext('2d', { willReadFrequently: true })
      if (!sctx) return
      sctx.clearRect(0, 0, w, h)
      try { sctx.drawImage(l, 0, 0) } catch { return }
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
    }
    raf = requestAnimationFrame(draw)
    return () => { cancelled = true; cancelAnimationFrame(raf) }
  }, [diffActive, controller])

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1 mb-1">
        <button onClick={() => setView('before')} className={tabBtn(view === 'before')}>Before</button>
        <button onClick={() => setView('after')} className={tabBtn(view === 'after')}>After</button>
        <button
          onClick={() => { if (canDiff) setView('highlight') }}
          disabled={!canDiff}
          title={canDiff ? 'Highlight changed pixels in magenta' : 'Needs both a before and after video'}
          className={tabBtn(view === 'highlight', !canDiff)}
        >
          Highlight
        </button>
      </div>
      <div
        className="relative w-full cursor-pointer select-none"
        onClick={() => { if (!diffActive) setView((v) => (v === 'before' ? 'after' : 'before')) }}
        onAuxClick={makeAuxOpen(() => (view === 'before' ? left : right) || sizer)}
      >
        {diffActive && <span className={`${TAG_CLASS} left-1`}>Highlight</span>}
        <VideoSizer url={sizer} />
        <VideoLayer url={right} attach={controller.attachRight} style={{ visibility: showRight ? 'visible' : 'hidden' }} />
        <VideoLayer url={left} attach={controller.attachLeft} style={{ visibility: showRight ? 'hidden' : 'visible' }} />
        {diffActive && <canvas ref={canvasRef} style={checkerStyle} className={OVERLAY_CLASS} />}
      </div>
    </div>
  )
}

// Before/after wipe (twin of SliderCompare): "after" is the base, "before" sits on
// top clipped to the region left of the handle.
function VideoSlider({ controller, left, right }: { controller: Controller; left?: string | null; right?: string | null }) {
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
      className="relative w-full select-none touch-none cursor-ew-resize"
      onPointerDown={(e) => {
        if (e.button !== 0) return
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
      <VideoSizer url={sizer} />
      <VideoLayer url={right} attach={controller.attachRight} />
      <VideoLayer url={left} attach={controller.attachLeft} style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
      <div className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)] pointer-events-none" style={{ left: `${pos}%` }}>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white shadow ring-1 ring-black/30" />
      </div>
    </div>
  )
}

// Onion skin (twin of OnionCompare): "before" base with "after" blended over it at
// a slider-controlled opacity.
function VideoOnion({ controller, left, right }: { controller: Controller; left?: string | null; right?: string | null }) {
  const [opacity, setOpacity] = useState(50)
  const sizer = (right ?? left) as string
  return (
    <div className="min-w-0">
      <div
        className="relative w-full select-none"
        onAuxClick={makeAuxOpen(() => (opacity >= 50 ? right : left) || sizer)}
      >
        <VideoSizer url={sizer} />
        <VideoLayer url={left} attach={controller.attachLeft} />
        <VideoLayer url={right} attach={controller.attachRight} style={{ opacity: opacity / 100 }} />
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Before</span>
        <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="flex-1 accent-blue-500 cursor-pointer" />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">After</span>
      </div>
    </div>
  )
}

// formatTime renders the transport clock compactly: "3.2s" under a minute, "1:05"
// past it.
function formatTime(secs: number): string {
  if (!Number.isFinite(secs)) return '0.0s'
  if (secs < 60) return `${secs.toFixed(1)}s`
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const RATES = [0.25, 0.5, 1, 1.5, 2]

// The shared transport bar under every video comparison: play/pause, a scrubber
// over the (longer) timeline, current/total time, a loop toggle and a speed select.
function VideoTransport({ controller }: { controller: Controller }) {
  const { playing, currentTime, duration, rate, loop, togglePlay, seek, setRate, setLoop, beginScrub, endScrub, frameStep } = controller
  const iconBtn = 'flex items-center justify-center w-7 h-7 rounded-md border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer transition-colors'
  return (
    <div className="flex items-center gap-2 mt-1.5 max-w-full">
      <button onClick={() => frameStep(-1)} className={iconBtn} title="Previous frame">
        <StepBack className="w-3.5 h-3.5" />
      </button>
      <button onClick={togglePlay} className={iconBtn} title={playing ? 'Pause' : 'Play'}>
        {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
      </button>
      <button onClick={() => frameStep(1)} className={iconBtn} title="Next frame">
        <StepForward className="w-3.5 h-3.5" />
      </button>
      <span className="text-[10px] tabular-nums text-gray-500 dark:text-gray-400 w-9 text-right">{formatTime(currentTime)}</span>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.01}
        value={Math.min(currentTime, duration || 0)}
        onChange={(e) => seek(Number(e.target.value))}
        onPointerDown={beginScrub}
        onPointerUp={endScrub}
        className="flex-1 min-w-[80px] accent-blue-500 cursor-pointer"
      />
      <span className="text-[10px] tabular-nums text-gray-400 dark:text-gray-500 w-9">{formatTime(duration)}</span>
      <button onClick={() => setLoop((l) => !l)} className={`${iconBtn} ${loop ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 border-blue-200 dark:border-blue-800' : ''}`} title="Loop">
        <Repeat className="w-3.5 h-3.5" />
      </button>
      <select
        value={rate}
        onChange={(e) => setRate(Number(e.target.value))}
        className="h-7 text-[11px] rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 cursor-pointer px-1"
        title="Playback speed"
      >
        {RATES.map((r) => <option key={r} value={r}>{r}×</option>)}
      </select>
    </div>
  )
}

// VideoDiffView renders a before/after .webm pair in the selected diff mode plus the
// shared transport. The mode set mirrors the image viewer so a .webm artifact honours
// the same diff-viewer setting; the controller (one per file row) keeps the pair in
// lockstep across whichever mode is showing.
export function VideoDiffView({ left, right, mode, fps }: { left?: string | null; right?: string | null; mode: ImageDiffMode; fps?: number | null }) {
  const controller = useVideoSync(fps)
  let body: React.ReactNode
  if (mode === 'side-by-side' || (!left && !right)) body = <VideoSideBySide controller={controller} left={left} right={right} />
  else if (mode === 'ab') body = <VideoAB controller={controller} left={left} right={right} />
  else if (mode === 'slider') body = <VideoSlider controller={controller} left={left} right={right} />
  else body = <VideoOnion controller={controller} left={left} right={right} />
  return (
    <div className="min-w-0">
      {body}
      <VideoTransport controller={controller} />
    </div>
  )
}
