import { type ReactNode } from 'react'
import hljs from './hljs'

// Simple inline-markdown support. We deliberately do NOT pull in a full
// markdown library (or handle block constructs like #headings): the only goal
// is to highlight `code` spans and *italic* / **bold** emphasis in short bits
// of user-facing text (prompts, agent activity lines). Everything else is left
// as-is, and all whitespace/newlines are preserved so callers can render inside
// a `whitespace-pre-wrap` container.

type Seg =
  | { kind: 'text'; value: string }
  | { kind: 'code'; marker: string; value: string }
  // A fenced ```code block```. `raw` is the exact matched source (fences and all)
  // so the textarea overlay stays glyph-aligned; `value` is just the inner code
  // and `lang` the optional info string for read-only rendering.
  | { kind: 'codeblock'; raw: string; lang: string; value: string }
  | { kind: 'bold'; marker: string; value: string }
  | { kind: 'italic'; marker: string; value: string }

// Fenced code block: an opening ``` (with an optional info string on the rest of
// the line), then any number of lines, then a closing ``` at the start of a
// line. Matched before the inline patterns and allowed to span newlines.
// Non-greedy so it stops at the first valid closing fence. The body group is
// optional so an empty block (```\n```, nothing between the fences) still matches
// and gets highlighted.
//
// The closing ``` must stand alone on its line - only trailing spaces/tabs are
// allowed after it, then a newline or end of input (CommonMark §4.5). So a fence
// like ```#### does NOT close the block: trailing non-whitespace makes that line
// part of the body, and with no later closing fence the whole thing is left
// unmatched and falls through to inline/plain handling. (Without this, ```####
// both closed the block AND, because the codeblock renders as a full-width
// inline-block, pushed the #### onto its own visual line - drifting the highlight
// overlay away from the textarea caret.)
const FENCE_RE = /^```([^\n]*)\n(?:([\s\S]*?)\n)?```[ \t]*(?=\n|$)/

