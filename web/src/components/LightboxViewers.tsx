// The lightbox's non-image viewers: video, PDF, text and "there is nothing to
// show, here is the file". The picture viewer lives in Lightbox.tsx itself (it is
// entangled with the zoom frame and the flight animation); everything here is a
// self-contained panel the lightbox drops into the same slot.
//
// They share one visual language so ←/→ between a screenshot, a recording and a
// build log doesn't feel like three different apps: a rounded panel on the dark
// backdrop, sized against the viewport, with the filename/size caption supplied by
// the lightbox below it rather than repeated inside.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, File as FileIcon, FileArchive, FileText, LoaderCircle, TriangleAlert } from 'lucide-react'
import { CODE_LEADING, CODE_TEXT } from '../lib/diffMetrics'
import { LIGHTBOX_MEDIA_CLASS } from '../lib/lightboxFlip'
import { highlightLines } from '../lib/highlightCore'
import { langFromPath, type FileKind } from '../lib/fileKind'
import { formatBytes } from '../lib/formatBytes'
import { Tooltip } from './Tooltip'

// How much of a text file the viewer will pull down and render. Big enough for
// any build log or source file worth reading on screen, small enough that a
// mislabelled 200MB blob can't wedge the tab: the rest is a download away, and
// the panel says so rather than pretending it showed everything.
const MAX_TEXT_BYTES = 512 * 1024
// Above this, syntax highlighting is skipped and the text renders plain. Prism
// runs synchronously on the main thread here (unlike the diff viewer, which has a
// worker), and a megabyte of tokenising is a visible freeze on opening.
const MAX_HIGHLIGHT_BYTES = 128 * 1024

// The panel every non-image viewer sits in: dark, rounded, capped against the
// viewport. LIGHTBOX_MEDIA_CLASS marks it as the item's own box, so the open/close
// flight (when there was a tile to fly from) measures the panel rather than the
// full-width wrapper it is centred in.
const PANEL_CLASS = `${LIGHTBOX_MEDIA_CLASS} dark rounded-lg shadow-2xl border border-white/10 bg-gray-900 overflow-hidden`

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
        className="flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-white/15 bg-white/5 text-[11px] font-medium text-white/80 hover:bg-white/15 hover:text-white transition-colors cursor-pointer"
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
export function LightboxVideo({ url, aspect }: { url: string; aspect?: number }) {
  return (
    <div className={PANEL_CLASS} data-lb-picture>
      {/* autoPlay + muted + loop mirrors how the grid tiles behave, so opening a
          clip continues rather than restarts the impression of it; controls are
          the browser's because there is only one clip to drive. */}
      <video
        src={url}
        controls
        autoPlay
        loop
        muted
        playsInline
        style={{ aspectRatio: aspect }}
        className="block max-w-[90vw] max-h-[85vh]"
      />
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
    <div className={`${PANEL_CLASS} bg-gray-800`} data-lb-picture>
      <iframe
        src={url}
        title={url}
        className="block w-[min(90vw,calc(82vh*0.75))] h-[82vh] border-0 bg-white"
      />
    </div>
  )
}

type TextState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; text: string; truncated: boolean }

