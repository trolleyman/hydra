import { createContext, memo, type ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { useNavigate } from '@tanstack/react-router'
import { ImageOff, Maximize2, VideoOff } from 'lucide-react'
import { highlightCode } from './markdown'
import { fileKind } from './fileKind'
import { Tooltip } from '../components/Tooltip'
import { setMarkdownSource } from './copyMarkdown'
import { buildRepoSplat } from './repoSplat'
import { UPLOAD_PATH_RE } from './uploadAttachments'
import { useLightbox } from '../stores/lightboxStore'
import { markdownGalleryAt } from './markdownGallery'
import { densityFromPath, logicalSize, useNaturalSize, useNaturalVideoSize } from './imageDensity'
import { rememberMediaSize } from './mediaSize'
import { IMAGE_REFLOW_MS, markSelfReflow } from './selfReflow'
import { agentFileUrl, uploadBlobUrl } from '../api/uploads'
import { ansiToHtml, ansiToText, hasAnsi } from './ansi'
import { renderCommentMentions } from './mentionHighlight'
import { FilePathLabel } from '../components/FilePathLabel'

// Shared read-only markdown renderer. Wraps react-markdown + remark-gfm so every
// rendered-markdown surface (chat messages, the AgentView prompt, README file
// previews, config pre-prompt previews) gets the same feature set: GFM tables,
// task lists, strikethrough, autolinks, plus fenced code highlighted through our
// existing highlight.js (highlightCode) rather than a second highlighter.
//
// remark-breaks (the 'chat' variant only) turns a single source newline into a
// hard <br>, matching the old whitespace-pre-wrap chat behaviour - authored text
// (chat, prompt, config previews) should honour the newlines a person typed. The
// 'doc' variant (README) deliberately omits it and uses standard CommonMark
// paragraph reflow (single newline -> space), like GitHub renders a README: prose
// hard-wrapped at ~80 columns reads better reflowed than broken at every line.
// `hardBreaks` overrides that per call site, for text that wants compact chat
// styling but document reflow - a commit message, which is hard-wrapped at ~72
// columns by convention and reads as ragged nonsense with a <br> per line.
//
// The editable textarea overlay (renderMarkdownSource in ./markdown) is NOT one
// of these surfaces: it must keep every source character glyph-for-glyph aligned
// with the caret, which a rendering library cannot do, so it keeps its own parser.

// RepoLinkContext carries what relative-link resolution needs for README
// previews: the project, the ref being browsed, and the current file's
// repo-relative path (so a link like `docs/x.md` resolves against the file's own
// directory). Omitted for chat/prompt/config, where links are plain anchors.
export interface RepoLinkContext {
  projectId: string
  refStr: string
  filePath: string
  // Chat messages may contain absolute paths emitted by an agent. Strip this
  // worktree prefix before routing them into the repository browser.
  worktreePath?: string
  // The head whose files a chat message's images resolve against (see
  // MarkdownImage). Unset for surfaces with no head - README previews, the
  // config pre-prompt - where a local-path image simply isn't rendered.
  agentId?: string
}

type Variant = 'chat' | 'doc'

// --- Link resolution (README relative links) ---------------------------------

// isExternalHref reports whether a link target has a URL scheme (http:, mailto:,
// ...) or is protocol-relative (//host) - i.e. it points outside the repo.
function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')
}

// dirOf returns the directory portion of a repo-relative file path ('' at root).
function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(0, i) : ''
}

// resolveRepoPath resolves a relative link target against a base directory,
// collapsing '.'/'..'. A leading '/' makes it repo-root-relative.
function resolveRepoPath(baseDir: string, rel: string): string {
  const parts = rel.startsWith('/') || !baseDir ? [] : baseDir.split('/')
  for (const seg of rel.replace(/^\/+/, '').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { parts.pop(); continue }
    parts.push(seg)
  }
  return parts.join('/')
}

// encodePath percent-encodes each path segment while keeping the '/' separators.
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