// Inline patterns, tried in order at each position. `**`/`__` must precede the
// single-char `*`/`_` so the longer marker wins. Each pattern is anchored to
// the current scan position and forbids newlines inside the span so an unclosed
// marker doesn't swallow the rest of the text.
const PATTERNS: { kind: 'code' | 'bold' | 'italic'; re: RegExp }[] = [
  { kind: 'code', re: /^`([^`\n]+)`/ },
  { kind: 'bold', re: /^\*\*([^\n]+?)\*\*/ },
  { kind: 'bold', re: /^__([^\n]+?)__/ },
  { kind: 'italic', re: /^\*([^\n]+?)\*/ },
  { kind: 'italic', re: /^_([^\n]+?)_/ },
]

// parseInline splits text into styled/plain segments. The concatenation of all
// segments' source (marker + value + marker) is exactly the input, so callers
// that need character-for-character fidelity (e.g. a textarea overlay) can rely
// on it.
function parseInline(text: string): Seg[] {
  const segs: Seg[] = []
  let buf = ''
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    // Fenced code blocks only open at the start of a line (start of input or
    // just after a newline), matching how they're written in practice.
    const atLineStart = i === 0 || text[i - 1] === '\n'
    if (atLineStart) {
      const fm = FENCE_RE.exec(rest)
      if (fm) {
        if (buf) {
          segs.push({ kind: 'text', value: buf })
          buf = ''
        }
        segs.push({ kind: 'codeblock', raw: fm[0], lang: fm[1].trim(), value: fm[2] ?? '' })
        i += fm[0].length
        continue
      }
    }
    let hit: { kind: 'code' | 'bold' | 'italic'; m: RegExpExecArray } | null = null
    for (const p of PATTERNS) {
      const m = p.re.exec(rest)
      if (m) {
        hit = { kind: p.kind, m }
        break
      }
    }
    if (hit) {
      if (buf) {
        segs.push({ kind: 'text', value: buf })
        buf = ''
      }
      const full = hit.m[0]
      const inner = hit.m[1]
      const marker = full.slice(0, (full.length - inner.length) / 2)
      segs.push({ kind: hit.kind, marker, value: inner })
      i += full.length
    } else {
      buf += text[i]
      i += 1
    }
  }
  if (buf) segs.push({ kind: 'text', value: buf })
  return segs
}

// trimAroundBlocks drops the single newline directly before/after a fenced
// codeblock segment. A codeblock renders as its own display:block element, so
// in a `whitespace-pre-wrap` container the literal newline that separated the
// fence from its surrounding prose would otherwise add a redundant blank line.
// Both the read-only render AND the textarea overlay render codeblocks as
// blocks, so both trim here: the block's own line breaks reproduce exactly the
// lines those newlines would have, keeping the overlay glyph-aligned.
function trimAroundBlocks(segs: Seg[]): Seg[] {
  const out = segs.map((s) => ({ ...s }))
  out.forEach((s, i) => {
    if (s.kind !== 'codeblock') return
    const prev = out[i - 1]
    if (prev && prev.kind === 'text' && prev.value.endsWith('\n')) {
      prev.value = prev.value.slice(0, -1)
    }
    const next = out[i + 1]
    if (next && next.kind === 'text' && next.value.startsWith('\n')) {
      next.value = next.value.slice(1)
    }
  })
  return out.filter((s) => !(s.kind === 'text' && s.value === ''))
}

// Inline-code styling for read-only renders. NOT tinted - it's just the default
// text colour in a rounded monospace chip. Deliberately uses only HORIZONTAL
// padding and a slightly smaller (never larger) em size: vertical padding or a
// bigger font would change the line height, and we want a line with a code span
// to stay exactly as tall as a plain one. `box-decoration-clone` makes the
// rounded chip + background repeat cleanly on each fragment when a long code
// span wraps across lines rather than leaving a broken/clipped box.
const CODE_CLASS =
  'rounded box-decoration-clone bg-gray-200/70 dark:bg-gray-700/60 px-1 font-mono text-[0.9em]'

// Block-code styling for read-only renders. Uses the SAME rounded background as
// inline code (just block-level with a touch of padding) so the two read as one
// family. Not tinted either; when the info string names a language highlight.js
// recognises, its tokens are coloured by the shared `.hljs-*` theme. The
// `.hljs-*` token classes carry their own colours, so we deliberately do NOT add
// the `.hljs` root class - that would also pull in github.css's white background.
const CODEBLOCK_CLASS =
  'block my-1 rounded bg-gray-200/70 dark:bg-gray-700/60 px-2 py-1 font-mono text-[0.85em] text-gray-800 dark:text-gray-100 whitespace-pre-wrap break-words'

// highlightCode returns highlight.js token HTML for `code` when `lang` names a
// recognised language, or null to fall back to plain (uncoloured) monospace text.
// Exported so the react-markdown renderer (Markdown.tsx) shares the one
// highlighter rather than pulling in a second (rehype-highlight/lowlight).
export function highlightCode(code: string, lang: string): string | null {
  if (!code || !lang || !hljs.getLanguage(lang)) return null
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  } catch {
    return null
  }
}

export interface RenderMarkdownOptions {
  // When true, text that begins with a `$` is rendered entirely as a code span
  // (the `$` included), overriding all other markdown parsing. Used for agent
  // activity lines that report a shell command being run.
  dollarCommand?: boolean
  // When true, render for a single-line preview (e.g. the sidebar's fixed-height
  // activity row): collapse every whitespace run - newlines included - to a
  // single space before parsing. This keeps the output one line and, since a
  // fenced code block needs real newlines to match, stops a code block in a
  // `last_message` from rendering as a multi-line `display:block` chip that would
  // overflow the row and show clipped, half-cut lines.
  singleLine?: boolean
}

// renderMarkdown turns inline markdown into styled React nodes for read-only
// display, dropping the markers themselves (so `*hi*` shows as italic "hi").
export function renderMarkdown(text: string, opts: RenderMarkdownOptions = {}): ReactNode {
  if (opts.singleLine) text = text.replace(/\s+/g, ' ').trim()
  if (opts.dollarCommand && text.startsWith('$')) {
    return <code className={CODE_CLASS}>{text}</code>
  }
  const segs = trimAroundBlocks(parseInline(text))
  return segs.map((s, i) => {
    switch (s.kind) {
      case 'code':
        return (
          <code key={i} className={CODE_CLASS}>
            {s.value}
          </code>
        )
      case 'codeblock': {
        const html = highlightCode(s.value, s.lang)
        if (html != null) {
          return <code key={i} className={CODEBLOCK_CLASS} dangerouslySetInnerHTML={{ __html: html }} />
        }
        return (
          <code key={i} className={CODEBLOCK_CLASS}>
            {/* A single space keeps an empty block one line tall (so the chip is
                still visible) instead of collapsing. */}
            {s.value === '' ? ' ' : s.value}
          </code>
        )
      }
      case 'bold':
        return (
          <strong key={i} className="font-semibold">
            {s.value}
          </strong>
        )
      case 'italic':
        return (
          <em key={i} className="italic">
            {s.value}
          </em>
        )
      default:
        return <span key={i}>{s.value}</span>
    }
  })
}

// --- Block-level rendering -----------------------------------------------------
//
// Block-structured markdown (chat messages, the AgentView prompt, README
// previews, config pre-prompt previews) is now rendered by the shared
// <Markdown> component in ./Markdown.tsx, which wraps react-markdown + remark-gfm
// (tables, task lists, strikethrough). The hand-rolled parseBlocks/
// renderMarkdownBlocks that used to live here have been retired.
//
// What stays here is the inline renderer (`renderMarkdown`, used for the
// single-line activity-line preview with its $-command special case) and the
// textarea-overlay renderer (`renderMarkdownSource`) - the overlay must preserve
// every source character glyph-for-glyph to stay aligned with the caret, which a
// rendering library fundamentally cannot do, so it keeps its own parser
// (`parseInline`).

// splitFence breaks a fenced block's exact source into its opening fence line
// (```lang), its body (the inner code, including the surrounding newlines) and
// its closing ``` fence. open + body + close === raw exactly, so the textarea
// overlay can style the three parts differently without losing a single glyph.
function splitFence(raw: string): { open: string; body: string; close: string } {
  const firstNl = raw.indexOf('\n')
  const open = firstNl === -1 ? raw : raw.slice(0, firstNl)
  const afterOpen = firstNl === -1 ? '' : raw.slice(firstNl)
  const lastFence = afterOpen.lastIndexOf('```')
  if (lastFence === -1) return { open, body: afterOpen, close: '' }
  return { open, body: afterOpen.slice(0, lastFence), close: afterOpen.slice(lastFence) }
}

