// Copy-as-markdown: turn a DOM selection back into markdown source.
//
// Chat messages are rendered markdown (see ./MarkdownRenderer), so a plain
// browser copy flattens them: **bold** loses its asterisks, a fenced code block
// loses its fence and language, a bullet list loses its dashes, and a GFM table
// comes out as a run of words. Selecting a region of the transcript and pasting
// it somewhere that speaks markdown (an issue, a doc, another agent's prompt)
// should give back what the agent actually wrote.
//
// Why re-serialize the DOM instead of slicing the original markdown source: a
// selection is a DOM range, and mapping an arbitrary range back to source
// offsets only works at block granularity (half a paragraph would have to copy
// the whole paragraph). Walking the selected DOM handles partial selections,
// selections spanning several messages, and selections that mix rendered
// markdown with the chat's non-markdown chrome (tool cards, diffs) - which the
// serializer passes through as plain text, as the browser would.
//
// Elements are recognised by the data attributes MarkdownRenderer sets
// (data-md-root, data-md-code, data-md-lang) plus standard tag names, so this
// stays independent of the Tailwind classes those elements happen to carry.

// Tags whose content is a block: they get separated by a line break even
// outside rendered markdown (chat cards, labels, rows).
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
  'TR', 'UL',
])

// Never contribute text: decorative icons, and anything explicitly hidden.
// data-copy-skip is the opt-out for chrome that would otherwise read as content.
//
// BUTTON (and the other form controls) are here because a drag cannot select
// their label in the first place - browsers make control text unselectable, so
// a plain copy of a chat drag never contains the tool-card headers, the plan
// card's "Raw" toggle, or a card's expand affordance. Taking over the copy
// event must not start pulling that furniture in.
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE',
  'BUTTON', 'SELECT', 'OPTION', 'TEXTAREA', 'VIDEO', 'AUDIO', 'CANVAS',
])

// SOURCES maps a rendered [data-md-root] element to the markdown it was
// rendered from. When a selection covers ALL of a root's text, that source is
// copied verbatim instead of re-serializing the DOM - so a whole message comes
// back byte-for-byte as the agent (or the user) wrote it, keeping the details a
// round-trip cannot recover: '*' vs '-' bullets, setext headings, reference
// links, the original table alignment and column padding, hard-wrap positions.
// A WeakMap rather than a data-* attribute so a long transcript doesn't hold a
// second copy of every message in the DOM.
const SOURCES = new WeakMap<Element, string>()

// setMarkdownSource is called by the Markdown component for its root element;
// passing null (on unmount) forgets it.
export function setMarkdownSource(el: Element, text: string | null): void {
  if (text == null) SOURCES.delete(el)
  else SOURCES.set(el, text)
}

interface Ctx {
  range: Range
  // Inside a [data-md-root] subtree, so emit markdown syntax rather than plain text.
  md: boolean
  // Inside a code block: preserve whitespace verbatim.
  pre: boolean
  // Inside a list item: blocks are separated by a single newline (tight list)
  // so a nested list does not get a blank line before every entry.
  tight: boolean
}

// intersectsRange reports whether any part of node falls inside the selection.
// Used to prune whole subtrees, and (unlike cloneContents) it keeps the live
// ancestors visible, so a partially selected <li> still knows its list is
// ordered.
function intersectsRange(range: Range, node: Node): boolean {
  const doc = node.ownerDocument
  if (!doc) return false
  const r = doc.createRange()
  try {
    // An empty element (<br>, <hr>, <img>) has no contents to select, and a
    // collapsed range never "overlaps" anything - select the element itself so
    // its position among its siblings is what gets compared.
    if (node.nodeType === Node.ELEMENT_NODE && !node.hasChildNodes()) r.selectNode(node)
    else r.selectNodeContents(node)
  } catch {
    return false
  }
  // this.start < other.end && this.end > other.start
  return (
    range.compareBoundaryPoints(Range.END_TO_START, r) < 0 &&
    range.compareBoundaryPoints(Range.START_TO_END, r) > 0
  )
}

// wholeSource returns the original markdown for a rendered root when the
// selection covers all of its text, and '' otherwise.
//
// "Covers all of its text" is measured from the first to the last non-blank
// character rather than from the element's boundaries: react-markdown leaves
// whitespace-only text nodes between block elements, and a drag (or a
// triple-click) that visually spans the whole message usually stops at the last
// visible character, which would fail a strict element-containment test.
function wholeSource(el: Element, range: Range): string {
  const text = SOURCES.get(el)
  if (!text) return ''
  const doc = el.ownerDocument
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let first: Text | null = null
  let last: Text | null = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!/\S/.test((n as Text).data)) continue
    if (!first) first = n as Text
    last = n as Text
  }
  if (!first || !last) return ''
  const r = doc.createRange()
  try {
    r.setStart(first, first.data.search(/\S/))
    r.setEnd(last, last.data.length - (/\s*$/.exec(last.data)?.[0].length ?? 0))
  } catch {
    return ''
  }
  const covered =
    range.compareBoundaryPoints(Range.START_TO_START, r) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, r) >= 0
  return covered ? text.trim() : ''
}