// Links sit one neutral colour step above the surrounding prose at the same
// weight, with a fine dotted underline that becomes solid on interaction. A
// linked code chip owns its own bordered shape, so suppress the underline there
// and strengthen its neutral border instead.
const LINK_CLASS = 'text-stone-800 dark:text-stone-100 underline decoration-dotted decoration-stone-400/70 dark:decoration-stone-500/80 underline-offset-2 hover:decoration-solid focus-visible:decoration-solid [&:has(>code)]:no-underline [&>code]:border-stone-400/70 dark:[&>code]:border-stone-500/70'

// FileLink keeps the author's exact Markdown label in the prose, then uses the
// tooltip for the richer file treatment shared with repository surfaces: a
// Lucide file-kind icon, a lowlit directory and an emphasized filename.
function FileLink({ href, path, onClick, children }: {
  href: string
  path: string
  onClick: (e: React.MouseEvent<HTMLAnchorElement>) => void
  children?: ReactNode
}) {
  return (
    <Tooltip
      content={(
        <FilePathLabel path={path} nativeTitle={false} />
      )}
    >
      <a className={LINK_CLASS} href={href} onClick={onClick}>{children}</a>
    </Tooltip>
  )
}

// RepoLink renders a README link. External links and in-page anchors are plain
// anchors (external open in a new tab); a relative repo link is resolved against
// the current file and, on a plain left-click, navigates the repository view in
// app - while its real href lets middle/ctrl-click open it in a new tab.
function RepoLink({ href, ctx, children, fileChip = false }: { href?: string; ctx: RepoLinkContext; children?: ReactNode; fileChip?: boolean }) {
  const navigate = useNavigate()
  if (!href) return <a className={LINK_CLASS}>{children}</a>
  if (href.startsWith('#')) return <a className={LINK_CLASS} href={href}>{children}</a>
  if (isExternalHref(href)) {
    return <a className={LINK_CLASS} href={href} target="_blank" rel="noreferrer">{children}</a>
  }
  const hashIdx = href.indexOf('#')
  const hash = hashIdx >= 0 ? href.slice(hashIdx) : ''
  let path = hashIdx >= 0 ? href.slice(0, hashIdx) : href
  const q = path.indexOf('?')
  if (q >= 0) path = path.slice(0, q)
  let lineHash = hash
  const line = /:(\d+)(?::\d+)?$/.exec(path)
  if (line) {
    path = path.slice(0, -line[0].length)
    if (!lineHash) lineHash = `#L${line[1]}`
  }
  const authoredPath = path
  if (ctx.worktreePath && (path === ctx.worktreePath || path.startsWith(ctx.worktreePath + '/'))) {
    path = path.slice(ctx.worktreePath.length).replace(/^\/+/, '')
  }
  const resolved = resolveRepoPath(dirOf(ctx.filePath), path)
  const splat = buildRepoSplat(ctx.refStr, resolved)
  const url = `/project/${encodePath(ctx.projectId)}/repository/${encodePath(splat)}${lineHash}`
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate({
      to: '/project/$projectId/repository/$',
      params: { projectId: ctx.projectId, _splat: splat },
      hash: lineHash ? lineHash.slice(1) : undefined,
    })
  }
  if (fileChip && resolved) {
    // Preserve an authored absolute path in the tooltip even though navigation
    // uses its repo-relative equivalent. Relative links show the resolved repo
    // path, which is more useful than an unresolved ../ sequence.
    const displayPath = authoredPath.startsWith('/') ? authoredPath : resolved
    return <FileLink href={url} path={displayPath} onClick={onClick}>{children}</FileLink>
  }
  return <a className={LINK_CLASS} href={url} onClick={onClick}>{children}</a>
}

// --- Images and video -----------------------------------------------------------

// isDataHref matches the URL forms an <img>/<video> can load directly without
// going through the backend (remote, inline, or an object URL).
function isDataHref(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src) || src.startsWith('//')
}

// resolveMediaSrc turns a markdown image target into something the browser can
// actually fetch. An agent writes a screenshot to its worktree or to /tmp and
// then references that path - which means nothing to the browser - so a local
// path is routed through the agent-files endpoint, which serves it from the
// head's own filesystem. Falls back to the uploads blob endpoint for a path in
// the project's uploads dir (the user's own pasted images, which surfaces
// without a head still show). Returns null when nothing can serve it.
function resolveMediaSrc(src: string, ctx?: RepoLinkContext): string | null {
  if (!src) return null
  if (isDataHref(src)) return src
  if (ctx?.agentId) return agentFileUrl(ctx.projectId, ctx.agentId, src)
  const upload = UPLOAD_PATH_RE.exec(src)
  UPLOAD_PATH_RE.lastIndex = 0
  if (upload && ctx) return uploadBlobUrl(ctx.projectId, upload[0].split('/').pop() ?? '')
  return null
}

