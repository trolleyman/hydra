import { type ReactNode } from 'react'
import { highlightHtml } from './highlightCore'

// Simple inline-markdown support. We deliberately do NOT pull in a full
// markdown library: the goal is to highlight `code` spans, *italic* / **bold** /
// ***bold-italic*** emphasis, ~strikethrough~ and #headings in short bits of
// user-facing text (prompts, agent activity lines). Everything else is left
// as-is, and all whitespace/newlines are preserved so callers can render inside
// a `whitespace-pre-wrap` container. Headings are the one block construct we
// handle, and only as "make the line bold" - no CommonMark heading semantics.

type Seg =
  | { kind: 'text'; value: string }
  // A backslash-escaped metacharacter (`\_` etc.): renders as the literal
  // character. Its source is '\' + value.
  | { kind: 'escape'; value: string }
  // An inline `code` span. `marker` is the backtick RUN that delimits it (one or
  // more - see codeSpanAt), `value` the content as it should read, and `pad` the
  // single space CommonMark strips from each end when the content is padded
  // (`` ` `` -> a literal backtick). marker + pad + value + pad + marker is the
  // exact source, which is what the textarea overlay needs.
  | { kind: 'code'; marker: string; value: string; pad: string }
  // A fenced ```code block```. `raw` is the exact matched source (fences and all)
  // so the textarea overlay stays glyph-aligned; `value` is just the inner code
  // and `lang` the optional info string for read-only rendering.
  | { kind: 'codeblock'; raw: string; lang: string; value: string }
  | { kind: 'bold'; marker: string; value: string }
  | { kind: 'italic'; marker: string; value: string }
  | { kind: 'bolditalic'; marker: string; value: string }
  | { kind: 'strike'; marker: string; value: string }
  // A heading line: `marker` is the `#..###### ` prefix (hashes + spaces), `value`
  // the rest of the line. Unlike the paired-marker spans above the marker sits
  // only at the front, so marker + value === the source line (the trailing
  // newline stays a separate text seg). Rendered bold; markers dropped (read-only)
  // or dimmed (overlay).
  | { kind: 'heading'; marker: string; value: string }

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

type InlineKind = 'bold' | 'italic' | 'bolditalic' | 'strike'

// codeSpanAt matches a code span at the START of `rest`, or null. Code spans get
// their own matcher rather than a regex in PATTERNS because their delimiter is
// variable-length, which a regex can't express: a run of N backticks is closed
// by the next run of EXACTLY N (CommonMark 6.1), so a longer or shorter run in
// between is just content. That is what lets a span hold backticks at all -
// `` ` `` is a literal backtick, and "` ``` `" is the triple fence. A single
// `^`([^`\n]+)`$`-style pattern instead read the first two backticks of
// "` ``` `" as an empty span, which is how a sentence about ``` came out as two
// blank chips.
//
// If the content both starts and ends with a space and isn't all spaces, one
// space is stripped from each end (CommonMark's padding rule - it is what makes
// a span that starts or ends with a backtick writable). The stripped pair is
// returned as `pad` so the source can be reassembled exactly.
//
// Unlike CommonMark the span may not cross a newline: this parser highlights as
// you type, where an unclosed marker must not swallow the rest of the text.
function codeSpanAt(rest: string): Extract<Seg, { kind: 'code' }> | null {
  const open = /^`+/.exec(rest)
  if (!open) return null
  const marker = open[0]
  const scan = /`+|\n/g
  scan.lastIndex = marker.length
  for (let m = scan.exec(rest); m; m = scan.exec(rest)) {
    if (m[0] === '\n') return null
    if (m[0].length !== marker.length) continue
    const inner = rest.slice(marker.length, m.index)
    const pad = inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '' ? ' ' : ''
    return { kind: 'code', marker, pad, value: pad ? inner.slice(1, -1) : inner }
  }
  return null
}