// isUnselectable skips what the browser's own copy would skip: `select-none`
// chrome (tool-card labels, badges, buttons) and anything not rendered. The
// chat marks a lot of its scaffolding select-none precisely so a drag over the
// transcript picks up the conversation and not the furniture - taking over the
// copy event must not undo that. (In jsdom there is no layout, so this is a
// no-op there.)
function isUnselectable(el: Element): boolean {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el)
  if (!style) return false
  return style.userSelect === 'none' || style.display === 'none' || style.visibility === 'hidden'
}

// textOf returns a text node's contribution, clipped to the selection at the
// two ends of the range and whitespace-collapsed unless inside a code block.
function textOf(node: Text, ctx: Ctx): string {
  const { range } = ctx
  let start = 0
  let end = node.data.length
  if (node === range.startContainer) start = range.startOffset
  if (node === range.endContainer) end = range.endOffset
  const raw = node.data.slice(start, Math.max(start, end))
  return ctx.pre ? raw : raw.replace(/\s+/g, ' ')
}

// block wraps a block-level element's content with separators; adjacent
// separators are merged (not summed) as siblings are concatenated, and the
// outermost ones are trimmed at the end.
function block(content: string, ctx: Ctx): string {
  const body = content.trim()
  if (!body) return ''
  const sep = ctx.tight ? '\n' : '\n\n'
  return sep + body + sep
}

// gap returns the newline run to put before (or, with `end`, after) a block's
// content: at least `min`, but never fewer than the newlines the content
// already carried, so a nested block's wider spacing survives its wrapper.
function gap(content: string, min: number, end = false): string {
  const ws = (end ? /\s*$/.exec(content) : /^\s*/.exec(content))?.[0] ?? ''
  return '\n'.repeat(Math.max(min, ws.split('\n').length - 1))
}

// prefixLines puts a marker on the first line and an indent on the rest - the
// shape both blockquotes and list items need.
function prefixLines(text: string, first: string, rest: string): string {
  const lines = text.split('\n')
  return lines.map((l, i) => (i === 0 ? first + l : l ? rest + l : rest.trimEnd())).join('\n')
}