// MediaChip is what a markdown image or video degrades to when nothing can serve
// it - an unservable path, or a scratch file that has since been reclaimed. A
// muted chip naming the file, rather than the browser's broken-media box.
function MediaChip({ src, label, icon: Icon }: { src?: string; label: string; icon: typeof ImageOff }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-gray-300/60 dark:border-gray-500/30 bg-gray-100/70 dark:bg-black/25 px-1.5 py-0.5 align-middle text-[0.85em] text-gray-600 dark:text-gray-400"
      title={src}
    >
      <Icon className="w-3.5 h-3.5 shrink-0 opacity-70" aria-hidden="true" />
      {label}
    </span>
  )
}

// mediaLabel is what a markdown image/video is called when it has no alt text:
// its filename, which is the most an unresolvable path can say about itself.
function mediaLabel(src: string | undefined, alt: string | undefined, fallback: string): string {
  return alt || (src ? src.split('/').pop() || src : fallback)
}

// MarkdownVideo renders a markdown image whose target is a RECORDING (.webm,
// .mp4, ...). An agent demoing a transition, a hover state or a flow has nothing
// a still can show, and `![alt](clip.webm)` is the syntax it already knows - so
// the same markdown, the same agent-files endpoint (which answers Range requests
// through http.ServeContent, hence seeking) and the same @2x logical sizing, with
// a <video> in place of the <img>.
//
// The browser's own controls are kept, which spends the click on the frame: it
// toggles playback. So the lightbox gets its own affordance instead - an expand
// button in the corner, revealed on hover - exactly as the artifacts grid's video
// tiles do (see RepositoryArtifactsView).
function MarkdownVideo({ src, alt, ctx }: { src?: string; alt?: string; ctx?: RepoLinkContext }) {
  const openLightbox = useLightbox()
  const wrapRef = useRef<HTMLSpanElement>(null)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const url = src ? resolveMediaSrc(src, ctx) : null
  const label = mediaLabel(src, alt, 'video')
  const density = densityFromPath(src)
  const natural = useNaturalVideoSize(url)
  const logical = natural ? logicalSize(natural, density) : null
  // Same reflow declaration as an image: a clip's box arrives with its metadata,
  // a layout or two after it mounts, and a chat pane following a live turn must
  // read that growth as ours rather than as the reader scrolling away.
  const logicalW = logical?.w ?? 0
  const logicalH = logical?.h ?? 0
  useLayoutEffect(() => {
    if (logicalW > 0) markSelfReflow(IMAGE_REFLOW_MS)
  }, [logicalW, logicalH])
  if (!url || failedSrc === src) return <MediaChip src={src} label={label} icon={VideoOff} />
  return (
    // A span, not a div: this sits inside a <p> (markdown images are inline
    // content), and a block element there is invalid HTML the browser fixes by
    // splitting the paragraph around it.
    <span ref={wrapRef} className="relative inline-block group/mdvideo align-bottom">
      <video
        src={url}
        controls
        playsInline
        // Metadata only: a transcript can hold several clips and none of them
        // should pull their whole file down before the reader asks to play one.
        preload="metadata"
        width={logical?.w}
        height={logical?.h}
        aria-label={label}
        className="my-1 max-w-full h-auto rounded-md ring-1 ring-gray-200 dark:ring-gray-600/40 block"
        data-md-src={src}
        // The alt text VERBATIM, which aria-label is not - that falls back to the
        // filename when there is none, and copy-as-markdown has to give back
        // `![](clip.webm)` rather than inventing a caption (lib/copyMarkdown).
        data-md-alt={alt}
        onLoadedMetadata={(e) => {
          markSelfReflow(IMAGE_REFLOW_MS)
          rememberMediaSize(url, e.currentTarget.videoWidth, e.currentTarget.videoHeight)
        }}
        onError={() => setFailedSrc(src ?? null)}
      />
      <Tooltip content="Open fullscreen" className="absolute top-2.5 right-1.5">
        <button
          type="button"
          aria-label={`Open ${label} fullscreen`}
          className="flex items-center justify-center w-7 h-7 rounded-md bg-black/55 text-white/90 opacity-0 group-hover/mdvideo:opacity-100 focus-visible:opacity-100 hover:bg-black/75 transition-opacity cursor-pointer"
          onClick={() => {
            const { items, index } = markdownGalleryAt(wrapRef.current)
            // The wrapper is the flight origin, so the clip flies out of its own
            // box rather than fading in over it.
            openLightbox(items, index, wrapRef.current)
          }}
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </Tooltip>
    </span>
  )
}

