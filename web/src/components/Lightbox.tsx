import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronLeft, ChevronRight, FileArchive, FileText, File as FileIcon, Film, MessageSquarePlus } from 'lucide-react'
import { ImagePins, type ImagePin, type PendingPin } from './ImagePins'
import { HighlightedTextarea } from './HighlightedTextarea'
import { renderCommentSource } from '../lib/mentionHighlight'
import { useImageCommentStore } from '../stores/imageCommentStore'
import {
  anchorPositionLabel, anchorVersionLabel, artifactRefFromUrl, buildImageAnchor, sameArtifactPicture,
} from '../lib/artifactAnchor'
import { ReviewImageAnchor } from '../api'
import { placePinPopover, type PopoverPlacement } from '../lib/pinPopover'
import { agentFilePath, pictureKind } from '../lib/pictureKind'
import type { ImageDiffMode } from './ArtifactImageDiff'
import { LightboxDiff, LightboxDiffControls } from './LightboxDiff'
import { LightboxFile, LightboxPdf, LightboxText, LightboxVideo } from './LightboxViewers'
import { makeAuxOpen } from './artifactDiffShared'
import { CheckerLayer } from './CheckerLayer'
import { applyABShortcut } from '../lib/abShortcuts'
import { ZoomPan } from './ZoomPan'
import { Tooltip } from './Tooltip'
import type { FileKind } from '../lib/fileKind'
import { ChangeTypeIcon } from './ChangeTypeIcon'
import {
  canFlip, findLightboxOrigin, mediaRectOf, playFlip, rectOf,
  whenMediaLaidOut, FLIP_NAV_MS, FLIP_OPEN_MS, LIGHTBOX_MEDIA_CLASS, type Rect,
} from '../lib/lightboxFlip'
import { discoverMediaSize, rememberMediaSize } from '../lib/mediaSize'
import { logicalSize } from '../lib/imageDensity'
import { useOverlayScrollbarSuppression } from '../lib/useOverlayScrollbarSuppression'

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
  /** Marks this entry as an ATTACHMENT to something being composed, so a pin on it
   *  becomes markup on that prompt rather than a stored comment.
   *
   *  Stated rather than derived, unlike an artifact's identity. An artifact's
   *  anchor is read out of its URL precisely so the two cannot disagree - but a
   *  freshly attached file has no server URL yet, it previews from a local
   *  `blob:`, and a blob URL says nothing about what it is. The list that holds
   *  attachments knows they are attachments; that is the honest source. */
  attachment?: boolean
}

// A small +/−/• glyph marking whether the artifact was added, removed, or modified
// relative to its counterpart - mirrors the diff grid's ArtifactChangeIcon, but tuned
// for the lightbox's always-dark backdrop (the brighter dark-theme colors).
function ChangeTypeGlyph({ type }: { type: NonNullable<LightboxItem['changeType']> }) {
  return <ChangeTypeIcon type={type} bright />
}

// Whether a key event landed in something being typed into, so the lightbox's
// single-letter shortcuts leave it alone. The pin composer is the first field the
// overlay has ever contained; before it, every key belonged to the viewer.
function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT'
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

// How far either side of the shown frame a recording's pin still counts as being
// "here", in seconds. A pin marks a moment, and a clip is usually a few seconds
// long, so this has to be tight enough that two remarks about different moments
// do not stack - and loose enough that one does not blink out as the frame the
// player settles on drifts by a hair.
const PIN_TIME_WINDOW = 0.75

