import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronLeft, ChevronRight, SquarePlus, SquareMinus, SquareDot, FileArchive, FileText, File as FileIcon, Film } from 'lucide-react'
import type { ImageDiffMode } from './ArtifactImageDiff'
import { LightboxDiff, LightboxDiffControls } from './LightboxDiff'
import { LightboxFile, LightboxPdf, LightboxText, LightboxVideo } from './LightboxViewers'
import { makeAuxOpen } from './artifactDiffShared'
import { CheckerLayer } from './CheckerLayer'
import { applyABShortcut } from '../lib/abShortcuts'
import { ZoomPan } from './ZoomPan'
import { Tooltip } from './Tooltip'
import type { FileKind } from '../lib/fileKind'
import {
  canFlip, findLightboxOrigin, mediaRectOf, playFlip, rectOf,
  whenMediaLaidOut, FLIP_NAV_MS, FLIP_OPEN_MS, LIGHTBOX_MEDIA_CLASS, type Rect,
} from '../lib/lightboxFlip'
import { discoverMediaSize, rememberMediaSize } from '../lib/mediaSize'
import { logicalSize } from '../lib/imageDensity'

export interface LightboxItem {
  url: string
  filename: string
  /** File size in bytes, shown in the caption. Omit/0 when unknown (e.g. an
   *  image referenced only by path), in which case the size is left out. */
  size: number
  /** How to show this entry. Omitted → 'image', so a caller that only ever has
   *  pictures needs no change; anything else picks one of the viewers in
   *  LightboxViewers (video, PDF, text, or the download card for a binary the
   *  browser can't render). Usually lib/fileKind's verdict on the filename. */
  kind?: FileKind
  /** When set, the lightbox renders a fullscreen before/after comparator (with mode
   *  controls - toggle, slider, onion) for this entry instead of a single file. The
   *  diff viewer supplies this; `url` is still used for the edge previews and caption.
   *  Honoured for 'image' and 'video' (the two kinds the artifact pipeline actually
   *  compares); the other viewers use it only for their per-side download links. */
  diff?: { left?: string | null; right?: string | null; mode: ImageDiffMode }
  /** Frame rate for a video entry's single-frame step buttons, from the artifact's
   *  .meta sidecar. Ignored by every other kind. */
  fps?: number | null
  /** Pixel density (device-scale factor) the media was captured at, surfaced in the
   *  caption next to the dimensions (e.g. "780 × 1688 @2×"). Omit/1 → not shown. */
  dpi?: number
  /** Natural pixel size, when known ahead of load (artifact entries carry it in
   *  their metadata). This is what lets the picture's BOX be reserved before the
   *  file has loaded - it is set on the <img> as width/height, so the browser lays
   *  the media out at its final size on the first frame instead of at nothing and
   *  then popping open around it. It also seeds the caption's "W × H" and the diff
   *  comparator's aspect ratio, so neither collapses and re-measures per image.
   *  Omit and the lightbox falls back to lib/mediaSize (a size remembered from an
   *  earlier load, or read off a copy still decoded in the page) and, failing that,
   *  to measuring on load as it always did. */
  width?: number
  height?: number
  /** How this artifact changed vs its counterpart (added/removed/modified), when
   *  known - shown as a small +/−/• glyph right after the filename in the caption,
   *  mirroring the diff grid's per-file badge. Omit for plain items with no diff
   *  context (e.g. the repository browser). */
  changeType?: 'added' | 'removed' | 'modified'
}