// renderMarkdownSource renders text for a textarea overlay: it keeps every
// character (markers included) so it stays perfectly aligned with the textarea
// underneath, but tints code spans and dims emphasis markers so the structure
// reads as highlighted source rather than rendered output. The segment list is
// used verbatim (no newline trimming): parseInline guarantees the concatenated
// source of every segment equals `text` exactly, so in the `whitespace-pre-wrap`
// backdrop the literal newlines reproduce the textarea's line breaks one-for-one
// - and the fenced block is an ATOMIC inline-block (see the codeblock branch),
// which flows exactly where the surrounding newlines place it without
// manufacturing its own line breaks. That is what keeps the highlight glued to
// the caret regardless of how many blank lines hug the block.
export function renderMarkdownSource(text: string): ReactNode {
  const segs = parseInline(text)
  return segs.map((s, i) => {
    if (s.kind === 'text') return <span key={i}>{s.value}</span>
    if (s.kind === 'code') {
      // Background chip only, NOT tinted - same as the read-only inline style, so
      // it reads as the surrounding text wrapped in a chip. We must NOT switch to
      // a monospace font here: the textarea underneath uses the inherited
      // (proportional) font, so a font-mono run in the backdrop would be a
      // different width and the visible caret would drift from the typed text.
      // `box-decoration-clone` keeps the background tidy when a code span wraps.
      return (
        <span key={i} className="rounded box-decoration-clone bg-gray-200/70 dark:bg-gray-700/60">
          {s.marker}
          {s.value}
          {s.marker}
        </span>
      )
    }
    if (s.kind === 'codeblock') {
      // Rendered as ONE full-width rounded background spanning the whole block
      // (not a chip hugging each line). The trick that keeps it glyph-aligned with
      // the textarea is `inline-block`: unlike `display:block`, an atomic
      // inline-block does NOT manufacture its own line breaks - it simply flows
      // wherever the surrounding source newlines put it, so the block's source
      // (`open` + `body` + `close` === raw) stays char-for-char with the textarea
      // and no amount of blank lines hugging the fence can drift it. `w-full`
      // gives it the full-width background; `align-top` pins its first internal
      // line to the top of its (tall) line box so the rows map one-for-one onto
      // the textarea's. It carries NO padding/margin (which would shift glyphs and
      // drift the caret) and stays in the inherited proportional font (a font swap
      // would change glyph widths). Syntax COLOURS come from the same highlight.js
      // path as the read-only block - colour alone doesn't affect layout, and
      // `.md-src-code` strips the theme's bold/italic, which WOULD change glyph
      // advances. The highlighted HTML's text is exactly the inner code, so we
      // re-add the two fence newlines around it to stay char-for-char (`open` +
      // "\n" + value + "\n" + `close` === raw). Fence lines are dimmed like
      // emphasis markers.
      const { open, body, close } = splitFence(s.raw)
      const html = highlightCode(s.value, s.lang)
      return (
        <span
          key={i}
          className="md-src-code inline-block w-full align-top rounded bg-gray-200/80 dark:bg-gray-700/70 break-words"
        >
          <span className="opacity-50">{open}</span>
          {html != null ? (
            <>
              {'\n'}
              <span dangerouslySetInnerHTML={{ __html: html }} />
              {'\n'}
            </>
          ) : (
            body
          )}
          <span className="opacity-50">{close}</span>
        </span>
      )
    }
    const emphasis = s.kind === 'bold' ? 'font-semibold' : 'italic'
    return (
      <span key={i} className={emphasis}>
        <span className="opacity-40">{s.marker}</span>
        {s.value}
        <span className="opacity-40">{s.marker}</span>
      </span>
    )
  })
}