// Inline patterns, tried in order at each position. The longer markers must
// precede the shorter ones that prefix them so the longer marker wins: `***`/
// `___` before `**`/`__` before `*`/`_`, and `~~` before `~`. Each pattern is
// anchored to the current scan position and forbids newlines inside the span so
// an unclosed marker doesn't swallow the rest of the text.
const PATTERNS: { kind: InlineKind; re: RegExp }[] = [
  { kind: 'bolditalic', re: /^\*\*\*([^\n]+?)\*\*\*/ },
  { kind: 'bolditalic', re: /^___([^\n]+?)___/ },
  { kind: 'bold', re: /^\*\*([^\n]+?)\*\*/ },
  { kind: 'bold', re: /^__([^\n]+?)__/ },
  { kind: 'italic', re: /^\*([^\n]+?)\*/ },
  { kind: 'italic', re: /^_([^\n]+?)_/ },
  { kind: 'strike', re: /^~~([^\n]+?)~~/ },
  { kind: 'strike', re: /^~([^\n]+?)~/ },
]

// Heading: 1-6 `#` at the start of a line, at least one space/tab, then the rest
// of the line (which may be empty). `marker` is the hashes+spaces, `value` the
// remainder - no trailing newline is consumed. 7+ hashes fail the space
// requirement and aren't a heading, and `#foo` (no space) stays plain so hashtags
// / issue refs are untouched.
const HEADING_RE = /^(#{1,6}[ \t]+)([^\n]*)/

// The metacharacters a backslash can escape - exactly the ones this parser
// styles (CommonMark escapes all ASCII punctuation; we stay minimal so e.g. a
// Windows path `C:\Users` is untouched). Backslash itself is escapable so a
// literal backslash before a metachar can be written unambiguously.
const ESCAPABLE = new Set(['`', '*', '_', '~', '\\'])

// parseInline splits text into styled/plain segments. The concatenation of all
// segments' source (marker + value + marker, marker + pad + value + pad + marker
// for a code span, or '\' + value for an escape) is exactly the input, so
// callers that need character-for-character fidelity (e.g. a textarea overlay)
// can rely on it.
function parseInline(text: string): Seg[] {
  const segs: Seg[] = []
  let buf = ''
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    // Backslash escape: consumed before the inline patterns so an escaped
    // marker can't open a code/emphasis span. This is how agent activity lines
    // show literal file names like _LAYOUT_.tsx verbatim - the backend escapes
    // them (internal/heads/activity.go escapeMarkdown).
    if (text[i] === '\\' && ESCAPABLE.has(text[i + 1])) {
      if (buf) {
        segs.push({ kind: 'text', value: buf })
        buf = ''
      }
      segs.push({ kind: 'escape', value: text[i + 1] })
      i += 2
      continue
    }
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
      // A heading is line-scoped: capture the `#..###### ` prefix and the rest of
      // the line as one bold seg, so we don't parse inline markers inside it (the
      // "simple bold" the whole line asks for). The trailing newline is left for
      // the next iteration.
      const hm = HEADING_RE.exec(rest)
      if (hm) {
        if (buf) {
          segs.push({ kind: 'text', value: buf })
          buf = ''
        }
        segs.push({ kind: 'heading', marker: hm[1], value: hm[2] })
        i += hm[0].length
        continue
      }
    }
    // Code spans first: their contents are literal, so a marker inside one is
    // never emphasis (CommonMark gives them the highest inline precedence).
    const code = text[i] === '`' ? codeSpanAt(rest) : null
    if (code) {
      if (buf) {
        segs.push({ kind: 'text', value: buf })
        buf = ''
      }
      segs.push(code)
      i += code.marker.length * 2 + code.pad.length * 2 + code.value.length
      continue
    }
    let hit: { kind: InlineKind; m: RegExpExecArray } | null = null
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

// Inline-code styling for read-only renders: a bordered monospace chip with a
// warm terracotta tint (Claude-app style) in both themes - the dark background
// is a shade darker than the surrounding surface so the chip reads clearly.
// Deliberately uses only HORIZONTAL padding and a slightly smaller (never
// larger) em size: vertical padding or a bigger font would change the line
// height, and we want a line with a code span to stay exactly as tall as a
// plain one (an inline border doesn't grow the line box either).
// `box-decoration-clone` makes the rounded chip + background repeat cleanly on
// each fragment when a long code span wraps across lines rather than leaving a
// broken/clipped box.
const CODE_CLASS =
  'rounded box-decoration-clone border border-gray-300/60 dark:border-gray-500/30 bg-gray-100/70 dark:bg-black/25 px-1 font-mono text-[0.9em] text-[#a8462d] dark:text-[#eab6a0]'

// Block-code styling for read-only renders: a bordered panel like the inline
// chip but block-level, with a near-black warm background in dark mode and a
// quiet light one in light mode. Body text stays the default colour (blocks are
// syntax-coloured, not tinted); when the info string names a language
// Prism recognises, its tokens are coloured by the shared `.token` theme.
// The `.token` classes carry their own colours, so we deliberately do NOT add
// any root class - a highlighter theme's root class would also pull in
// github.css's white background.
const CODEBLOCK_CLASS =
  'block my-1 rounded-md border border-gray-200 dark:border-gray-600/40 bg-gray-50 dark:bg-[#1d1c1a] px-2.5 py-1.5 font-mono text-[0.85em] text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words'

// highlightCode returns highlight.js token HTML for `code` when `lang` names a
// recognised language, or null to fall back to plain (uncoloured) monospace text.
// Exported so the react-markdown renderer (Markdown.tsx) shares the one
// highlighter rather than pulling in a second (rehype-highlight/lowlight).
//
// The work itself lives in lib/highlightCore (which also serves the diff viewer
// and the highlight worker), so a ```bash block gets the same embedded-language
// treatment - heredoc bodies, `python3 -c "..."` - as everywhere else.
export function highlightCode(code: string, lang: string): string | null {
  if (!lang) return null
  return highlightHtml(code, lang)
}

export interface RenderMarkdownOptions {
  // When true, text that begins with a `$` is rendered entirely as a code span
  // (the `$` included), overriding all other markdown parsing. Used for agent
  // activity lines that report a shell command being run.
  dollarCommand?: boolean
  // When true, render for a single-line preview (e.g. the sidebar's fixed-height
  // activity row): the parsed segments are flattened onto one line (see
  // flattenToLine). This keeps the output one line and stops a fenced code block
  // in a `last_message` from rendering as a multi-line `display:block` chip that
  // would overflow the row and show clipped, half-cut lines.
  singleLine?: boolean
}

// collapseWs turns every whitespace run - newlines included - into a single space.
const collapseWs = (s: string) => s.replace(/\s+/g, ' ')

// flattenToLine squashes a parsed segment list onto one line for the fixed-height
// preview rows.
//
// The flattening happens AFTER parsing, deliberately. Collapsing the newlines up
// front (what this used to do) destroys the line boundaries that the line-scoped
// constructs need to terminate: `# Some heading\nAnd some text` became
// `# Some heading And some text`, and since a heading runs to the end of its
// line, the body text got swallowed into the heading and rendered bold too.
//
// A fenced block can't survive as a block here (it renders `display:block` and
// would blow the row height), so it degrades to an ordinary inline code chip.
function flattenToLine(segs: Seg[]): Seg[] {
  const out: Seg[] = []
  // Whitespace is collapsed ACROSS segment boundaries too: a heading's trailing
  // spaces plus the blank line after it are one gap, not three, and the gap is
  // emitted as plain text so it never ends up inside the bold/code span it
  // followed. A gap before the first (or after the last) segment is dropped.
  let gap = false
  const push = (s: Seg) => {
    if (gap && out.length > 0) out.push({ kind: 'text', value: ' ' })
    gap = false
    out.push(s)
  }
  for (const s of segs) {
    const value = collapseWs(s.value)
    gap = gap || value.startsWith(' ')
    const core = value.trim()
    // An empty text seg is pure gap; an empty code chip still renders (it is a
    // deliberate span in the source).
    if (core !== '' || s.kind === 'code' || s.kind === 'codeblock') {
      push(s.kind === 'codeblock' ? { kind: 'code', marker: '`', pad: '', value: core } : { ...s, value: core })
    }
    gap = gap || value.endsWith(' ')
  }
  return out
}

// renderMarkdown turns inline markdown into styled React nodes for read-only
// display, dropping the markers themselves (so `*hi*` shows as italic "hi").
export function renderMarkdown(text: string, opts: RenderMarkdownOptions = {}): ReactNode {
  const singleLine = opts.singleLine === true
  if (singleLine) text = text.trim()
  if (opts.dollarCommand && text.startsWith('$')) {
    return <code className={CODE_CLASS}>{singleLine ? collapseWs(text) : text}</code>
  }
  // trimAroundBlocks only matters for a real block-level codeblock, which the
  // single-line flattening turns into an inline chip anyway.
  const segs = singleLine ? flattenToLine(parseInline(text)) : trimAroundBlocks(parseInline(text))
  return segs.map((s, i) => {
    switch (s.kind) {
      case 'escape':
        return <span key={i}>{s.value}</span>
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
      case 'bolditalic':
        return (
          <strong key={i} className="font-semibold">
            <em className="italic">{s.value}</em>
          </strong>
        )
      case 'strike':
        return (
          <del key={i} className="line-through opacity-80">
            {s.value}
          </del>
        )
      case 'heading':
        // "Simple bold of headings" - the marker (`## `) is dropped, the line
        // text rendered bold. No larger size: this renderer is used inline
        // (activity line, one-line preview) where a bigger heading would jar.
        return (
          <strong key={i} className="font-semibold">
            {s.value}
          </strong>
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
    if (s.kind === 'escape') {
      // Both characters stay (char-for-char with the textarea); the backslash
      // is dimmed like the emphasis markers to read as an escape.
      return (
        <span key={i}>
          <span className="opacity-40">{'\\'}</span>
          {s.value}
        </span>
      )
    }
    if (s.kind === 'code') {
      // Mirror the read-only inline chip's look so typed code reads like its
      // rendered result: terracotta text plus a hairline ring around the tinted
      // background. Everything here is metric-neutral - we must NOT switch to a
      // monospace font (the textarea uses the inherited proportional font, so a
      // font-mono run in the backdrop would advance differently and drift the
      // caret), and the ring is a box-shadow / the padding is inset, neither of
      // which changes glyph advances the way a real border/padding would.
      // `box-decoration-clone` keeps the chip tidy when a code span wraps.
      return (
        <span
          key={i}
          className="rounded box-decoration-clone bg-gray-100/80 dark:bg-black/30 text-[#a8462d] dark:text-[#eab6a0] shadow-[inset_0_0_0_1px_rgba(120,120,120,0.35)]"
        >
          {s.marker + s.pad}
          {s.value}
          {s.pad + s.marker}
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
          className="md-src-code inline-block w-full align-top rounded bg-gray-50/90 dark:bg-black/40 shadow-[inset_0_0_0_1px_rgba(120,120,120,0.35)] break-words"
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
    if (s.kind === 'heading') {
      // A heading only has a leading marker (`## `), no trailing one. The line
      // text is bold-stroked (metric-neutral, like inline bold) and the hashes
      // dimmed like other markers. marker + value === the source line, so it
      // stays glyph-aligned with the textarea.
      return (
        <span key={i} className="md-src-bold">
          <span className="opacity-40">{s.marker}</span>
          {s.value}
        </span>
      )
    }
    if (s.kind === 'strike') {
      // line-through is a decoration, not a metric change, so it's safe to show
      // the real strikethrough in the overlay (unlike italic).
      return (
        <span key={i}>
          <span className="opacity-40">{s.marker}</span>
          <span className="line-through">{s.value}</span>
          <span className="opacity-40">{s.marker}</span>
        </span>
      )
    }
    // Emphasis in the overlay must not change glyph ADVANCE widths, or the
    // visible backdrop text drifts from the invisible textarea text - the caret
    // floats mid-word and spellcheck squiggles land offset under the wrong
    // glyphs ("double text"). Both fakes below are metric-neutral: bold (and the
    // bold half of bold-italic) is a text stroke (.md-src-bold), and italic is
    // the pinned Roboto Flex's `slnt` oblique (.md-src-italic) - a shear of the
    // upright outlines that keeps advances, not a narrower cursive italic. The
    // read-only renderer above uses real <strong>/<em> - it has no textarea to
    // align with.
    const emphasis = [
      s.kind === 'bold' || s.kind === 'bolditalic' ? 'md-src-bold' : '',
      s.kind === 'italic' || s.kind === 'bolditalic' ? 'md-src-italic' : '',
    ].filter(Boolean).join(' ')
    return (
      <span key={i} className={emphasis}>
        <span className="opacity-40">{s.marker}</span>
        {s.value}
        <span className="opacity-40">{s.marker}</span>
      </span>
    )
  })
}