// Roughly the height of the browser's native video transport. Left uncovered by
// an armed pin layer so the clip can still be scrubbed - getting to the moment is
// the first half of pinning one.
const VIDEO_CONTROLS_H = 44

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
  // Native WebKitGTK scrollbars can be promoted above this fixed portal. Leave
  // their gutters in place, but hide the chrome for the lightbox lifetime.
  useOverlayScrollbarSuppression()

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

  // Review pins on the picture (docs/review-agent.md). The comments and the way to
  // store one are registered by whatever page opened the lightbox - nothing
  // registered means no head to comment on, and the whole pin UI is absent.
  const pinComments = useImageCommentStore((s) => s.comments)
  const submitPin = useImageCommentStore((s) => s.submit)
  const quotePin = useImageCommentStore((s) => s.quote)
  const annotatePin = useImageCommentStore((s) => s.annotate)
  // Whether a press on the picture places a pin. Off by default and armed
  // explicitly: the picture is already draggable (pan) and clickable (the
  // comparator's A/B flip), so an always-armed layer would scatter pins during
  // ordinary looking-around.
  const [arming, setArming] = useState(false)
  const [pending, setPending] = useState<PendingPin | null>(null)
  const [pinBody, setPinBody] = useState('')
  const [pinBusy, setPinBusy] = useState(false)
  // The clip element, so a pin on a recording can record WHICH FRAME it is about.
  // currentTime is the only place that lives, and it has to be read at the moment
  // of the click - by the time the remark is typed the clip has moved on.
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // The still being shown, for the same reason as videoRef: a crop is drawn from
  // the element the browser has already painted, which is the only thing that can
  // render every format an artifact might be (an SVG, a video frame).
  const imgRef = useRef<HTMLImageElement | null>(null)
  // The moment being SHOWN, which is what decides whether an existing pin belongs
  // to the frame on screen. Deliberately separate from the moment a pin RECORDS:
  // one variable doing both meant the filter only ever moved when you dropped a
  // pin, so a clip opened at 0 hid every remark past the first 0.75s - and the
  // overlay was not even mounted, making a commented clip look uncommented.
  const [frameT, setFrameT] = useState(0)
  // The moment the pending pin was placed at, read from the element at the click
  // because by the time the remark is typed the clip has moved on.
  const [pendingT, setPendingT] = useState(0)
  const [pinError, setPinError] = useState('')
  // Arming and any half-written pin are dropped when the picture changes: a comment
  // composed against one image must never land on the next one.
  const [pinIndex, setPinIndex] = useState(index)
  if (pinIndex !== index) {
    setPinIndex(index)
    setArming(false)
    setPending(null)
    setPinBody('')
    setPinError('')
    setPendingT(0)
    setFrameT(0)
  }

  // Which single picture a pin would be placed on. A comparator shows two at once
  // (or halves of both), and "which side is this remark about" has no answer there
  // - so commenting is a SINGLE-SIDE view: arming drops the comparator for the side
  // currently selected, and the Before/After control picks which. That also means
  // one code path draws pins, instead of one per comparison mode.
  const pinnedItem = items[index]
  // Which side to pin is usually NOT a question, and asking it every time was
  // noise. It only has an answer worth choosing when both sides exist AND they
  // differ: an added file is only on the right, a removed one only on the left,
  // and an unchanged pair is the same pixels either way, so any of those decides
  // itself. `modified` is exactly that case - an unchanged pair carries no
  // changeType at all, and the repository browser has no second side to choose.
  const pinSideAmbiguous = !!(pinnedItem?.diff?.left && pinnedItem?.diff?.right) && pinnedItem?.changeType === 'modified'
  const pinnedUrl = pinnedItem?.diff
    ? (pinSideAmbiguous
        ? (abView === 'before' ? pinnedItem.diff.left : pinnedItem.diff.right)
        : (pinnedItem.diff.right ?? pinnedItem.diff.left)) ?? pinnedItem.url
    : pinnedItem?.url
  const pinnedRef = useMemo(() => artifactRefFromUrl(pinnedUrl), [pinnedUrl])
  const pinnedSide = pinnedItem?.diff
    ? (pinSideAmbiguous
        ? (abView === 'before' ? ReviewImageAnchor.side.LEFT : ReviewImageAnchor.side.RIGHT)
        : (pinnedItem.diff.right ? ReviewImageAnchor.side.RIGHT : ReviewImageAnchor.side.LEFT))
    : undefined
  // The comments pinned to THIS picture, in this version, on this side. A remark
  // left on the "before" side must not appear over the "after" one - it would be
  // pointing at pixels it was never about.
  const pinsHere = useMemo<ImagePin[]>(
    () => pinComments
      .filter((c) => sameArtifactPicture(c.image, pinnedRef, pinnedSide))
      // On a recording, a pin belongs to a moment as much as to a spot: showing
      // every remark in the clip at once would stack marks from frames that are
      // not on screen over the one that is. The window is generous enough that a
      // pin does not blink out while you look at it.
      .filter((c) => !c.image?.t || Math.abs(c.image.t - frameT) <= PIN_TIME_WINDOW)
      .map((c) => ({
        id: c.id,
        x: c.image?.x ?? 0,
        y: c.image?.y ?? 0,
        w: c.image?.w,
        h: c.image?.h,
        // A draft has a number but nobody else can cite it yet, so it shows a dot
        // rather than a handle - the same rule the diff gutter's cards follow.
        label: c.published ? `#${c.number}` : '',
        draft: !c.published,
        resolved: c.resolved,
      })),
    [pinComments, pinnedRef, pinnedSide, frameT],
  )
  // Only a still picture that is a real artifact can carry a pin: a video has a
  // time axis this anchor does not model, and an upload or a chat image has no
  // (script, key, file) identity to record.
  const pinnedKind = kindOf(pinnedItem)
  // A recording is pinnable as well as a still: it has the same two spatial axes,
  // plus a time one the anchor now carries. The other kinds (a PDF, a log, an
  // .apk) have no picture to point at.
  // WHERE a remark about this picture goes, decided by what the picture IS (see
  // lib/pictureKind). An artifact outlives the conversation, so a remark about it
  // is a durable numbered comment; a picture the agent posted into the chat is
  // already part of a thread, so a remark is a reply; an attachment has not been
  // sent yet, so a remark is markup on the prompt being written. One pin UI, three
  // destinations - and the destination is never guessed from which page is open.
  const pictureSort = pictureKind(pinnedUrl)
  // The explicit attachment marker wins: a locally-attached file previews from a
  // `blob:` URL that classifies as nothing, and it is still an attachment.
  const isAttachment = pinnedItem?.attachment || pictureSort === 'upload'
  const pinDest: 'comment' | 'quote' | 'annotate' | null =
    pictureSort === 'artifact' && submitPin && pinnedRef ? 'comment'
      : pictureSort === 'agent-file' && quotePin ? 'quote'
        : isAttachment && annotatePin ? 'annotate'
          : null
  const canPin = !!pinDest && (pinnedKind === 'image' || pinnedKind === 'video')

  // The composer opens ON the pin, so the remark is written next to the spot it
  // is about. That needs the pin's position in SCREEN pixels, which only the pin
  // layer can give: it is the picture's own box, so measuring it converts the
  // stored fractions correctly at any zoom or window size.
  const pinLayerRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [popover, setPopover] = useState<PopoverPlacement | null>(null)
  const placePopover = useCallback(() => {
    const layer = pinLayerRef.current
    const box = popoverRef.current
    if (!layer || !box || !pending) {
      setPopover(null)
      return
    }
    const b = layer.getBoundingClientRect()
    // Anchored to the pin's bottom-right: for a box that is its far corner, so
    // the composer never covers the region being talked about.
    const anchor = {
      x: b.left + (pending.x + (pending.w ?? 0)) * b.width,
      y: b.top + (pending.y + (pending.h ?? 0)) * b.height,
    }
    const r = box.getBoundingClientRect()
    setPopover(placePinPopover({
      anchor,
      size: { w: r.width, h: r.height },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    }))
  }, [pending])
  // Measured after layout, so the box's real size decides which corner it takes -
  // guessing the height would flip it wrongly the moment an error line appears.
  useLayoutEffect(() => { placePopover() }, [placePopover])
  useEffect(() => {
    if (!pending) return
    window.addEventListener('resize', placePopover)
    return () => window.removeEventListener('resize', placePopover)
  }, [pending, placePopover])

  // Where the pin being composed sits, in the picture's own pixels when they are
  // known - the same form the agent is given, so what you are told you marked and
  // what it is told are the same sentence.
  const pendingLabel = pending
    ? anchorPositionLabel({
        file: '', x: pending.x, y: pending.y, w: pending.w, h: pending.h,
        natural_w: dims?.w, natural_h: dims?.h,
        t: pinnedKind === 'video' ? pendingT : undefined,
      })
    : ''

  // Store the pin being composed. `publish` is the difference between adding it to
  // the review you are building and telling the agent about it now - the same two
  // buttons the diff viewer's line comments offer, and the same meaning.
  const savePin = useCallback(async (publish: boolean) => {
    const body = pinBody.trim()
    if (!pending || !pinDest || !pinnedUrl || !body) return
    // The two non-store destinations want prose, not an anchor row: what they
    // produce is text a person reads in a message. Neither stores anything, so
    // neither needs the crop or the artifact identity.
    if (pinDest !== 'comment') {
      const note = {
        filename: pinnedItem?.filename ?? '',
        path: agentFilePath(pinnedUrl) ?? undefined,
        position: pendingLabel,
        body,
      }
      if (pinDest === 'quote') quotePin?.(note)
      else annotatePin?.(note)
      setPending(null)
      setPinBody('')
      setPinError('')
      return
    }
    if (!submitPin) return
    const anchor = buildImageAnchor({
      url: pinnedUrl,
      x: pending.x,
      y: pending.y,
      w: pending.w,
      h: pending.h,
      natural: dims,
      side: pinnedSide,
      t: pinnedKind === 'video' ? pendingT : undefined,
    })
    if (!anchor) {
      setPinError('This picture has no artifact identity to pin a comment to.')
      return
    }
    setPinBusy(true)
    setPinError('')
    try {
      await submitPin(anchor, body, publish)
      setPending(null)
      setPinBody('')
      // Deliberately STAYS armed. Disarming drops back to the comparator, which
      // has no pin layer - so the comment you just left vanished the instant you
      // saved it, which reads as having lost it. Staying put also matches how
      // reviewing actually goes: several remarks on one screenshot, not one.
      // Escape or the toolbar toggle is the way out.
    } catch (e) {
      setPinError(e instanceof Error ? e.message : 'The comment could not be saved.')
    } finally {
      setPinBusy(false)
    }
  }, [pending, pinDest, submitPin, quotePin, annotatePin, pinnedUrl, pinnedItem, pendingLabel, pinBody, dims, pinnedSide, pinnedKind, pendingT])

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
      // ←/→ move the caret in the pin composer, and `c` is just a letter there. A
      // textarea inside the overlay is new (nothing else in the lightbox took
      // typing), so without this the composer would navigate the gallery as you
      // wrote in it.
      if (isTypingTarget(e.target)) {
        if (e.key === 'Escape') { setPending(null); setPinBody('') }
        return
      }
      if (e.key === 'Escape') {
        // Escape backs out one layer at a time: the half-written pin, then arming,
        // then the lightbox. Closing the whole overlay on the first press would
        // throw away a comment someone was part-way through writing.
        if (pending) { setPending(null); setPinBody('') }
        else if (arming) setArming(false)
        else requestClose()
      } else if (e.key === 'ArrowLeft') prev()
      else if (e.key === 'ArrowRight') next()
      else if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && !e.altKey && canPin) {
        setArming((v) => !v)
        setPending(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, requestClose, pending, arming, canPin])

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
  const showsPins = canPin && (arming || pinsHere.length > 0)
  // A before/after comparator, and the mode controls that drive it, only exist for
  // the two kinds the artifact pipeline actually compares. A text file or an .apk
  // may still carry a `diff` (its two sides) - the viewer turns that into a pair of
  // download links rather than a comparison.
  const showsDiff = !!current.diff && isPictorial(currentKind) && !arming

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

      {/* Top-right controls. Comment sits beside Close because arming is a mode the
          whole overlay is in, not something belonging to the picture's own chrome. */}
      <div className={`absolute top-4 right-4 flex items-center gap-2 ${chromeFade}`}>
        {canPin && (
          <Tooltip content={arming ? 'Stop placing comments (c)' : 'Comment on a point in this picture (c)'}>
            <button
              type="button"
              onClick={() => { setArming((v) => !v); setPending(null) }}
              aria-label="Comment on this picture"
              aria-pressed={arming}
              className={`relative p-2 rounded-full transition-colors cursor-pointer ${
                arming ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-white/10 text-white/80 hover:bg-white/20 hover:text-white'
              }`}
            >
              <MessageSquarePlus className="w-5 h-5" />
              {/* How many comments are already on this side. Without it a picture
                  that HAS remarks looks exactly like one that has none, because
                  the pins are only drawn while commenting - and there is no badge
                  on the tile yet either. */}
              {pinsHere.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 flex items-center justify-center rounded-full bg-white text-gray-900 text-4xs font-semibold tabular-nums">
                  {pinsHere.length}
                </span>
              )}
            </button>
          </Tooltip>
        )}
        <button
          type="button"
          onClick={requestClose}
          aria-label="Close"
          className="p-2 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

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
            <LightboxVideo
              // The pinned SIDE, for the same reason a picture uses it: arming
              // drops the comparator, and a pin must record the clip on screen.
              url={pinnedUrl ?? current.url}
              aspect={dims ? dims.w / dims.h : undefined}
              onDims={setDims}
              videoRef={videoRef}
              paused={arming}
              onTime={setFrameT}
              overlay={showsPins ? (
                <ImagePins
                  pins={pinsHere}
                  pending={pending}
                  armed={arming}
                  layerRef={pinLayerRef}
                  // The browser's transport is about this tall; leaving it clear
                  // keeps "scrub to the moment, then pin it" possible.
                  controlsInset={VIDEO_CONTROLS_H}
                  onPlace={(p) => { setPending(p); setPendingT(videoRef.current?.currentTime ?? 0); setPinError('') }}
                />
              ) : undefined}
            />
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
              // The composer hangs off the pin, and the pin travels with the
              // picture - so a wheel-zoom over the image has to re-place it or the
              // box is left pointing at where the pin used to be.
              onViewChange={placePopover}
            >
              {/* The wrapper hugs the image (shrink-to-fit inside ZoomPan's content
                  box), so the checkerboard layer behind it lines up with the picture -
                  and so the pin layer, which is `absolute inset-0` over this box, puts
                  a pin at the fraction of the PICTURE it was placed at. */}
              <div data-lightbox-picture-surface className="relative inline-block">
                <LightboxChecker className={chromeFade} />
                <img
                  ref={imgRef}
                  src={pinnedUrl ?? current.url}
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
                  // Width owns both viewport caps: encoding the height cap as
                  // `85vh * aspect` keeps the replaced element's box at the
                  // picture's ratio. Independent max-width/max-height clamps can
                  // otherwise squeeze both dimensions separately, leaving
                  // object-contain letterboxing over the checkerboard backing.
                  style={pictureSize ? {
                    width: `min(${pictureSize.w}px, 90vw, calc(85vh * ${pictureSize.w / pictureSize.h}))`,
                  } : undefined}
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
                  className={`relative h-auto max-h-[85vh] ${figureWidth} object-contain block`}
                />
                {showsPins && (
                  <ImagePins
                    pins={pinsHere}
                    pending={pending}
                    armed={arming}
                    layerRef={pinLayerRef}
                    // A still has no moment to record - only the clip path reads one.
                    onPlace={(p) => { setPending(p); setPinError('') }}
                  />
                )}
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

      {/* The pin composer, hanging off the pin itself rather than sitting in a
          panel elsewhere: the position is part of what is being said, so the
          sentence belongs next to the spot. Fixed-positioned against the viewport
          (the placement is computed in client pixels), and hidden for the first
          frame because the corner it takes depends on measuring its own size. */}
      {pending && (
        <div
          ref={popoverRef}
          className="fixed z-[102] w-80 rounded-lg border border-white/15 bg-gray-900/95 backdrop-blur-sm shadow-2xl p-3"
          style={{
            left: popover?.left ?? 0,
            top: popover?.top ?? 0,
            visibility: popover ? 'visible' : 'hidden',
          }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 mb-2 text-3xs text-white/50 font-mono">
            <span>{pendingLabel}</span>
            {pinnedRef && <span className="text-white/30">·</span>}
            {pinnedRef && <span className="truncate">{anchorVersionLabel({ file: pinnedRef.file, key: pinnedRef.key, x: 0, y: 0 })}</span>}
          </div>
          {/* Which side the remark is about - asked ONLY when it is a real
              question. An added file exists on one side, an unchanged pair is the
              same pixels either way, and asking anyway made a choice out of
              something already decided. When it IS ambiguous it belongs here
              rather than over by the picture: it is part of what the comment says,
              and changing it swaps the picture under the pin so the answer can be
              checked. */}
          {pinSideAmbiguous && (
            <div className="flex items-center gap-1 mb-2">
              <span className="text-3xs text-white/40 mr-1">About the</span>
              {(['before', 'after'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setAbView(v)}
                  // A toggle group, so which side is selected has to be readable
                  // as STATE, not only as a colour - the comparator's equivalent
                  // controls already do this.
                  aria-pressed={abView === v}
                  className={`px-2 h-6 rounded text-3xs font-medium transition-colors cursor-pointer ${
                    abView === v ? 'bg-white/20 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/90'
                  }`}
                >
                  <span className="optical-center">{v === 'before' ? 'Before' : 'After'}</span>
                </button>
              ))}
            </div>
          )}
          <HighlightedTextarea
            value={pinBody}
            autoFocus
            onChange={(e) => setPinBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void savePin(false)
              }
            }}
            placeholder={pinDest === 'annotate' ? 'What should the agent do here?' : 'What is wrong with this spot?'}
            // The textarea is absolutely positioned inside the wrapper, so it
            // cannot size the box - the height belongs on the wrapper, as it
            // does on the diff viewer's comment box.
            wrapperClassName="w-full h-20 rounded border border-white/15 bg-black/30 focus-within:ring-1 focus-within:ring-blue-400"
            textClassName="p-2 text-xs leading-5"
            textColorClassName="text-gray-100"
            caretClassName="caret-gray-100"
            // Mentions decide who the comment wakes - `@review` sends it to the
            // reviewer instead of the head - so they are painted while it is
            // typed, exactly as in the line-comment box.
            renderContent={renderCommentSource}
          />
          {pinError && <p className="mt-2 text-2xs text-red-400">{pinError}</p>}
          <div className="flex items-center justify-end gap-1.5 mt-2">
            <button
              type="button"
              onClick={() => { setPending(null); setPinBody(''); setPinError('') }}
              className="px-2 h-7 rounded text-2xs text-white/70 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <span className="optical-center">Cancel</span>
            </button>
            {/* The buttons name the DESTINATION, because the destination differs
                by what the picture is and the difference is not otherwise
                visible. Only an artifact offers the draft/publish pair - the
                other two produce text in a composer you then send yourself, so
                there is nothing to queue and nothing to publish. */}
            {pinDest === 'comment' && (
              <button
                type="button"
                disabled={pinBusy || !pinBody.trim()}
                onClick={() => void savePin(true)}
                className="px-2 h-7 rounded text-2xs text-white/80 bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                <span className="optical-center">To agent</span>
              </button>
            )}
            <button
              type="button"
              disabled={pinBusy || !pinBody.trim()}
              onClick={() => void savePin(false)}
              className="px-2 h-7 rounded text-2xs font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <span className="optical-center">
                {pinDest === 'comment' ? 'Add to review' : pinDest === 'quote' ? 'Reply in chat' : 'Add note'}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Next file preview (large screens only) - hidden at the end */}
      {hasNext && sidePreview('next')}
    </div>,
    document.body,
  )
}