// MarkdownImage renders a markdown image. Anything that resolves is shown at its
// logical size (natural px / the @2x density in its name, capped to the column)
// and opens in the app-wide lightbox on click - as a gallery of the media in
// its own markdown block, so ←/→ walk the pictures of that one message (see
// lib/markdownGallery).
function MarkdownImage({ src, alt, ctx }: { src?: string; alt?: string; ctx?: RepoLinkContext }) {
  const openLightbox = useLightbox()
  // The source that failed to load, rather than a bare flag: a streamed message
  // rewrites the same node's src as more text arrives, and keying the failure to
  // the src means a new one is retried instead of inheriting the old verdict.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const url = src ? resolveMediaSrc(src, ctx) : null
  const label = mediaLabel(src, alt, 'image')
  const density = densityFromPath(src)
  const natural = useNaturalSize(url)
  const logical = natural ? logicalSize(natural, density) : null
  // An image is the one thing in a chat message whose height arrives LATER than
  // it does: it mounts with no box at all (nothing knows its size until the
  // off-screen decode lands) and then, a layout or two on, is suddenly several
  // hundred pixels tall. A chat pane following a live turn reads a scrollTop
  // that moved on its own as the reader scrolling away, and the shrink the
  // image replaced can coalesce with its own growth into one scroll event where
  // only scrollTop looks like it moved - so a big picture landing at the end of
  // a streaming message could unpin the view and stop it following. Declaring
  // the reflow is what tells the pane it was us (see lib/selfReflow).
  //
  // Depends on the size's NUMBERS, not the object: logicalSize builds a fresh
  // one per render, and re-marking every render would hold the window open for
  // the whole message and swallow a genuine scroll-up.
  const logicalW = logical?.w ?? 0
  const logicalH = logical?.h ?? 0
  useLayoutEffect(() => {
    if (logicalW > 0) markSelfReflow(IMAGE_REFLOW_MS)
  }, [logicalW, logicalH])
  if (!url || failedSrc === src) return <MediaChip src={src} label={label} icon={ImageOff} />
  return (
    <img
      src={url}
      alt={label}
      // Laid out at its LOGICAL size: physical px / the @2x density in the name,
      // so a 2x capture is the same size as a 1x one, just sharp. The size is
      // measured off-screen first (useNaturalSize) so the visible image gets its
      // width on the FIRST layout instead of painting big and snapping smaller.
      width={logical?.w}
      height={logical?.h}
      // A ring, NOT a border: with border-box sizing a 1px border eats 2px out of
      // the content box the width attr set, and the browser then resamples the
      // image into the remainder (420 -> 418x199.047), softening every pixel.
      className="my-1 max-w-full h-auto rounded-md ring-1 ring-gray-200 dark:ring-gray-600/40 cursor-zoom-in"
      // The path as written, so copy-as-markdown gives back the source rather
      // than the blob URL we rewrote it to (lib/copyMarkdown).
      data-md-src={src}
      loading="lazy"
      // The pixels landing is the second half of the same reflow as the size
      // landing above - and the one that actually takes the space, when the
      // decode beat the layout to it.
      onLoad={(e) => {
        markSelfReflow(IMAGE_REFLOW_MS)
        // The bytes are the last word on how big this picture is. Usually it
        // just confirms what we laid it out at; it matters when an agent has
        // rewritten the file since it was measured (the blob endpoint sends
        // no-cache for the same reason), and it means the lightbox opens on the
        // real size rather than a stale one.
        rememberMediaSize(url, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)
      }}
      onError={() => setFailedSrc(src ?? null)}
      // Opens the whole markdown block's images, at this one - so ←/→ step
      // between the pictures of THIS message and stop at its edges (see
      // lib/markdownGallery). The <img> itself is handed over as the open origin,
      // so the lightbox flies the picture out of exactly this box rather than
      // fading in over it.
      onClick={(e) => {
        const { items, index } = markdownGalleryAt(e.currentTarget)
        openLightbox(items, index, e.currentTarget)
      }}
    />
  )
}

