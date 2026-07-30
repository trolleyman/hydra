// The lightbox's non-image viewers: video, PDF, text and "there is nothing to
// show, here is the file". The picture viewer lives in Lightbox.tsx itself (it is
// entangled with the zoom frame and the flight animation); everything here is a
// self-contained panel the lightbox drops into the same slot.
//
// They share one visual language so ←/→ between a screenshot, a recording and a
// build log doesn't feel like three different apps: a rounded panel on the dark
// backdrop, sized against the viewport, with the filename/size caption supplied by
// the lightbox below it rather than repeated inside.
//
// The panels follow the APP's theme, light or dark. The backdrop behind them is a
// dark scrim either way (that is what a lightbox is, and what makes the file the
// only lit thing on screen) and the chrome ON that scrim - the caption, the arrows,
// the close button - stays light-on-dark; but a file you opened to read is a
// document, and reading a white app's file against a black panel was the one place
// the theme stopped applying.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, File as FileIcon, FileArchive, FileText, LoaderCircle, TriangleAlert, WrapText } from 'lucide-react'
import { LIGHTBOX_MEDIA_CLASS } from '../lib/lightboxFlip'
import { rememberMediaSize } from '../lib/mediaSize'
import { type FileKind } from '../lib/fileKind'
import { getLanguage } from '../lib/language'
import { buildEditRows, numberRows } from '../lib/editDiff'
import { formatBytes } from '../lib/formatBytes'
import { Markdown } from '../lib/MarkdownRenderer'
import { StorageKeys, readLocal, writeLocal } from '../lib/storage'
import { CodePane, DiffPane } from './CodePane'
import { Tooltip } from './Tooltip'

// How much of a text file the viewer will pull down and render. Big enough for
// any build log or source file worth reading on screen, small enough that a
// mislabelled 200MB blob can't wedge the tab: the rest is a download away, and
// the panel says so rather than pretending it showed everything.
const MAX_TEXT_BYTES = 512 * 1024

// Files the viewer can render as a document rather than as source. Deliberately
// just markdown: it is the one text format where the source is a lesser version
// of the thing (a README's tables and headings), rather than the thing itself.
const MARKDOWN_RE = /\.(md|markdown)$/i

// The panel every non-image viewer sits in: rounded, capped against the viewport,
// in the app's own theme. LIGHTBOX_MEDIA_CLASS marks it as the item's own box, so
// the open/close flight (when there was a tile to fly from) measures the panel
// rather than the full-width wrapper it is centred in.
const PANEL_CLASS = `${LIGHTBOX_MEDIA_CLASS} rounded-lg shadow-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-gray-900 overflow-hidden`

// The chip every header control is cut from - the download links, the toggles,
// the segmented switches. Light on light, light on dark.
const CHIP_IDLE = 'border-gray-200 dark:border-white/15 bg-gray-50 dark:bg-white/5 text-gray-600 dark:text-white/70 hover:bg-gray-100 dark:hover:bg-white/15 hover:text-gray-900 dark:hover:text-white'
const CHIP_ON = 'border-gray-300 dark:border-white/25 bg-gray-200 dark:bg-white/15 text-gray-900 dark:text-white'

