import { memo, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { useNavigate } from '@tanstack/react-router'
import { ImageOff } from 'lucide-react'
import { highlightCode } from './markdown'
import { setMarkdownSource } from './copyMarkdown'
import { buildRepoSplat } from './repoSplat'
import { UPLOAD_PATH_RE } from './uploadAttachments'
import { useLightbox } from '../stores/lightboxStore'
import { markdownGalleryAt } from './markdownGallery'
import { densityFromPath, logicalSize, useNaturalSize } from './imageDensity'
import { rememberMediaSize } from './mediaSize'
import { IMAGE_REFLOW_MS, markSelfReflow } from './selfReflow'
import { agentFileUrl, uploadBlobUrl } from '../api/uploads'

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

const LINK_CLASS = 'text-blue-600 dark:text-blue-400 hover:underline'

// RepoLink renders a README link. External links and in-page anchors are plain
// anchors (external open in a new tab); a relative repo link is resolved against
// the current file and, on a plain left-click, navigates the repository view in
// app - while its real href lets middle/ctrl-click open it in a new tab.
function RepoLink({ href, ctx, children }: { href?: string; ctx: RepoLinkContext; children?: ReactNode }) {
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
  return <a className={LINK_CLASS} href={url} onClick={onClick}>{children}</a>
}

// --- Images -------------------------------------------------------------------

// isDataHref matches the URL forms an <img> can load directly without going
// through the backend (remote, inline, or an object URL).
function isDataHref(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src) || src.startsWith('//')
}

// resolveImageSrc turns a markdown image target into something the browser can
// actually fetch. An agent writes a screenshot to its worktree or to /tmp and
// then references that path - which means nothing to the browser - so a local
// path is routed through the agent-files endpoint, which serves it from the
// head's own filesystem. Falls back to the uploads blob endpoint for a path in
// the project's uploads dir (the user's own pasted images, which surfaces
// without a head still show). Returns null when nothing can serve it.
function resolveImageSrc(src: string, ctx?: RepoLinkContext): string | null {
  if (!src) return null
  if (isDataHref(src)) return src
  if (ctx?.agentId) return agentFileUrl(ctx.projectId, ctx.agentId, src)
  const upload = UPLOAD_PATH_RE.exec(src)
  UPLOAD_PATH_RE.lastIndex = 0
  if (upload && ctx) return uploadBlobUrl(ctx.projectId, upload[0].split('/').pop() ?? '')
  return null
}