// fenceFor picks a fence long enough to survive backticks inside the code.
function fenceFor(code: string): string {
  let longest = 0
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

// inlineCode wraps inline code, widening the delimiter when the content itself
// holds backticks (the CommonMark rule, plus the padding space it requires).
function inlineCode(text: string): string {
  const ticks = '`'.repeat(Math.max(1, (text.match(/`+/g) ?? []).reduce((n, r) => Math.max(n, r.length), 0) + 1))
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return ticks + pad + text + pad + ticks
}

// children concatenates the converted child nodes, joining them the way markdown
// wants rather than by plain concatenation:
//   - a run of newlines where two siblings meet is MERGED, not summed, so two
//     adjacent plain blocks stay one line apart while two markdown blocks
//     (which pad with a blank line each) stay one blank line apart;
//   - indentation following a hard break (react-markdown keeps the source
//     newline as a text node after the <br>) is dropped.
function children(node: Node, ctx: Ctx): string {
  let out = ''
  for (const child of Array.from(node.childNodes)) {
    let part = convert(child, ctx)
    if (!part) continue
    if (!ctx.pre) {
      const lead = /^\n+/.exec(part)?.[0].length ?? 0
      const trail = /\n+$/.exec(out)?.[0].length ?? 0
      if (lead && trail) {
        part = '\n'.repeat(Math.max(lead, trail) - trail) + part.slice(lead)
      } else if (trail) {
        part = part.replace(/^[ \t]+/, '')
      }
    }
    out += part
  }
  return out
}

// listItems renders the selected <li> children of a <ul>/<ol>.
function listItems(el: Element, ctx: Ctx): string {
  const ordered = el.tagName === 'OL'
  const startAttr = Number((el as HTMLOListElement).start)
  let n = ordered && Number.isFinite(startAttr) && startAttr > 0 ? startAttr : 1
  const out: string[] = []
  for (const li of Array.from(el.children)) {
    if (li.tagName !== 'LI') continue
    const marker = ordered ? `${n}. ` : '- '
    n++
    if (!intersectsRange(ctx.range, li)) continue
    // A GFM task list renders its checkbox as a disabled <input>; put the
    // markdown box back rather than dropping it.
    const box = li.querySelector(':scope > input[type=checkbox]')
    const check = box ? ((box as HTMLInputElement).checked ? '[x] ' : '[ ] ') : ''
    const body = children(li, { ...ctx, tight: true }).trim()
    if (!body && !check) continue
    out.push(prefixLines(check + body, marker, ' '.repeat(marker.length)))
  }
  return out.join('\n')
}

// columnAligns recovers each column's GFM alignment. remark-gfm puts the
// delimiter row's alignment on every cell as an inline `text-align`, so it
// survives into the DOM and a partial selection can put the `:---:` markers
// back - the column is read from whichever row declares it, including rows the
// selection clipped away, since alignment is a property of the column.
function columnAligns(el: Element, width: number): string[] {
  const aligns = Array.from({ length: width }, () => '')
  for (const tr of Array.from(el.querySelectorAll('tr'))) {
    let i = 0
    for (const cell of Array.from(tr.children)) {
      if (cell.tagName !== 'TH' && cell.tagName !== 'TD') continue
      if (i < width && !aligns[i]) aligns[i] = (cell as HTMLElement).style?.textAlign ?? ''
      i++
    }
  }
  return aligns
}

// alignBar is the delimiter cell for one column's alignment.
function alignBar(align: string): string {
  if (align === 'center') return ':---:'
  if (align === 'right') return '---:'
  if (align === 'left') return ':---'
  return '---'
}

// tableRows renders a <table> as a GFM pipe table. A partial selection can
// clip away the header row, in which case the rows are emitted without the
// alignment line (a table needs a header, so this degrades to plain lines).
function tableRows(el: Element, ctx: Ctx): string {
  const cellCtx = { ...ctx, tight: true }
  const rows: { header: boolean; cells: string[] }[] = []
  for (const tr of Array.from(el.querySelectorAll('tr'))) {
    if (!intersectsRange(ctx.range, tr)) continue
    const cells: string[] = []
    let header = false
    for (const cell of Array.from(tr.children)) {
      if (cell.tagName !== 'TH' && cell.tagName !== 'TD') continue
      if (cell.tagName === 'TH') header = true
      const text = intersectsRange(ctx.range, cell)
        ? children(cell, cellCtx).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
        : ''
      cells.push(text)
    }
    if (cells.length) rows.push({ header, cells })
  }
  if (!rows.length) return ''
  const width = rows.reduce((w, r) => Math.max(w, r.cells.length), 0)
  const line = (cells: string[]) =>
    '| ' + Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ') + ' |'
  const out = [line(rows[0].cells)]
  if (rows[0].header) out.push('| ' + columnAligns(el, width).map(alignBar).join(' | ') + ' |')
  for (const r of rows.slice(1)) out.push(line(r.cells))
  return out.join('\n')
}

function convert(node: Node, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return intersectsRange(ctx.range, node) ? textOf(node as Text, ctx) : ''
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as Element
  const tag = el.tagName.toUpperCase()
  if (SKIP_TAGS.has(tag)) return ''
  if (el.getAttribute('aria-hidden') === 'true') return ''
  if (el.hasAttribute('data-copy-skip')) return ''
  if ((el as HTMLElement).hidden) return ''
  if (isUnselectable(el)) return ''
  if (!intersectsRange(ctx.range, el)) return ''

  if (tag === 'BR') return '\n'

  // Entering rendered markdown: the root is itself a block boundary, so two
  // messages selected together come out separated by a blank line even though
  // the chrome between them is joined with single newlines. A root the
  // selection covers entirely is copied from its original source.
  if (!ctx.md && el.hasAttribute('data-md-root')) {
    const source = wholeSource(el, ctx.range)
    if (source) return '\n\n' + source + '\n\n'
    const inner = children(el, { ...ctx, md: true })
    const body = inner.replace(/^\s+|\s+$/g, '')
    return body ? '\n\n' + body + '\n\n' : ''
  }

  if (!ctx.md) {
    // Outside rendered markdown (tool cards, chips, chrome) copy the visible
    // text, breaking lines at block boundaries the way the browser would - but
    // never tighten a wider gap a nested markdown root asked for, or a bubble
    // <div> wrapping a message would glue it to the next one.
    const inner = children(el, ctx)
    if (!BLOCK_TAGS.has(tag) || !inner.trim()) return inner
    return gap(inner, 1) + inner.trim() + gap(inner, 1, true)
  }

  switch (tag) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
      return block('#'.repeat(Number(tag[1])) + ' ' + children(el, ctx).trim(), ctx)
    case 'P':
      return block(children(el, ctx), ctx)
    case 'HR':
      return block('---', ctx)
    case 'BLOCKQUOTE': {
      const body = children(el, { ...ctx, tight: true }).trim()
      return body ? block(prefixLines(body, '> ', '> '), ctx) : ''
    }
    case 'UL': case 'OL':
      return block(listItems(el, ctx), ctx)
    case 'LI':
      // Reached only when an <li> is not under a list we walked (a clipped
      // selection); render it as a plain bullet.
      return block(prefixLines(children(el, { ...ctx, tight: true }).trim(), '- ', '  '), ctx)
    case 'TABLE':
      return block(tableRows(el, ctx), ctx)
    case 'STRONG': case 'B': {
      const inner = children(el, ctx)
      return inner.trim() ? '**' + inner.trim() + '**' : inner
    }
    case 'EM': case 'I': {
      const inner = children(el, ctx)
      return inner.trim() ? '*' + inner.trim() + '*' : inner
    }
    case 'DEL': case 'S': {
      const inner = children(el, ctx)
      return inner.trim() ? '~~' + inner.trim() + '~~' : inner
    }
    case 'CODE': {
      if (el.hasAttribute('data-md-code-block')) {
        const code = children(el, { ...ctx, pre: true }).replace(/\n+$/, '')
        if (!code.trim()) return ''
        const fence = fenceFor(code)
        return block(fence + (el.getAttribute('data-md-lang') || '') + '\n' + code + '\n' + fence, ctx)
      }
      const inner = children(el, ctx)
      return inner ? inlineCode(inner) : ''
    }
    case 'A': {
      const inner = children(el, ctx).trim()
      const href = el.getAttribute('href') ?? ''
      if (!inner) return ''
      // A bare autolink (the text is the URL) reads better unwrapped.
      if (!href || href === inner) return inner
      return `[${inner}](${href})`
    }
    case 'IMG': {
      // data-md-src carries the path as it was WRITTEN, for an image whose real
      // src is a blob endpoint we rewrote it to (MarkdownRenderer.MarkdownImage);
      // copying should give back the source, not our internal URL.
      const src = el.getAttribute('data-md-src') || el.getAttribute('src') || ''
      return src ? `![${el.getAttribute('alt') ?? ''}](${src})` : ''
    }
    case 'INPUT':
      // Task-list checkboxes are handled by their <li>; nothing else in
      // rendered markdown is an input.
      return ''
    default:
      return BLOCK_TAGS.has(tag) ? block(children(el, ctx), ctx) : children(el, ctx)
  }
}

// rangeToMarkdown serializes one selection range.
export function rangeToMarkdown(range: Range): string {
  if (range.collapsed) return ''
  const root = range.commonAncestorContainer
  const ctx: Ctx = { range, md: false, pre: false, tight: false }
  // Start from the common ancestor so ancestor context (list type, code block,
  // markdown root) is known, and let the intersection test prune the rest.
  // Walking up also catches the selection-within-one-message case: whichever of
  // the two markers is hit first wins, so a selection inside a code block stays
  // raw code even when it happens to be that message's only content.
  for (let n: Node | null = root; n; n = n.parentNode) {
    if (n.nodeType !== Node.ELEMENT_NODE) continue
    const el = n as Element
    if (el.hasAttribute('data-md-root')) {
      // The whole message is selected - hand back exactly what it was rendered
      // from rather than a re-serialization of it.
      const source = wholeSource(el, range)
      if (source) return source
      ctx.md = true
      break
    }
    if (el.hasAttribute('data-md-code-block')) {
      ctx.md = true
      ctx.pre = true
      break
    }
  }
  const md = ctx.pre ? textOfSubtree(root, ctx) : convert(root, ctx)
  return md.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// textOfSubtree is the verbatim path used when the selection starts inside a
// code block: no markdown syntax to recover, just the selected characters.
function textOfSubtree(node: Node, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return intersectsRange(ctx.range, node) ? textOf(node as Text, ctx) : ''
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  if (!intersectsRange(ctx.range, node)) return ''
  let out = ''
  for (const child of Array.from(node.childNodes)) out += textOfSubtree(child, ctx)
  return out
}

// selectionToMarkdown serializes the whole selection (Firefox allows several
// ranges; other browsers give exactly one). Returns '' when there is nothing
// worth putting on the clipboard, so callers can fall back to the default copy.
export function selectionToMarkdown(sel: Selection | null): string {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return ''
  const parts: string[] = []
  for (let i = 0; i < sel.rangeCount; i++) {
    const md = rangeToMarkdown(sel.getRangeAt(i))
    if (md) parts.push(md)
  }
  return parts.join('\n\n')
}