// MarkdownMedia picks the element a markdown image target gets. By EXTENSION,
// off the path as authored: markdown has one syntax for embedded media, and the
// name is all that is known before anything is fetched (the same rule lib/
// fileKind applies everywhere else, and the same list the agent-files endpoint
// allows). A data:/blob: URL has no extension and stays an image, which is what
// every existing caller of those forms emits.
function MarkdownMedia({ src, alt, ctx }: { src?: string; alt?: string; ctx?: RepoLinkContext }) {
  if (src && fileKind(src) === 'video') return <MarkdownVideo src={src} alt={alt} ctx={ctx} />
  return <MarkdownImage src={src} alt={alt} ctx={ctx} />
}

// --- Per-variant styling ------------------------------------------------------

interface Style {
  h1: string; h2: string; h3: string; h4: string; h5: string; h6: string
  p: string; ul: string; ol: string; li: string; blockquote: string; hr: string
  tableWrap: string; table: string; th: string; td: string; tbody: string
  codeInline: string; codeBlock: string
}

const STYLES: Record<Variant, Style> = {
  // Compact styling for chat / prompt / config previews (mirrors the retired
  // renderMarkdownBlocks look: tight vertical rhythm, no heading borders).
  //
  // The headings and the table are sized in em - a multiple of the prose they
  // sit in - rather than the absolute rem they used to be. A heading has to move
  // with its own body, and this variant renders at half a dozen different body
  // sizes: 13px chat prose, 14px when the chat font is a serif, 12px sub-agent
  // cards and review comments, 10px config previews, and any of those shifted by
  // the Chat size control. Absolute headings meant a fixed 16px h1 in all of
  // them - 1.23x the body in one place and 1.6x in another - and it is why these
  // needed the size step spelled out in a calc(): em follows it for free.
  //
  // The ratios are today's chat numbers over today's 13px chat base (16/13,
  // 15.2/13, 14/13), so a sans chat pane and the 13px dialog preview render
  // exactly as before. Everywhere else the heading is now proportional to its
  // body instead of fixed, which is the point - most visibly in serif chat (the
  // default), where an h1 was only 1.14x its 14px prose and is now 1.23x like
  // the sans pane's. Inline code and code blocks were already em and needed
  // nothing.
  chat: {
    h1: 'text-[length:1.2308em] font-bold mt-3 mb-1 first:mt-0',
    h2: 'text-[length:1.1692em] font-bold mt-3 mb-1 first:mt-0',
    h3: 'text-[length:1.0769em] font-semibold mt-2 mb-0.5 first:mt-0',
    h4: 'text-[length:1.0769em] font-semibold mt-2 mb-0.5 first:mt-0',
    h5: 'text-[length:1.0769em] font-semibold mt-2 mb-0.5 first:mt-0',
    h6: 'text-[length:1.0769em] font-semibold mt-2 mb-0.5 first:mt-0',
    p: 'my-1 first:mt-0 last:mb-0 break-words',
    ul: 'list-disc pl-5 my-1 space-y-0.5',
    ol: 'list-decimal pl-5 my-1 space-y-0.5',
    li: 'break-words',
    blockquote: 'border-l-2 border-gray-400 dark:border-gray-500 pl-2 my-1 opacity-80 break-words',
    hr: 'my-2 border-gray-300 dark:border-gray-600',
    // Clean framed table: one rounded outer border (no per-cell gridlines), a
    // tinted header row, horizontal row rules only, and subtle zebra striping.
    // Warm stone tones (not cool gray) so it doesn't read blue against the chat
    // view's warm palette (#faf9f5 / #262624, stone borders, white/opacity tints).
    // `w-fit` (paired with the table dropping `w-full`) hugs the content instead
    // of stretching to fill the chat column; `max-w-full` still caps it and
    // `overflow-x-auto` scrolls a genuinely wide table.
    tableWrap: 'my-2 w-fit max-w-full overflow-x-auto rounded-lg border border-stone-200 dark:border-white/10',
    // No size of its own: a table is body content, not a heading, so it reads at
    // the size of the prose around it. It carried a literal 14px from the days
    // when chat prose was 14px too; prose has since moved (13px sans, 14px
    // serif, 12px sub-agent cards, 10px config previews) and the table did not,
    // so it rendered 1.077x its surroundings everywhere and read as a size step
    // up mid-paragraph.
    table: 'border-collapse',
    th: 'px-3 py-1.5 text-left font-semibold text-stone-700 dark:text-stone-200 bg-stone-100/70 dark:bg-white/[0.04] border-b border-stone-200 dark:border-white/10 whitespace-nowrap',
    td: 'px-3 py-1.5 border-b border-stone-200/60 dark:border-white/[0.06] align-top',
    tbody: '[&>tr:last-child>td]:border-b-0 [&>tr:nth-child(even)]:bg-stone-500/[0.04] dark:[&>tr:nth-child(even)]:bg-white/[0.025]',
    // Claude-app-style code (chat items 1/10): bordered terracotta chips for
    // inline code, a bordered near-black warm panel for blocks in dark mode.
    // Kept in sync with CODE_CLASS/CODEBLOCK_CLASS in ./markdown (the inline
    // renderer used for activity lines / prompt previews).
    codeInline:
      'rounded box-decoration-clone border border-gray-300/60 dark:border-gray-500/30 bg-gray-100/70 dark:bg-black/25 px-1 font-mono text-[0.9em] text-[#a8462d] dark:text-[#eab6a0]',
    codeBlock:
      'block my-1 rounded-md border border-gray-200 dark:border-gray-600/40 bg-gray-50 dark:bg-[#1d1c1a] px-2.5 py-1.5 font-mono text-[0.85em] text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words',
  },
  // Roomier, document-like styling for README previews (mirrors the retired
  // RepositoryView renderer: larger headings with rules, more spacing).
  doc: {
    h1: 'text-2xl font-semibold mt-5 mb-2 pb-1 border-b border-gray-200 dark:border-gray-700 first:mt-0',
    h2: 'text-xl font-semibold mt-5 mb-2 pb-1 border-b border-gray-200 dark:border-gray-700 first:mt-0',
    h3: 'text-lg font-semibold mt-5 mb-2 first:mt-0',
    h4: 'text-base font-semibold mt-5 mb-2 first:mt-0',
    h5: 'text-sm font-semibold mt-5 mb-2 first:mt-0',
    h6: 'text-sm font-semibold mt-5 mb-2 first:mt-0',
    p: 'my-2 leading-relaxed break-words',
    ul: 'list-disc pl-6 my-2 space-y-1',
    ol: 'list-decimal pl-6 my-2 space-y-1',
    li: 'break-words',
    blockquote: 'border-l-4 border-gray-300 dark:border-gray-600 pl-4 my-3 opacity-90',
    hr: 'my-4 border-gray-200 dark:border-gray-700',
    // Same framed look as chat, roomier cell padding for document density.
    tableWrap: 'my-4 max-w-full overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700',
    table: 'w-full border-collapse text-sm',
    th: 'px-4 py-2 text-left font-semibold text-gray-700 dark:text-gray-200 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700 whitespace-nowrap',
    td: 'px-4 py-2 border-b border-gray-100 dark:border-gray-800 align-top',
    tbody: '[&>tr:last-child>td]:border-b-0 [&>tr:nth-child(even)]:bg-gray-500/[0.035] dark:[&>tr:nth-child(even)]:bg-white/[0.03]',
    // Doc code stays neutral (a README isn't a chat bubble) but picks up the
    // same readability fix: a border and a darker dark-mode panel.
    codeInline:
      'px-1 py-0.5 rounded border border-gray-200 dark:border-gray-600/40 bg-gray-100 dark:bg-black/25 text-[0.85em] font-mono',
    codeBlock:
      'block my-3 p-3 rounded-lg border border-gray-200 dark:border-gray-600/40 bg-gray-50 dark:bg-[#1d1c1a] overflow-x-auto text-sm font-mono whitespace-pre',
  },
}