// MarkdownImage renders a markdown image. Anything that resolves is shown at its
// logical size (natural px / the @2x density in its name, capped to the column)
// and opens in the app-wide lightbox on click - as a gallery of the images in
// its own markdown block, so ←/→ walk the pictures of that one message (see
// lib/markdownGallery). Anything that doesn't resolve - an unservable path, or a
// scratch file that has since been reclaimed - degrades to a muted chip naming
// it, rather than the browser's broken-image icon.
function MarkdownImage({ src, alt, ctx }: { src?: string; alt?: string; ctx?: RepoLinkContext }) {
  const openLightbox = useLightbox()
  // The source that failed to load, rather than a bare flag: a streamed message
  // rewrites the same node's src as more text arrives, and keying the failure to
  // the src means a new one is retried instead of inheriting the old verdict.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const url = src ? resolveImageSrc(src, ctx) : null
  const label = alt || (src ? src.split('/').pop() || src : 'image')
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
  if (!url || failedSrc === src) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-gray-300/60 dark:border-gray-500/30 bg-gray-100/70 dark:bg-black/25 px-1.5 py-0.5 align-middle text-[0.85em] text-gray-600 dark:text-gray-400"
        title={src}
      >
        <ImageOff className="w-3.5 h-3.5 shrink-0 opacity-70" aria-hidden="true" />
        {label}
      </span>
    )
  }
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
  chat: {
    h1: 'text-base font-bold mt-3 mb-1 first:mt-0',
    h2: 'text-[0.95rem] font-bold mt-3 mb-1 first:mt-0',
    h3: 'text-sm font-semibold mt-2 mb-0.5 first:mt-0',
    h4: 'text-sm font-semibold mt-2 mb-0.5 first:mt-0',
    h5: 'text-sm font-semibold mt-2 mb-0.5 first:mt-0',
    h6: 'text-sm font-semibold mt-2 mb-0.5 first:mt-0',
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
    table: 'border-collapse text-sm',
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
function buildComponents(s: Style, linkCtx?: RepoLinkContext): Components {
  return {
    h1: ({ children }) => <h1 className={s.h1}>{children}</h1>,
    h2: ({ children }) => <h2 className={s.h2}>{children}</h2>,
    h3: ({ children }) => <h3 className={s.h3}>{children}</h3>,
    h4: ({ children }) => <h4 className={s.h4}>{children}</h4>,
    h5: ({ children }) => <h5 className={s.h5}>{children}</h5>,
    h6: ({ children }) => <h6 className={s.h6}>{children}</h6>,
    p: ({ children }) => <p className={s.p}>{children}</p>,
    ul: ({ children, className }) => (
      <ul className={`${s.ul}${className?.includes('contains-task-list') ? ' list-none pl-0' : ''}`}>{children}</ul>
    ),
    ol: ({ children, start }) => <ol className={s.ol} start={start}>{children}</ol>,
    li: ({ children }) => <li className={s.li}>{children}</li>,
    blockquote: ({ children }) => <blockquote className={s.blockquote}>{children}</blockquote>,
    hr: () => <hr className={s.hr} />,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="line-through opacity-80">{children}</del>,
    a: ({ href, children }) =>
      linkCtx ? (
        <RepoLink href={href} ctx={linkCtx}>{children}</RepoLink>
      ) : (
        <a className={LINK_CLASS} href={href} target="_blank" rel="noreferrer">{children}</a>
      ),
    img: ({ src, alt }) => <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} ctx={linkCtx} />,
    table: ({ children }) => (
      <div className={s.tableWrap}>
        <table className={s.table}>{children}</table>
      </div>
    ),
    tbody: ({ children }) => <tbody className={s.tbody}>{children}</tbody>,
    th: ({ children, style }) => <th className={s.th} style={alignStyle(style?.textAlign)}>{children}</th>,
    td: ({ children, style }) => <td className={s.td} style={alignStyle(style?.textAlign)}>{children}</td>,
    // react-markdown wraps fenced blocks in <pre>; we style the inner <code> as a
    // display:block element instead, so strip <pre>'s own box.
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      const text = String(children ?? '').replace(/\n$/, '')
      const lang = /language-([\w-]+)/.exec(className || '')?.[1] ?? ''
      // Inline code: no language info-string and no newline. A fenced block gets a
      // language- class (when annotated) or spans multiple lines.
      if (!lang && !text.includes('\n')) {
        return <code className={s.codeInline}>{children}</code>
      }
      const html = highlightCode(text, lang)
      // data-md-code-block / data-md-lang let copy-as-markdown (lib/copyMarkdown)
      // put the fence and its info string back when this block is copied.
      if (html != null) {
        // No highlighter root class: the `.token` spans carry their own
        // colours, while a root class would also pull in a theme's white bg.
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
    },
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
}

// Markdown renders read-only markdown for a given surface. Do NOT wrap it in a
// whitespace-pre-wrap container - block elements manage their own spacing and
// remark-breaks already preserves single newlines as <br>.
//
// memo'd: parsing markdown is not cheap, and a chat transcript can hold hundreds
// of these. Without memo, typing in the chat composer (a sibling state change)
// re-parses every rendered message on each keystroke, which is visibly laggy.
export const Markdown = memo(function Markdown({ text, variant = 'chat', linkCtx, className, hardBreaks }: MarkdownProps): ReactNode {
  const components = useMemo(
    () => buildComponents(STYLES[variant], linkCtx),
    [variant, linkCtx],
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