// LightboxText shows a text file's contents - a log, a diff, a source file - in a
// scrollable monospace pane, syntax highlighted by the file's extension.
//
// The whole body is set as ONE html string rather than a node per line: a build
// log runs to thousands of lines, and a React element per line made opening a big
// one visibly slow for no gain (there is nothing per-line to interact with here -
// no gutter, no selection state, no viewed markers, unlike the diff viewer).
export function LightboxText({ url, filename, diff }: {
  url: string
  filename: string
  diff?: { left?: string | null; right?: string | null }
}) {
  const [state, setState] = useState<TextState>({ status: 'loading' })
  // Reset to loading during render when the url changes, so a stale body never
  // shows against the new file for a frame.
  const [prevUrl, setPrevUrl] = useState(url)
  if (prevUrl !== url) { setPrevUrl(url); setState({ status: 'loading' }) }

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    fetch(url, { signal: ac.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const body = await r.text()
        if (cancelled) return
        const truncated = body.length > MAX_TEXT_BYTES
        setState({ status: 'ready', text: truncated ? body.slice(0, MAX_TEXT_BYTES) : body, truncated })
      })
      .catch((e: unknown) => {
        // An abort is this effect tearing down, not a failure to report.
        if (cancelled || (e instanceof DOMException && e.name === 'AbortError')) return
        setState({ status: 'error', message: e instanceof Error ? e.message : String(e) })
      })
    return () => { cancelled = true; ac.abort() }
  }, [url])

  const text = state.status === 'ready' ? state.text : ''
  const html = useMemo(() => {
    if (!text) return ''
    const lang = langFromPath(filename)
    // Over the highlight budget (or with no grammar for this extension)
    // highlightLines still returns HTML-escaped lines, which is exactly the plain
    // rendering we want - so the same call covers both.
    return highlightLines(text, text.length > MAX_HIGHLIGHT_BYTES ? 'plaintext' : (lang || 'plaintext')).join('\n')
  }, [text, filename])

  // Scroll the pane back to the top when the file changes - ←/→ into another file
  // should start at its beginning, not wherever the last one was left.
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }) }, [url])

  return (
    <div className={`${PANEL_CLASS} flex flex-col w-[min(1100px,90vw)] h-[82vh]`} data-lb-picture>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 shrink-0">
        <FileText className="w-4 h-4 shrink-0 text-white/40" />
        {/* optical-center: flexbox centres the label's LINE box, which reserves
            room for ascenders/descenders the name may not use, so it reads high
            beside the icon. Trimming to the cap-to-baseline box centres what you
            actually see. Safe under `truncate` - the class pads the box and takes
            the same amount back as a negative margin, so a descender (the p/y/g
            in "upload-retry.log") isn't sliced off by the overflow clip. */}
        <span className="optical-center min-w-0 flex-1 truncate text-[11px] font-mono text-white/60">{filename}</span>
        {state.status === 'ready' && state.truncated && (
          <Tooltip content={`Only the first ${formatBytes(MAX_TEXT_BYTES)} is shown - download the file for the rest`}>
            <span className="flex items-center gap-1 text-[10px] font-medium text-amber-400">
              <TriangleAlert className="w-3 h-3" />
              truncated
            </span>
          </Tooltip>
        )}
        <DownloadLinks url={url} diff={diff} />
      </div>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto">
        {state.status === 'loading' ? (
          <div className="flex items-center justify-center h-full text-white/40">
            <LoaderCircle className="w-5 h-5 animate-spin" />
          </div>
        ) : state.status === 'error' ? (
          <div className="flex flex-col items-center justify-center gap-2 h-full text-center text-white/50">
            <TriangleAlert className="w-6 h-6 text-amber-400" />
            <span className="text-xs">Could not read this file: {state.message}</span>
          </div>
        ) : text ? (
          // The token colours come from the global `.dark .token` palette (index.css),
          // which applies because PANEL_CLASS forces this subtree `dark` - so the code
          // reads the same as the diff viewer's, whatever theme the app is in. Same
          // reason it takes the diff's size classes rather than a fixed text-xs: the
          // Code size control has to move this with everything else it reads like.
          <pre className={`p-3 font-mono ${CODE_TEXT} ${CODE_LEADING} text-gray-200`}>
            <code dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
        ) : (
          <div className="flex items-center justify-center h-full text-xs text-white/40">This file is empty.</div>
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
      <Icon className="w-12 h-12 text-white/30" />
      <div className="flex flex-col items-center gap-1 min-w-0 max-w-full">
        <span className="max-w-full truncate text-sm font-mono text-white/80">{filename}</span>
        <span className="text-[11px] text-white/40">No preview available</span>
      </div>
      <div className="flex items-center gap-2">
        <DownloadLinks url={url} diff={diff} />
      </div>
    </div>
  )
}