// --- Code blocks vs inline code -----------------------------------------------

// InCodeBlock tells the `code` component that it is rendering a code BLOCK
// rather than an inline `code` span.
//
// Being a child of <pre> is the only thing that separates the two: markdown
// gives a fenced (or indented) block and an inline span the same <code>
// element, and react-markdown dropped the `inline` prop it used to pass in v9.
// Guessing from the content instead - "no language and no newline means
// inline", which this did - gets a one-line fence with no info string wrong,
// and that is exactly how a command gets written:
//
//     ```
//     git rebase --onto main x y
//     ```
//
// which is a block by the spec but rendered as an inline chip mid-sentence.
const InCodeBlock = createContext(false)

// MarkdownCode renders one <code> element: an inline chip, or - inside a <pre> -
// the block, highlighted through our own highlight.js pass. data-md-code-block /
// data-md-lang let copy-as-markdown (lib/copyMarkdown) tell the two apart too,
// and put the fence and its info string back when a block is copied as part of
// a wider selection.
function MarkdownCode({ s, className, children }: { s: Style; className?: string; children?: ReactNode }) {
  const block = useContext(InCodeBlock)
  if (!block) return <code className={s.codeInline}>{children}</code>
  const text = String(children ?? '').replace(/\n$/, '')
  const lang = /language-([\w-]+)/.exec(className || '')?.[1] ?? ''
  // Captured command/test output is commonly fenced into a prompt or chat
  // message with its terminal colours intact. An untyped output block keeps
  // those colours. When the author supplied a fence language, preserve the more
  // informative syntax highlighting and remove terminal control bytes before
  // feeding the text to the grammar - one coloured WARN must not disable
  // highlighting for the entire block.
  const ansi = hasAnsi(text)
  const html = ansi && !lang
    ? ansiToHtml(text)
    : highlightCode(ansi ? ansiToText(text) : text, lang)
  // No highlighter root class: the `.token` spans carry their own colours,
  // while a root class would also pull in a theme's white bg.
  if (html != null) {
    return (
      <code
        className={s.codeBlock}
        data-md-code-block=""
        data-md-lang={lang}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }
  return <code className={s.codeBlock} data-md-code-block="" data-md-lang={lang}>{text}</code>
}

// cellAlign turns remark-gfm's per-cell `align` into a text-align style.
function alignStyle(align?: string | null): React.CSSProperties | undefined {
  return align ? { textAlign: align as React.CSSProperties['textAlign'] } : undefined
}

// 'chat' honours single newlines as <br> (remark-breaks); 'doc' reflows them
// (standard CommonMark) - see the file header for why.
type RemarkPlugins = React.ComponentProps<typeof ReactMarkdown>['remarkPlugins']
const BREAK_PLUGINS: RemarkPlugins = [remarkGfm, remarkBreaks]
const REFLOW_PLUGINS: RemarkPlugins = [remarkGfm]

// buildComponents maps markdown elements to the variant's styled React nodes.
function mentionChildren(children: ReactNode, enabled: boolean): ReactNode {
  if (!enabled) return children
  if (typeof children === 'string') return renderCommentMentions(children)
  if (Array.isArray(children)) {
    return children.map((child) => mentionChildren(child, true))
  }
  return children
}

function buildComponents(s: Style, variant: Variant, linkCtx?: RepoLinkContext, highlightMentions = false): Components {
  const prose = (children: ReactNode) => mentionChildren(children, highlightMentions)
  return {
    h1: ({ children }) => <h1 className={s.h1}>{prose(children)}</h1>,
    h2: ({ children }) => <h2 className={s.h2}>{prose(children)}</h2>,
    h3: ({ children }) => <h3 className={s.h3}>{prose(children)}</h3>,
    h4: ({ children }) => <h4 className={s.h4}>{prose(children)}</h4>,
    h5: ({ children }) => <h5 className={s.h5}>{prose(children)}</h5>,
    h6: ({ children }) => <h6 className={s.h6}>{prose(children)}</h6>,
    p: ({ children }) => <p className={s.p}>{prose(children)}</p>,
    ul: ({ children, className }) => (
      <ul className={`${s.ul}${className?.includes('contains-task-list') ? ' list-none pl-0' : ''}`}>{children}</ul>
    ),
    ol: ({ children, start }) => <ol className={s.ol} start={start}>{children}</ol>,
    li: ({ children }) => <li className={s.li}>{children}</li>,
    blockquote: ({ children }) => <blockquote className={s.blockquote}>{children}</blockquote>,
    hr: () => <hr className={s.hr} />,
    strong: ({ children }) => <strong className="font-semibold">{prose(children)}</strong>,
    em: ({ children }) => <em className="italic">{prose(children)}</em>,
    del: ({ children }) => <del className="line-through opacity-80">{prose(children)}</del>,
    a: ({ href, children }) =>
      linkCtx ? (
        <RepoLink href={href} ctx={linkCtx} fileChip={variant === 'chat'}>{children}</RepoLink>
      ) : (
        <a className={LINK_CLASS} href={href} target="_blank" rel="noreferrer">{children}</a>
      ),
    img: ({ src, alt }) => <MarkdownMedia src={typeof src === 'string' ? src : undefined} alt={alt} ctx={linkCtx} />,
    table: ({ children }) => (
      <div className={s.tableWrap}>
        <table className={s.table}>{children}</table>
      </div>
    ),
    tbody: ({ children }) => <tbody className={s.tbody}>{children}</tbody>,
    th: ({ children, style }) => <th className={s.th} style={alignStyle(style?.textAlign)}>{children}</th>,
    td: ({ children, style }) => <td className={s.td} style={alignStyle(style?.textAlign)}>{children}</td>,
    // react-markdown wraps code blocks in <pre>; we style the inner <code> as a
    // display:block element instead, so strip <pre>'s own box - but not before
    // it has marked what it holds as a block (see InCodeBlock).
    pre: ({ children }) => <InCodeBlock.Provider value={true}>{children}</InCodeBlock.Provider>,
    code: ({ className, children }) => <MarkdownCode s={s} className={className}>{children}</MarkdownCode>,
  }
}

export interface MarkdownProps {
  // The markdown source to render.
  text: string
  // Styling density. 'chat' (default) is compact; 'doc' is document-like (README).
  variant?: Variant
  // When set, relative links resolve against a repo file and navigate in-app.
  linkCtx?: RepoLinkContext
  // Wrapper class (e.g. text colour / max-width) applied to the outer container.
  className?: string
  // Whether a single source newline is a hard <br>. Defaults to the variant's
  // own behaviour ('chat' yes, 'doc' no); set it false to keep chat styling but
  // reflow paragraphs the way CommonMark (and GitHub) do.
  hardBreaks?: boolean
  // Paint routing mentions in review comments. Mentions have no meaning on
  // ordinary Markdown surfaces, so callers opt in explicitly.
  highlightMentions?: boolean
}

// Markdown renders read-only markdown for a given surface. Do NOT wrap it in a
// whitespace-pre-wrap container - block elements manage their own spacing and
// remark-breaks already preserves single newlines as <br>.
//
// memo'd: parsing markdown is not cheap, and a chat transcript can hold hundreds
// of these. Without memo, typing in the chat composer (a sibling state change)
// re-parses every rendered message on each keystroke, which is visibly laggy.
export const Markdown = memo(function Markdown({ text, variant = 'chat', linkCtx, className, hardBreaks, highlightMentions = false }: MarkdownProps): ReactNode {
  const components = useMemo(
    () => buildComponents(STYLES[variant], variant, linkCtx, highlightMentions),
    [variant, linkCtx, highlightMentions],
  )
  // data-md-root marks the subtree as rendered markdown: copying a selection
  // that touches it re-serializes it back to markdown source (lib/copyMarkdown).
  // The source itself is registered against the root so a selection covering the
  // whole thing can be copied verbatim instead of re-serialized.
  const rootRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    setMarkdownSource(el, text)
    return () => setMarkdownSource(el, null)
  }, [text])
  return (
    <div ref={rootRef} className={className ?? ''} data-md-root="">
      <ReactMarkdown
        remarkPlugins={(hardBreaks ?? variant === 'chat') ? BREAK_PLUGINS : REFLOW_PLUGINS}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