// A save link for one side of the item. Anchors rather than buttons so a
// middle-click still opens the file in a new tab, and so the browser's own
// download UI takes over from there.
function DownloadLink({ url, label, tip }: { url: string; label: string; tip: string }) {
  return (
    <Tooltip content={tip}>
      <a
        href={url}
        download
        // The lightbox closes on a backdrop click and the panels stop propagation
        // for that; this stops it again in case a viewer forgets to.
        onClick={(e) => e.stopPropagation()}
        className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-2xs font-medium transition-colors cursor-pointer ${CHIP_IDLE}`}
      >
        <Download className="w-3.5 h-3.5" />
        {/* The label carries the trim, never the icon - see .optical-center. The
            anchor keeps its own h-7, so trimming the label can't shrink the row. */}
        <span className="optical-center">{label}</span>
      </a>
    </Tooltip>
  )
}

// The save links for an item: one per side that exists. A before/after pair gets
// two labelled links, a single-sided file gets one plain "Download".
export function DownloadLinks({ url, diff }: { url: string; diff?: { left?: string | null; right?: string | null } }) {
  const sides = [
    { label: 'Before', url: diff?.left },
    { label: 'After', url: diff?.right },
  ].filter((s): s is { label: string; url: string } => !!s.url)
  if (sides.length < 2) {
    const only = sides[0]?.url ?? url
    return <DownloadLink url={only} label="Download" tip="Save this file" />
  }
  return (
    <>
      {sides.map((s) => (
        <DownloadLink key={s.label} url={s.url} label={s.label} tip={`Save the ${s.label.toLowerCase()} version`} />
      ))}
    </>
  )
}

// LightboxVideo plays a single (non-diff) clip fullscreen with the browser's own
// transport. A before/after PAIR goes through LightboxDiff instead, which drives
// both clips off one synced transport - see VideoDiffView.
export function LightboxVideo({ url, aspect, onDims, videoRef, overlay, paused }: {
  url: string
  // The clip's aspect ratio when known ahead of load, so the panel lays out at its
  // final shape immediately instead of collapsing to the default 300x150 box and
  // snapping open once the metadata arrives.
  aspect?: number
  // Reports the clip's natural pixel size once the browser has its metadata - for
  // the lightbox caption, and so the size is known next time (see lib/mediaSize).
  onDims?: (d: { w: number; h: number }) => void
  // The element itself, so a caller can read the moment being shown - a pin on a
  // recording is about a FRAME, and currentTime is the only place that lives.
  videoRef?: React.MutableRefObject<HTMLVideoElement | null>
  // Drawn over the clip, in its own box: the review pin layer. It has to be a
  // sibling of the <video> rather than a child (a replaced element has no
  // renderable children), which is why the panel below became positioned.
  overlay?: React.ReactNode
  // Holds the clip still. Pinning a moving frame is meaningless - the moment you
  // recorded would already have passed by the time you finished typing - so
  // arming stops playback rather than trying to catch up with it.
  paused?: boolean
}) {
  return (
    <div className={`${PANEL_CLASS} relative`} data-lb-picture>
      {/* autoPlay + muted + loop mirrors how the grid tiles behave, so opening a
          clip continues rather than restarts the impression of it; controls are
          the browser's because there is only one clip to drive. */}
      <video
        ref={(el) => { if (videoRef) videoRef.current = el }}
        src={url}
        controls
        autoPlay={!paused}
        loop={!paused}
        muted
        playsInline
        onLoadedMetadata={(e) => {
          const { videoWidth: w, videoHeight: h } = e.currentTarget
          if (w && h) {
            rememberMediaSize(url, w, h)
            onDims?.({ w, h })
          }
        }}
        style={{ aspectRatio: aspect }}
        className="block max-w-[90vw] max-h-[85vh]"
      />
      {overlay}
    </div>
  )
}

// LightboxPdf embeds a PDF in the browser's own viewer. An <iframe> (not <object>)
// because it is the one element every engine renders a PDF in with its own
// scroll/zoom/page chrome, and because a failure degrades to a blank frame rather
// than to the element's fallback content silently replacing the document.
//
// The frame is given an explicit box: a PDF has no intrinsic size to lay out from,
// and a page is portrait far more often than not, so it takes the height budget and
// derives its width from A4-ish proportions (capped to the viewport).
export function LightboxPdf({ url }: { url: string }) {
  return (
    <div className={`${PANEL_CLASS} bg-gray-100 dark:bg-gray-800`} data-lb-picture>
      <iframe
        src={url}
        title={url}
        className="block w-[min(90vw,calc(82vh*0.75))] h-[82vh] border-0 bg-white"
      />
    </div>
  )
}

// A toggle in the text viewer's header bar: the same chip as the download links
// beside it, plus a lit state for "on". Icon-only ones carry their name in the
// tooltip - a native title on a button is what the tooltip conventions forbid.
function HeaderToggle({ active, onClick, tip, children }: {
  active: boolean
  onClick: () => void
  tip: string
  children: React.ReactNode
}) {
  return (
    <Tooltip content={tip}>
      <button
        type="button"
        aria-pressed={active}
        // The lightbox closes on a backdrop click; this keeps a toggle from
        // reaching it, like the download links do.
        onClick={(e) => { e.stopPropagation(); onClick() }}
        className={`flex items-center gap-1.5 h-7 px-2 rounded-md border text-2xs font-medium transition-colors cursor-pointer ${active ? CHIP_ON : CHIP_IDLE}`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

// A segmented switch - one choice, N states - for the header bar. Used for the
// before/diff/after sides of a compared file and for markdown's rendered/source.
// A segmented control rather than N chips because they ARE one choice: a lone
// "Source" chip reads as "this IS the source" as easily as "show me the source".
function SegmentedSwitch<T extends string>({ value, options, onChange }: {
  value: T
  options: { value: T; label: string; tip: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="flex items-center shrink-0 rounded-md border border-gray-200 dark:border-white/15 overflow-hidden">
      {options.map((o, i) => (
        <Tooltip key={o.value} content={o.tip}>
          <button
            type="button"
            aria-pressed={value === o.value}
            onClick={(e) => { e.stopPropagation(); onChange(o.value) }}
            className={`h-7 px-2.5 text-2xs font-medium transition-colors cursor-pointer ${i > 0 ? 'border-l border-gray-200 dark:border-white/15' : ''} ${value === o.value
              ? 'bg-gray-200 dark:bg-white/15 text-gray-900 dark:text-white'
              : 'bg-gray-50 dark:bg-white/5 text-gray-600 dark:text-white/60 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white/90'}`}
          >
            {/* The label carries the trim, never the icon - see .optical-center.
                The button keeps its own h-7, so trimming can't shrink the row. */}
            <span className="optical-center">{o.label}</span>
          </button>
        </Tooltip>
      ))}
    </div>
  )
}

// One side of a text item, as fetched.
interface TextSide {
  text: string
  truncated: boolean
}

type TextState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; before: TextSide | null; after: TextSide }

// Which side of a compared file is on screen. 'diff' is only offered when there
// are two sides to compare.
type SideView = 'diff' | 'before' | 'after'

// fetchText pulls one side down, capped: the panel would rather say "truncated"
// than pull a mislabelled 200MB blob into a string.
async function fetchText(url: string, signal: AbortSignal): Promise<TextSide> {
  const r = await fetch(url, { signal })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const body = await r.text()
  const truncated = body.length > MAX_TEXT_BYTES
  return { text: truncated ? body.slice(0, MAX_TEXT_BYTES) : body, truncated }
}

// LightboxText shows a text file's contents - a log, a report, a source file - in
// a scrollable pane with a line-number gutter, syntax highlighted by the file's
// extension and soft-wrapped by default.
//
// It is the SAME pane the repository browser shows a file in (CodePane), so a
// file reads the same wherever you open it. Two things ride on top:
//
//   - a before/after pair (a changed text artifact) opens as a unified DIFF,
//     built by the same line-diff engine the chat's Edit cards use (lib/editDiff)
//     and marked up with the same word diff the diff viewer uses;
//   - markdown opens RENDERED, through the shared <Markdown variant="doc">, with
//     a switch back to the source.
export function LightboxText({ url, filename, diff }: {
  url: string
  filename: string
  diff?: { left?: string | null; right?: string | null }
}) {
  // Both view prefs are global and sticky (localStorage, like the repository
  // browser's wrap toggle): stepping ←/→ through a directory of logs shouldn't
  // re-ask the same question per file. Absent = the default, so the key stays
  // out of storage for anyone who never touched it.
  const [wrap, setWrap] = useState(() => readLocal(StorageKeys.lightboxWrap) !== 'false')
  const [rendered, setRendered] = useState(() => readLocal(StorageKeys.lightboxMarkdownRendered) !== 'false')
  useEffect(() => { writeLocal(StorageKeys.lightboxWrap, wrap ? null : 'false') }, [wrap])
  useEffect(() => { writeLocal(StorageKeys.lightboxMarkdownRendered, rendered ? null : 'false') }, [rendered])

  // The item's two sides. `url` is the side the caller considers current (the
  // after, for a changed artifact), and diff carries the pair when there is one.
  const afterUrl = diff?.right ?? url
  const beforeUrl = diff?.left ?? null
  const hasPair = !!beforeUrl && beforeUrl !== afterUrl
  const [side, setSide] = useState<SideView>('diff')
  // Nothing to compare: 'diff'/'before' are not on offer, so whatever the user
  // last chose collapses to the one side that exists.
  const view: SideView = hasPair ? side : 'after'

  const [state, setState] = useState<TextState>({ status: 'loading' })
  // Reset to loading during render when the item changes, so a stale body never
  // shows against the new file for a frame.
  const [prevUrl, setPrevUrl] = useState(afterUrl)
  if (prevUrl !== afterUrl) { setPrevUrl(afterUrl); setState({ status: 'loading' }) }

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    // Both sides up front when there is a pair: the diff is the default view and
    // needs them together, and the switch to Before should not re-fetch.
    Promise.all([fetchText(afterUrl, ac.signal), beforeUrl ? fetchText(beforeUrl, ac.signal) : null])
      .then(([after, before]) => {
        if (!cancelled) setState({ status: 'ready', before, after })
      })
      .catch((e: unknown) => {
        // An abort is this effect tearing down, not a failure to report.
        if (cancelled || (e instanceof DOMException && e.name === 'AbortError')) return
        setState({ status: 'error', message: e instanceof Error ? e.message : String(e) })
      })
    return () => { cancelled = true; ac.abort() }
  }, [afterUrl, beforeUrl])

  const shown = state.status !== 'ready' ? null : view === 'before' ? state.before : state.after
  const text = shown?.text ?? ''
  const isMarkdown = MARKDOWN_RE.test(filename)
  // A diff of the two sources is the thing being asked for in diff view, so the
  // rendered document steps aside there.
  const asDoc = isMarkdown && rendered && view !== 'diff'
  // getLanguage (not the extension map alone) so a file the lightbox only knows
  // by name still gets the repository browser's grammar detection.
  const lang = useMemo(() => getLanguage(filename, text.slice(0, 200)), [filename, text])

  // The diff rows, numbered: buildEditRows leaves the numbers null because its
  // usual input is an Edit's FRAGMENT, which says nothing about where in the file
  // it sits. Here both whole files are in hand, so a row's position is its line.
  const rows = useMemo(() => {
    if (view !== 'diff' || state.status !== 'ready' || !state.before) return null
    // A file's final newline ends its last line rather than starting an empty
    // one - without stripping it, every text file diffs with a phantom blank row
    // at the bottom (and two files that differ only in it read as changed).
    const noEol = (s: string) => s.replace(/\n$/, '')
    return numberRows(buildEditRows(noEol(state.before.text), noEol(state.after.text)))
  }, [view, state])

  // Scroll the pane back to the top when the file (or the side) changes - ←/→
  // into another file should start at its beginning, not wherever the last one
  // was left.
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }) }, [afterUrl, view])

  const sideOptions = [
    { value: 'diff' as const, label: 'Diff', tip: 'What changed between the two versions' },
    { value: 'before' as const, label: 'Before', tip: 'The version this replaced' },
    { value: 'after' as const, label: 'After', tip: 'The current version' },
  ]

  return (
    // Sized to the file, not to the viewport: a five-line diff gets a five-line
    // panel instead of a screenful of empty pane under it. w-max/h-auto take the
    // content's own size, the max-* pair caps them where the old fixed box was,
    // and the min-* pair keeps a one-line file (or the spinner before any of it
    // has arrived) from collapsing to something smaller than the header's own
    // controls. Under wrapping the content's max-content width is its longest
    // UNWRAPPED line, so a log still hits the cap and wraps there.
    <div
      className={`${PANEL_CLASS} flex flex-col w-max h-auto max-w-[min(1100px,90vw)] max-h-[82vh] min-w-[min(36rem,90vw)] min-h-[7rem]`}
      data-lb-picture
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-white/10 shrink-0">
        <FileText className="w-4 h-4 shrink-0 text-gray-400 dark:text-white/40" />
        {/* optical-center: flexbox centres the label's LINE box, which reserves
            room for ascenders/descenders the name may not use, so it reads high
            beside the icon. Trimming to the cap-to-baseline box centres what you
            actually see. Safe under `truncate` - the class pads the box and takes
            the same amount back as a negative margin, so a descender (the p/y/g
            in "upload-retry.log") isn't sliced off by the overflow clip. */}
        <span className="optical-center min-w-0 flex-1 truncate text-2xs font-mono text-gray-500 dark:text-white/60">{filename}</span>
        {shown?.truncated && (
          <Tooltip content={`Only the first ${formatBytes(MAX_TEXT_BYTES)} is shown - download the file for the rest`}>
            <span className="flex items-center gap-1 text-3xs font-medium text-amber-600 dark:text-amber-400">
              <TriangleAlert className="w-3 h-3" />
              truncated
            </span>
          </Tooltip>
        )}
        {hasPair && <SegmentedSwitch value={view} options={sideOptions} onChange={setSide} />}
        {isMarkdown && view !== 'diff' && (
          <SegmentedSwitch
            value={rendered ? 'rendered' : 'source'}
            options={[
              { value: 'rendered', label: 'Rendered', tip: 'The markdown as a document' },
              { value: 'source', label: 'Source', tip: 'The file behind it' },
            ]}
            onChange={(v) => setRendered(v === 'rendered')}
          />
        )}
        {/* Nothing to wrap in the rendered document - prose already reflows. */}
        {!asDoc && (
          <HeaderToggle
            active={wrap}
            onClick={() => setWrap(!wrap)}
            tip={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
          >
            <WrapText className="w-3.5 h-3.5" />
          </HeaderToggle>
        )}
        <DownloadLinks url={url} diff={diff} />
      </div>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto">
        {state.status === 'loading' ? (
          <div className="flex items-center justify-center h-full text-gray-400 dark:text-white/40">
            <LoaderCircle className="w-5 h-5 animate-spin" />
          </div>
        ) : state.status === 'error' ? (
          <div className="flex flex-col items-center justify-center gap-2 h-full text-center text-gray-500 dark:text-white/50">
            <TriangleAlert className="w-6 h-6 text-amber-500 dark:text-amber-400" />
            <span className="text-xs">Could not read this file: {state.message}</span>
          </div>
        ) : rows ? (
          rows.length === 0
            ? <div className="flex items-center justify-center h-full text-xs text-gray-400 dark:text-white/40">The two versions are identical.</div>
            : <DiffPane rows={rows} lang={lang} wrap={wrap} className="py-2" />
        ) : !text ? (
          <div className="flex items-center justify-center h-full text-xs text-gray-400 dark:text-white/40">This file is empty.</div>
        ) : asDoc ? (
          // The shared renderer, in the same document variant a README gets in the
          // repository browser - so a .md reads the same wherever you open it. No
          // linkCtx: an artifact or an attachment has no repo path for a relative
          // link to resolve against, so links stay plain anchors.
          <Markdown text={text} variant="doc" className="max-w-3xl mx-auto px-6 py-5 text-gray-800 dark:text-gray-200" />
        ) : (
          <CodePane content={text} lang={lang} wrap={wrap} className="py-2" />
        )}
      </div>
    </div>
  )
}

// LightboxFile is the honest "there is nothing to preview" card: a binary the
// browser can't render (an .apk, a .zip, a .whl). It exists so every artifact and
// attachment opens into the SAME place - you don't have to know a file's type to
// know whether clicking it will do anything - and so the file's identity (name,
// size, what changed) and its download links live somewhere, rather than the click
// silently doing nothing.
export function LightboxFile({ filename, url, kind, diff }: {
  filename: string
  url: string
  kind: FileKind
  diff?: { left?: string | null; right?: string | null }
}) {
  const Icon = kind === 'binary' ? FileArchive : FileIcon
  return (
    // The byte size is deliberately NOT repeated here - the lightbox's caption
    // right below carries it (along with the change glyph and the x/y counter) for
    // every kind, and showing it twice a centimetre apart just read as a mistake.
    <div className={`${PANEL_CLASS} flex flex-col items-center gap-3 px-8 py-7 max-w-[90vw]`} data-lb-picture>
      <Icon className="w-12 h-12 text-gray-300 dark:text-white/30" />
      <div className="flex flex-col items-center gap-1 min-w-0 max-w-full">
        <span className="max-w-full truncate text-sm font-mono text-gray-700 dark:text-white/80">{filename}</span>
        <span className="text-2xs text-gray-400 dark:text-white/40">No preview available</span>
      </div>
      <div className="flex items-center gap-2">
        <DownloadLinks url={url} diff={diff} />
      </div>
    </div>
  )
}
