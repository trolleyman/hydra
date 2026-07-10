import { memo, type ReactNode, useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { useNavigate } from '@tanstack/react-router'
import { highlightCode } from './markdown'

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
  const resolved = resolveRepoPath(dirOf(ctx.filePath), path)
  const splat = resolved ? `${ctx.refStr}/${resolved}` : ctx.refStr
  const url = `/project/${encodePath(ctx.projectId)}/repository/${encodePath(splat)}${hash}`
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate({
      to: '/project/$projectId/repository/$',
      params: { projectId: ctx.projectId, _splat: splat },
      hash: hash ? hash.slice(1) : undefined,
    })
  }
  return <a className={LINK_CLASS} href={url} onClick={onClick}>{children}</a>
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
const REMARK_PLUGINS: Record<Variant, RemarkPlugins> = {
  chat: [remarkGfm, remarkBreaks],
  doc: [remarkGfm],
}

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
      if (html != null) {
        // No `.hljs` root class: the token `.hljs-*` spans carry their own
        // colours, while `.hljs` would also pull in github.css's white bg.
        return <code className={s.codeBlock} dangerouslySetInnerHTML={{ __html: html }} />
      }
      return <code className={s.codeBlock}>{text}</code>
    },
  }
}

// rehypeWordFade wraps every visible word in a `<span class="sfw">` so the CSS
// `.chat-stream-fade .sfw` rule can fade each one in as it streams. It runs only
// for the live streaming node (streamFade). Words append at the end of the text
// as tokens arrive, so react-markdown reconciles the earlier spans in place (same
// index key -> no remount -> their fade-in doesn't restart) and only the freshly
// mounted trailing spans animate. Code/pre are skipped (splitting a highlighted
// block would fight the syntax spans and re-fade on every keystroke of code).
//
// Only NON-whitespace text is wrapped: the real content lives in phrasing
// contexts (p, li, td, headings...) that legally hold a <span>, while the text
// nodes sitting DIRECTLY inside structural containers (table/thead/tbody/tr, ul/
// ol) are just the insignificant whitespace between rows/items - wrapping those
// would put a <span> where only <tr>/<td>/<li> may go and break DOM nesting.
type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }
function rehypeWordFade() {
  const splitText = (value: string): HastNode[] =>
    // Keep each word glued to its trailing whitespace so spacing is preserved.
    (value.match(/\s*\S+\s*|\s+/g) ?? [value]).map((word) => ({
      type: 'element',
      tagName: 'span',
      properties: { className: ['sfw'] },
      children: [{ type: 'text', value: word }],
    }))
  const walk = (node: HastNode, inCode: boolean) => {
    if (!node.children) return
    const out: HastNode[] = []
    for (const child of node.children) {
      if (child.type === 'text' && !inCode && child.value?.trim()) {
        out.push(...splitText(child.value))
      } else {
        if (child.type === 'element') {
          walk(child, inCode || child.tagName === 'code' || child.tagName === 'pre')
        }
        out.push(child)
      }
    }
    node.children = out
  }
  return (tree: HastNode) => walk(tree, false)
}

type RehypePlugins = React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']
const WORD_FADE_PLUGINS: RehypePlugins = [rehypeWordFade]

export interface MarkdownProps {
  // The markdown source to render.
  text: string
  // Styling density. 'chat' (default) is compact; 'doc' is document-like (README).
  variant?: Variant
  // When set, relative links resolve against a repo file and navigate in-app.
  linkCtx?: RepoLinkContext
  // Wrapper class (e.g. text colour / max-width) applied to the outer container.
  className?: string
  // Fade each word in as it appears - for the in-flight streamed chat reply only.
  streamFade?: boolean
}

// Markdown renders read-only markdown for a given surface. Do NOT wrap it in a
// whitespace-pre-wrap container - block elements manage their own spacing and
// remark-breaks already preserves single newlines as <br>.
//
// memo'd: parsing markdown is not cheap, and a chat transcript can hold hundreds
// of these. Without memo, typing in the chat composer (a sibling state change)
// re-parses every rendered message on each keystroke, which is visibly laggy.
export const Markdown = memo(function Markdown({ text, variant = 'chat', linkCtx, className, streamFade }: MarkdownProps): ReactNode {
  const components = useMemo(
    () => buildComponents(STYLES[variant], linkCtx),
    [variant, linkCtx],
  )
  return (
    <div className={`${streamFade ? 'chat-stream-fade ' : ''}${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS[variant]}
        rehypePlugins={streamFade ? WORD_FADE_PLUGINS : undefined}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