// A small +/−/• glyph marking whether the artifact was added, removed, or modified
// relative to its counterpart - mirrors the diff grid's ArtifactChangeIcon, but tuned
// for the lightbox's always-dark backdrop (the brighter dark-theme colors).
function ChangeTypeGlyph({ type }: { type: NonNullable<LightboxItem['changeType']> }) {
  const cls = 'w-3.5 h-3.5 shrink-0'
  switch (type) {
    case 'added':
      return <SquarePlus className={`${cls} text-green-400`} />
    case 'removed':
      return <SquareMinus className={`${cls} text-red-400`} />
    case 'modified':
      return <SquareDot className={`${cls} text-amber-400`} />
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// An entry with no explicit kind is a picture - every caller predates the other
// viewers, and a picture is what the lightbox has always shown.
function kindOf(item: LightboxItem | undefined): FileKind {
  return item?.kind ?? 'image'
}

// Whether this kind is shown as a picture that can be zoomed, flown between
// thumbnails and previewed at the edges. The rest are panels: they size themselves,
// scroll their own content, and are too abstract to preview as a sliver.
function isPictorial(kind: FileKind): boolean {
  return kind === 'image' || kind === 'video'
}

// The mark standing in for a non-pictorial entry - in the edge previews, where
// there is no frame to show. Deliberately the same icons the tiles in the page use,
// so the sliver at the edge reads as the same file you clicked past.
function KindIcon({ kind, className }: { kind: FileKind; className: string }) {
  switch (kind) {
    case 'video':
      return <Film className={className} />
    case 'text':
      return <FileText className={className} />
    case 'binary':
      return <FileArchive className={className} />
    default:
      return <FileIcon className={className} />
  }
}

// Checkerboard behind pictures so transparent PNGs read as transparent rather than
// blending into the dark backdrop. Shared by the main image and the side previews.
const CHECKER = 'repeating-conic-gradient(#bfbfbf 0% 25%, #f5f5f5 0% 50%) 0 0 / 20px 20px'

// The lightbox's checkerboard, as a layer behind the picture (see CheckerLayer for
// why it isn't a background on the <img>). It carries the chrome's fade so a picture
// flying out of a thumbnail that had no checkerboard doesn't snap one on as it lands.
function LightboxChecker({ className }: { className?: string }) {
  return <CheckerLayer className={className} style={{ background: CHECKER }} />
}

// The resting opacity of an edge preview (matches the `opacity-40` on it below).
// A picture flying in from the edge fades up from it, and the one it replaces fades
// down to it as it flies out there.
const PEEK_OPACITY = 0.4

// How the picture shown for the current index should arrive.
//
//   flip  - it is already on screen somewhere (a thumbnail in the page on open, or
//           the sibling peeking in at the edge on ←/→) and travels from that exact
//           box to its place in the lightbox. `outgoing` is the counter-flight: on
//           navigation the picture being replaced flies out to the edge preview it
//           becomes, so the pair swaps places rather than one blinking out.
//   slide - nothing to fly from (no thumbnail on screen, no edge previews below
//           `lg`, or reduced motion): the old directional slide+fade.
type Entrance =
  | { kind: 'flip'; from: Rect; outgoing?: { side: 'prev' | 'next'; from: Rect } }
  | { kind: 'slide'; dir: -1 | 0 | 1 }

// A Slack-style fullscreen file viewer: a blurred dark backdrop with the file
// centered, optional prev/next arrows when there's more than one, and keyboard
// support (Esc closes, ←/→ navigate). Clicking the backdrop closes it.
//
// "File", not "image": a gallery is whatever a surface has to show - the artifacts
// grid mixes screenshots, recordings, PDFs and .apks in one strip - so each entry
// picks its viewer from its `kind` (see LightboxViewers). Only pictures (and video)
// get the zoom frame and the travelling-thumbnail flights; the rest are panels that
// simply fade in. What every kind shares is the caption, the navigation and the
// promise that clicking a file leads SOMEWHERE.
export function Lightbox({
  items,
  index,
  origin,
  onIndexChange,
  onClose,
}: {
  items: LightboxItem[]
  index: number
  // The thumbnail the lightbox was opened from, when the opener supplied one - the
  // picture flies out of its box on open and back into it on close. See lightboxFlip.
  origin?: Element | null
  onIndexChange: (i: number) => void
  onClose: () => void
}) {
  const count = items.length
  // Navigation has a hard start and end - it does NOT wrap around. At the first image
  // there's no previous, at the last there's no next (the arrows/previews for those
  // directions are hidden below), so a gallery reads as a finite strip rather than an
  // endless carousel.
  const hasPrev = index > 0
  const hasNext = index < count - 1

  // The wrapper the shown media sits in (keyed by index, so it is a fresh node per
  // navigation) and the two edge previews - the endpoints every flight measures.
  const mediaRef = useRef<HTMLDivElement | null>(null)
  // HTMLElement, not HTMLImageElement: a peek is an <img> for a picture, a <video>
  // for a recording, and a plain card for everything else (see sidePreview).
  const prevPeekRef = useRef<HTMLElement | null>(null)
  const nextPeekRef = useRef<HTMLElement | null>(null)
  const peekRef = (side: 'prev' | 'next') => (side === 'prev' ? prevPeekRef : nextPeekRef)

  // The thumbnail this lightbox was opened from, resolved once at mount (the page
  // hasn't moved yet, and this is the only moment `origin` is certain to match what
  // is shown). Null → nothing to fly from, so the lightbox fades in as it used to.
  const [opening] = useState(() => (canFlip() ? findLightboxOrigin(items[index]?.url ?? '', origin) : null))
  const openedIndexRef = useRef(index)
  const [entrance, setEntrance] = useState<Entrance>(() => (
    opening ? { kind: 'flip', from: opening.rect } : { kind: 'slide', dir: 0 }
  ))

  // Closing plays out too - the picture flies back into its thumbnail while the
  // darkness lifts - so onClose is deferred until the flight lands. The ref is the
  // one the handlers test (state would be a render behind).
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)

  // Step to the neighbouring image, flying BOTH pictures: the one arriving comes from
  // the edge preview it was peeking out of, and the one leaving goes to the preview on
  // the opposite side, which is exactly where it now belongs. Without both endpoints
  // on screen (small screens hide the previews, reduced motion skips flights) it falls
  // back to the directional slide.
  const step = useCallback((delta: -1 | 1) => {
    if (closingRef.current) return
    const i = index + delta
    if (i < 0 || i >= count) return
    const side = delta < 0 ? 'prev' : 'next'
    const peek = peekRef(side).current
    // mediaRectOf on the preview <img> is just its own box (it has nothing inside),
    // and null while it is display:none - which is how the small-screen fallback and
    // the "no preview at this end" case are caught in one test.
    const from = canFlip() && peek ? mediaRectOf(peek) : null
    const outgoing = mediaRef.current ? mediaRectOf(mediaRef.current) : null
    setEntrance(from && outgoing
      ? { kind: 'flip', from, outgoing: { side: side === 'prev' ? 'next' : 'prev', from: outgoing } }
      : { kind: 'slide', dir: delta })
    onIndexChange(i)
  }, [index, count, onIndexChange])
  const prev = useCallback(() => step(-1), [step])
  const next = useCallback(() => step(1), [step])
  // Natural pixel dimensions of the entry at `i`: from its own metadata when it
  // carries one (artifact entries do), else from a size the app already knows for
  // that url - one it decoded earlier, or a copy still on the page behind the
  // overlay (see lib/mediaSize; this is what covers markdown images and prompt
  // attachments, which have no metadata to carry).
  //
  // Knowing it up front is what makes ←/→ still: the size becomes the <img>'s
  // width/height, so the picture occupies its final box on the very first frame
  // rather than laying out at nothing and popping open once the file decodes -
  // which shoved the caption, re-measured the zoom frame, and left the arriving
  // flight with no box to land on. It also keeps the caption's "W × H" from
  // blinking out and back on every step, which recentred the whole caption row.
  const seedDims = useCallback((i: number) => {
    const it = items[i]
    if (!it) return null
    if (it.width && it.height) return { w: it.width, h: it.height }
    return discoverMediaSize(it.url)
  }, [items])
  const [dims, setDims] = useState<{ w: number; h: number } | null>(() => seedDims(index))
  // Re-seed the moment the shown image changes (adjust-during-render rather than
  // in an effect, so a stale size never survives to the next paint).
  const [dimsIndex, setDimsIndex] = useState(index)
  if (dimsIndex !== index) { setDimsIndex(index); setDims(seedDims(index)) }
  // The box an entry is LAID OUT in, as opposed to the pixels it is made of: a 2x
  // capture is drawn at half its pixel count so one source pixel lands on one
  // device pixel, which is the whole reason for shipping the extra pixels (see
  // lib/imageDensity). The chat and the artifacts grid have always sized pictures
  // this way; the lightbox is now the same, rather than being the one surface that
  // showed a @2x shot at double size. The caption still reports the PIXELS
  // ("780 × 1688 @2×") - that is what the number means there.
  //
  // Mostly invisible: a screenshot big enough to hit the max-w/max-h caps lands on
  // the same box either way. It shows on the small ones, which now open at the
  // size they were captured to be seen at.
  const layoutSize = useCallback(
    (d: { w: number; h: number } | null, item: LightboxItem | undefined) =>
      (d ? logicalSize(d, item?.dpi ?? 1) : null),
    [],
  )

  // Comparison mode + before/after view + highlight for diff entries, held HERE (not in
  // LightboxDiff, which remounts per index) so they PERSIST as you navigate ←/→ between
  // items - pick a side or a mode and the next entry keeps it rather than resetting.
  // The mode seeds from whichever entry the lightbox was opened on (the grid's current
  // mode); view/highlight start fresh each opening. (Zoom still resets per image - its
  // state lives in the per-index ZoomPan remount.)
  const [diffMode, setDiffMode] = useState<ImageDiffMode>(() => items[index]?.diff?.mode ?? 'ab')
  const [abView, setAbView] = useState<'before' | 'after'>('after')
  const [highlight, setHighlight] = useState(false)

  // Steal focus while open, restore it on close. The opener can leave focus in a
  // keyboard-hungry widget - the terminal's hidden xterm textarea is the prime case
  // (e.g. opening a prompt-attachment thumbnail right after typing in the terminal):
  // every keystroke would keep feeding the shell, and the shortcut handlers below
  // would swallow nothing/act on nothing (X/B/A/H skip fields, Esc/←/→ would both
  // navigate AND type into the terminal). Focusing the (tabIndex -1) backdrop makes
  // the dialog the key target for as long as it's up, like any focused modal.
  const rootRef = useRef<HTMLDivElement | null>(null)

  // The caption sits below the ZoomPan frame. When the frame slides vertically to
  // keep a zoom anchored to the cursor (grow mode), that slide is a CSS transform, so
  // it doesn't move the frame's layout box - the caption would keep its old position
  // and end up overlapping the image or stranded below it. ZoomPan reports the slide
  // and we shift the caption by the same amount, imperatively (a ref, not state), so
  // this tracks the per-wheel-tick zoom without re-rendering the lightbox each frame.
  const captionRef = useRef<HTMLElement | null>(null)
  const followFrameSlide = useCallback((fy: number, transition: string | undefined) => {
    const el = captionRef.current
    if (!el) return
    el.style.transform = fy ? `translateY(${fy}px)` : ''
    el.style.transition = transition ? `transform ${transition}` : ''
  }, [])
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    rootRef.current?.focus()
    // Restore on unmount; if the opener left the DOM meanwhile, focus() no-ops.
    return () => opener?.focus()
  }, [])

  // Play the entrance flight for whatever is now shown. A layout effect, because the
  // whole point is to measure the media AFTER React has put it in its final place -
  // but the media only HAS a place once its frame has settled (a fresh ZoomPan measures
  // itself with a ResizeObserver, so it reports zero and then a not-quite-final size
  // for a frame or two), so it stays hidden until whenMediaLaidOut says there is a box
  // to fly to. Hiding it is what keeps the picture from flashing at its destination for
  // a frame before setting off.
  //
  // The cleanup CANCELS the flight, which matters more than it looks: React runs a
  // mount effect twice under StrictMode, and a second run that measured the element
  // mid-flight would read the animated box as its resting place - computing a flight
  // from nonsense (that was the "opens huge for a moment, then shrinks into place"
  // bug, worst when the window had been resized so the two boxes differ most).
  // Cancelling first puts the element back at rest, so the re-run measures the truth.
  useLayoutEffect(() => {
    if (entrance.kind !== 'flip') return
    const wrapper = mediaRef.current
    if (!wrapper) return
    const out = entrance.outgoing
    const outgoingEl = out ? peekRef(out.side).current : null
    let flights: Animation[] = []
    wrapper.style.opacity = '0'
    if (outgoingEl) outgoingEl.style.opacity = '0'
    const cancel = whenMediaLaidOut(wrapper, (to) => {
      wrapper.style.opacity = ''
      if (outgoingEl) outgoingEl.style.opacity = ''
      if (!to) return
      const duration = out ? FLIP_NAV_MS : FLIP_OPEN_MS
      const flight = playFlip(wrapper, {
        from: entrance.from,
        to,
        rest: 'to',
        duration,
        // Arriving from an edge preview means arriving from 40% opacity; arriving
        // from a page thumbnail is one continuous picture, so opacity stays put.
        opacity: out ? [PEEK_OPACITY, 1] : undefined,
      })
      // The counter-flight: the picture just replaced travels out to the edge preview
      // it has become (that preview element IS it, already re-sourced and parked in
      // its slot - so this is a real FLIP, not a ghost chasing it).
      const counter = out && outgoingEl
        ? playFlip(outgoingEl, { from: out.from, to: rectOf(outgoingEl), rest: 'to', duration, opacity: [1, PEEK_OPACITY] })
        : null
      flights = [flight, counter].filter((a): a is Animation => !!a)
    })
    return () => {
      cancel()
      flights.forEach((a) => a.cancel())
      wrapper.style.opacity = ''
      if (outgoingEl) outgoingEl.style.opacity = ''
    }
  }, [index, entrance])

  // Close by flying the picture back into the thumbnail it belongs to while the
  // darkness lifts, THEN unmounting. With no thumbnail to land on (scrolled away, a
  // gallery entry with nothing on the page, reduced motion) it just closes at once.
  const requestClose = useCallback(() => {
    if (closingRef.current) return
    const wrapper = mediaRef.current
    const url = items[index]?.url
    const from = wrapper && url && canFlip() ? mediaRectOf(wrapper) : null
    // Prefer the element the lightbox was opened from, but only while we are still on
    // the image it was opened at - after ←/→ the right target is whatever thumbnail on
    // the page shows THIS image.
    const target = from && url
      ? findLightboxOrigin(url, index === openedIndexRef.current ? opening?.el : null)
      : null
    const flight = wrapper && from && target
      ? playFlip(wrapper, { from, to: target.rect, rest: 'from', duration: FLIP_OPEN_MS })
      : null
    if (!flight || !target) { onClose(); return }
    closingRef.current = true
    setClosing(true)
    let landed = false
    const land = () => {
      if (landed) return
      landed = true
      onClose()
    }
    flight.onfinish = land
    // A backgrounded tab pauses the animation, so onfinish alone can leave the
    // lightbox stuck open; the timer is the floor under it.
    window.setTimeout(land, FLIP_OPEN_MS + 250)
  }, [items, index, opening, onClose])

  // X/B/A/H - the shared comparator shortcuts (see applyABShortcut) - drive a diff
  // entry's before/after view + highlight. Held here (with the state above) so they
  // persist across navigation; non-diff (plain image) entries ignore them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only a comparator responds to them; a text/PDF/binary entry has no
      // before/after view to flip even when it carries two sides.
      const it = items[index]
      if (!it?.diff || !isPictorial(kindOf(it))) return
      applyABShortcut(e, {
        view: abView,
        highlight,
        onViewChange: setAbView,
        onHighlightChange: setHighlight,
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, items, abView, highlight])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (closingRef.current) return // the exit flight is under way - ignore the lot
      if (e.key === 'Escape') requestClose()
      else if (e.key === 'ArrowLeft') prev()
      else if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, requestClose])

  // Whether the current pointer press STARTED on the backdrop itself. Closing on
  // backdrop click must ignore a drag that merely ENDS there - panning a zoomed
  // image (or dragging the diff slider) and releasing past the image's edge makes
  // the browser fire the trailing click on the press/release common ancestor, i.e.
  // the backdrop. Tracked in the capture phase so a child's stopPropagation (the
  // zoomed pan handler suspends inner gestures that way) can't hide the press.
  const pressOnBackdrop = useRef(false)

  const current = items[index]
  if (!current) return null

  const currentKind = kindOf(current)
  // The box the shown picture is laid out in - its pixels, taken down by its
  // capture density. See layoutSize.
  const pictureSize = layoutSize(dims, current)
  // A before/after comparator, and the mode controls that drive it, only exist for
  // the two kinds the artifact pipeline actually compares. A text file or an .apk
  // may still carry a `diff` (its two sides) - the viewer turns that into a pair of
  // download links rather than a comparison.
  const showsDiff = !!current.diff && isPictorial(currentKind)

  // On large screens, when there's more than one item, the prev/next entries sit
  // mostly off-screen at the edges with only a sliver (~12%) peeking in - a
  // Lightroom-style filmstrip hint of what ←/→ will bring up. Hovering slides the
  // peeked entry a little further in. The main picture is narrowed slightly so the
  // arrows have gutter room beside the peek (both dropped below `lg`).
  const hasSiblings = count > 1
  const figureWidth = hasSiblings ? 'max-w-[90vw] lg:max-w-[80vw]' : 'max-w-[90vw]'
  // Everything that ISN'T the picture - the darkness, the arrows, the caption - fades
  // in on open and back out on close, around a picture that travels instead. (An
  // element that only appears later, like the "previous" preview once you leave the
  // first image, fades in when it mounts, which is the right treatment for it too.)
  const chromeFade = closing ? 'lightbox-fade-out' : 'lightbox-fade-in'
  // The picture's own drop shadow is chrome too, but it can't ride an opacity fade
  // (that would fade the picture with it), so it gets the same timing as its own
  // box-shadow animation - see index.css.
  const shadowFade = closing ? 'lightbox-shadow-out' : 'lightbox-shadow-in'
  const sidePreview = (dir: 'prev' | 'next') => {
    // Only rendered when a sibling exists in that direction (no wrap), so the index
    // is always in range.
    const i = dir === 'prev' ? index - 1 : index + 1
    const peek = items[i]
    const peekKind = kindOf(peek)
    const onClick = dir === 'prev' ? prev : next
    // The sliver's own box, reserved the same way the main picture's is: a peek
    // that lays out at nothing until it decodes doesn't just pop, it leaves the
    // flight with no endpoint to measure - and ←/→ falls back to the plain slide.
    const peekSize = layoutSize(seedDims(i), peek)
    // Translate the whole button (not just the media) so its click area travels
    // off-screen with it - only the visible sliver stays clickable, rather than a
    // full-width hit zone covering the gutter.
    const slide = dir === 'prev'
      ? '-translate-x-[88%] hover:-translate-x-[78%]'
      : 'translate-x-[88%] hover:translate-x-[78%]'
    const round = dir === 'prev' ? 'rounded-r-2xl' : 'rounded-l-2xl'
    const common = `max-h-[70vh] max-w-[22vw] ${round} opacity-40 group-hover:opacity-80 transition-opacity duration-200 shadow-2xl`
    return (
      <button
        type="button"
        // The chevron buttons and ←/→ keys are the primary controls; the preview is
        // a redundant click target, so keep it out of the tab order.
        tabIndex={-1}
        onClick={(e) => { e.stopPropagation(); onClick() }}
        aria-hidden="true"
        className={`group hidden lg:block absolute top-1/2 -translate-y-1/2 ${dir === 'prev' ? 'left-0' : 'right-0'} ${slide} transition-transform duration-200 cursor-pointer ${chromeFade}`}
      >
        {/* The flight endpoint for ←/→: the picture arriving comes from this box, and
            the one leaving flies INTO this element once it takes its place here. */}
        {peekKind === 'image' ? (
          <img
            ref={(el) => { peekRef(dir).current = el }}
            src={peek.url}
            alt=""
            width={peekSize?.w}
            height={peekSize?.h}
            // Whatever this sliver decodes to is the size the picture will need when
            // you step onto it, so hand it to lib/mediaSize: by the time ←/→ is
            // pressed the neighbour's box is already known even for an entry that
            // carries no metadata.
            onLoad={(e) => rememberMediaSize(peek.url, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
            style={{ background: CHECKER }}
            className={`${common} object-contain`}
          />
        ) : peekKind === 'video' ? (
          // A poster frame, not playback: metadata-only, muted and paused, so a strip
          // of recordings doesn't set several videos running off-screen at once.
          <video
            ref={(el) => { peekRef(dir).current = el }}
            src={peek.url}
            muted
            playsInline
            preload="metadata"
            width={peekSize?.w}
            height={peekSize?.h}
            onLoadedMetadata={(e) => rememberMediaSize(peek.url, e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
            style={{ background: CHECKER }}
            className={`${common} object-contain`}
          />
        ) : (
          // Nothing to show a sliver OF - a PDF, a log, an .apk - so the peek is a
          // labelled card instead. It still gives the strip its "there is one more
          // that way, and here is what it is" cue, which is the point of the peek.
          <div
            ref={(el) => { peekRef(dir).current = el }}
            className={`${common} w-[22vw] flex flex-col items-center justify-center gap-2 py-10 px-6 bg-gray-900 border border-white/10`}
          >
            <KindIcon kind={peekKind} className="w-8 h-8 text-white/40" />
            <span className="max-w-full truncate text-2xs font-mono text-white/50">{peek.filename}</span>
          </div>
        )}
      </button>
    )
  }

  // Portal to <body> so the fixed overlay is positioned against the viewport, not
  // a transformed ancestor - the sidebar's slide animation (translate-x) makes it
  // a containing block for fixed descendants, which would otherwise clip/shrink
  // the lightbox when it's opened from the compact (in-sidebar) spawn form.
  return createPortal(
    <div
      // z-[100] keeps the lightbox BELOW the approval toasts (z-[110]): a passive
      // image viewer must not hide an incoming security-gate approval. Focused
      // modal dialogs sit above the toasts instead (z-[120]).
      className="fixed inset-0 z-[100] overflow-hidden flex items-center justify-center outline-none"
      // Marks this subtree as the lightbox's own, so the search for the thumbnail to
      // fly from/to (lib/lightboxFlip) never picks one of the items in here.
      data-lightbox-root=""
      onPointerDownCapture={(e) => { pressOnBackdrop.current = e.target === e.currentTarget }}
      // Close only when the press and the click BOTH land on the backdrop - see
      // pressOnBackdrop above for why a click alone isn't enough.
      onClick={(e) => { if (pressOnBackdrop.current && e.target === e.currentTarget) requestClose() }}
      role="dialog"
      aria-modal="true"
      // Click-focusable (not tabbable) so the focus-steal above can land here, and
      // so a click inside keeps the dialog - not the page behind it - the key target.
      tabIndex={-1}
      ref={rootRef}
    >
      {/* The darkness, as its own layer rather than a background on the root: it fades
          in and out on its own timing while the picture travels, and pointer-events-none
          leaves the backdrop click (and its press bookkeeping) on the root. */}
      <div aria-hidden className={`absolute inset-0 bg-black/70 backdrop-blur-md pointer-events-none ${chromeFade}`} />

      {/* Close button */}
      <button
        type="button"
        onClick={requestClose}
        aria-label="Close"
        className={`absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors cursor-pointer ${chromeFade}`}
      >
        <X className="w-5 h-5" />
      </button>

      {/* Previous file preview (large screens only) - hidden at the start */}
      {hasPrev && sidePreview('prev')}

      {/* Previous arrow - hidden at the start (no wrap-around) */}
      {hasPrev && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); prev() }}
          aria-label="Previous file"
          // Sits at the edge on small screens; on `lg` it moves inward to clear the
          // peeking preview, landing in the gutter beside it.
          className={`absolute left-4 lg:left-[4.5vw] p-2 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors cursor-pointer ${chromeFade}`}
        >
          <ChevronLeft className="w-7 h-7" />
        </button>
      )}

      {/* The file (picture, comparator, or one of the panels) + caption (clicks here
          don't close). `relative` so it paints above the (positioned) backdrop layer.
          The zoom-in is only for the fade fallback - when the picture flies in from a
          thumbnail, scaling the figure around it as well would fight the flight. */}
      <figure
        className={`relative flex flex-col items-center gap-3 ${showsDiff ? 'max-w-[94vw]' : figureWidth} max-h-[90vh] ${opening ? '' : 'animate-in zoom-in-95 duration-150'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Keyed by index so the media remounts on each navigation - which is both what
            re-runs the entrance flight and, in the fallback, what replays the
            directional slide+fade (lightbox-slide; defined in index.css). The CSS var
            sets which side it slides in from - the side you're heading toward - so ←/→
            feel like moving through a strip rather than the picture blinking in place.
            The flight transform is applied to this wrapper rather than the picture
            itself: it shares the picture's centre (so the maths is the same) but isn't
            clipped by the zoom frame the picture sits inside. */}
        <div
          key={index}
          ref={mediaRef}
          className={`${entrance.kind === 'slide' ? 'lightbox-slide' : ''} flex justify-center items-center w-full min-h-0`}
          style={entrance.kind === 'slide'
            ? { ['--lb-from' as string]: entrance.dir < 0 ? '-2rem' : entrance.dir > 0 ? '2rem' : '0rem' }
            : undefined}
        >
          {showsDiff && current.diff ? (
            // A before/after pair (a picture or a recording): render the fullscreen
            // comparator. Its control row (mode selector, A/B toggle, Highlight) is
            // rendered BELOW, outside this keyed wrapper, so it doesn't fade/remount
            // per entry.
            <LightboxDiff
              left={current.diff.left}
              right={current.diff.right}
              name={current.filename}
              kind={currentKind === 'video' ? 'video' : 'image'}
              fps={current.fps}
              mode={diffMode}
              view={abView}
              onViewChange={setAbView}
              highlight={highlight}
              aspect={dims ? dims.w / dims.h : undefined}
              onDims={setDims}
            />
          ) : currentKind === 'video' ? (
            <LightboxVideo url={current.url} aspect={dims ? dims.w / dims.h : undefined} onDims={setDims} />
          ) : currentKind === 'pdf' ? (
            <LightboxPdf url={current.url} />
          ) : currentKind === 'text' ? (
            <LightboxText url={current.url} filename={current.filename} diff={current.diff} />
          ) : currentKind === 'binary' ? (
            <LightboxFile url={current.url} filename={current.filename} kind={currentKind} diff={current.diff} />
          ) : (
            // Wrapped in ZoomPan so the image can be magnified past fit (wheel),
            // panned (drag once zoomed), and navigated with the corner minimap -
            // useful when a shot is too small to read at fit. The wrapper keys off
            // the parent's index remount, so zoom resets on navigation. maxWidth/
            // maxHeight let the frame GROW into the empty lightbox space as you zoom
            // (capped at the same box the image fits within) - so zooming a very
            // vertical (or wide) shot reveals its full width/height at magnification
            // rather than a thin sliver. The cap matches figureWidth so the growing
            // frame never overflows the figure.
            <ZoomPan
              minimapSrc={current.url}
              // LIGHTBOX_MEDIA_CLASS marks the frame as the picture's own box (it hugs
              // the image exactly at rest), so a flight measures the picture rather
              // than the full-width wrapper it is centred in.
              className={`${LIGHTBOX_MEDIA_CLASS} rounded-lg shadow-2xl ${shadowFade}`}
              maxWidth={hasSiblings ? '80vw' : '90vw'}
              maxHeight="85vh"
              onVerticalSlide={followFrameSlide}
            >
              {/* The wrapper hugs the image (shrink-to-fit inside ZoomPan's content
                  box), so the checkerboard layer behind it lines up with the picture. */}
              <div className="relative">
                <LightboxChecker className={chromeFade} />
                <img
                  src={current.url}
                  alt={current.filename}
                  // The known size, as the picture's own box - at its LOGICAL size
                  // (see layoutSize), which is also what makes a @2x capture land
                  // one source pixel per device pixel here. The browser sizes a
                  // replaced element from these before a single byte has arrived
                  // (max-w/max-h still clamp it, preserving the ratio), so the
                  // picture lands laid out rather than growing into place - and the
                  // measured size takes over below if the two ever disagree.
                  width={pictureSize?.w}
                  height={pictureSize?.h}
                  onLoad={(e) => {
                    const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                    setDims({ w, h })
                    rememberMediaSize(current.url, w, h)
                  }}
                  // Middle-click opens the raw image file in a new browser tab.
                  onAuxClick={makeAuxOpen(() => current.url)}
                  draggable={false}
                  // relative so the picture paints ABOVE the checkerboard layer behind
                  // it (a positioned element beats a static one in the same stack).
                  className={`relative max-h-[85vh] ${figureWidth} object-contain block`}
                />
              </div>
            </ZoomPan>
          )}
        </div>
        {/* The diff control row lives OUTSIDE the keyed slide wrapper above, so it
            persists across ←/→ - no fade/remount per image, and the caption below
            doesn't get shoved as it re-appears. State is held up here anyway (it
            survives navigation); only the picture slides. */}
        {showsDiff && current.diff && (
          <div className={chromeFade}>
            <LightboxDiffControls
              mode={diffMode}
              onModeChange={setDiffMode}
              view={abView}
              onViewChange={setAbView}
              highlight={highlight}
              onHighlightChange={setHighlight}
              canDiff={!!current.diff.left && !!current.diff.right}
            />
          </div>
        )}
        <figcaption ref={captionRef} className={`flex items-center gap-2 text-xs font-mono ${chromeFade}`}>
          {[
            <span key="name" className="flex items-center gap-1.5 text-white/70">
              {current.filename}
              {current.changeType && (
                <Tooltip content={current.changeType}>
                  <span className="flex items-center">
                    <ChangeTypeGlyph type={current.changeType} />
                  </span>
                </Tooltip>
              )}
            </span>,
            dims && <span key="dims" className="text-white/40">{dims.w} × {dims.h}{current.dpi && current.dpi > 1 ? ` @${current.dpi}×` : ''}</span>,
            current.size > 0 && <span key="size" className="text-white/40">{formatBytes(current.size)}</span>,
            count > 1 && <span key="count" className="text-white/40">{index + 1} / {count}</span>,
          ]
            .filter(Boolean)
            .map((part, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="text-white/30">·</span>}
                {part}
              </Fragment>
            ))}
        </figcaption>
      </figure>

      {/* Next arrow - hidden at the end (no wrap-around) */}
      {hasNext && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); next() }}
          aria-label="Next file"
          className={`absolute right-4 lg:right-[4.5vw] p-2 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors cursor-pointer ${chromeFade}`}
        >
          <ChevronRight className="w-7 h-7" />
        </button>
      )}

      {/* Next file preview (large screens only) - hidden at the end */}
      {hasNext && sidePreview('next')}
    </div>,
    document.body,
  )
}
