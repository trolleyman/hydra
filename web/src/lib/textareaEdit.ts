// Editing behaviours shared by every markdown composer (HighlightedTextarea):
// markdown list continuation on Enter, visual-line Home/End, and keeping the
// caret's line properly in view when the box scrolls.
//
// Everything here works on a plain <textarea> plus its value, so it stays
// testable without a DOM where it can (the list rules) and degrades to the
// browser's native behaviour where it can't measure (the visual-line helpers
// return null when there is no layout, e.g. jsdom).

// A replacement for the textarea's whole value plus where the caret ends up.
export interface TextareaEdit {
  value: string
  caret: number
}

// A markdown list item's prefix: indent + bullet/number + the spacing after it,
// and (for a task list) the checkbox. Deliberately permissive about the spacing
// on both sides - "-foo" continues as "-" just like "  - foo" continues as
// "  - ", because what the user typed is what the next line should start with.
//
// Groups: 1 indent, 2 bullet ("-", "*", "+"), 3 ordered number, 4 ordered
// delimiter (".", ")"), 5 the spacing after the marker, 6 the task checkbox.
const LIST_ITEM_RE = /^([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]*)(\[[ xX]\][ \t]+)?/

// lineBounds returns the [start, end) offsets of the hard line (newline to
// newline) containing `pos`; `end` excludes the trailing newline itself.
export function lineBounds(value: string, pos: number): [number, number] {
  const start = value.lastIndexOf('\n', pos - 1) + 1
  const nl = value.indexOf('\n', pos)
  return [start, nl === -1 ? value.length : nl]
}

// listPrefixFor returns what a new line started from the END of `line` should
// begin with, or null when the line isn't a list item. An ordered marker
// increments ("3." -> "4."); a task checkbox comes back unticked.
export function listPrefixFor(line: string): string | null {
  const m = LIST_ITEM_RE.exec(line)
  if (!m) return null
  const [, indent, bullet, num, delim, gap, task] = m
  // A setext/hr-ish line ("---", "***") is not a list item - continuing it
  // would turn a horizontal rule into an endless run of them.
  if (bullet && /^[-*+]+$/.test(line.trim()) && line.trim().length > 1) return null
  const marker = bullet ?? `${Number(num) + 1}${delim}`
  return `${indent}${marker}${gap}${task ? '[ ] ' : ''}`
}

// enterEdit is what pressing Enter should do when the caret sits at the end of a
// markdown list item - the whole point of item 4: continue the list rather than
// making the user retype "- " on every line.
//
// Returns null when Enter should just do its normal thing (a plain newline):
// there's a selection, the caret isn't at the end of its line, or the line isn't
// a list item. On an EMPTY list item ("- " with nothing after it) it clears the
// marker instead of inserting a line, so pressing Enter twice ends the list -
// without that, a list is impossible to get out of.
export function enterEdit(value: string, selStart: number, selEnd: number): TextareaEdit | null {
  if (selStart !== selEnd) return null
  const [ls, le] = lineBounds(value, selStart)
  if (selStart !== le) return null // only at the end of the line (item 4)
  const line = value.slice(ls, le)
  const prefix = listPrefixFor(line)
  if (prefix == null) return null
  const m = LIST_ITEM_RE.exec(line)!
  // Nothing typed after the marker: this Enter ENDS the list.
  if (line.slice(m[0].length).trim() === '') {
    return { value: value.slice(0, ls) + value.slice(le), caret: ls }
  }
  return {
    value: value.slice(0, selStart) + '\n' + prefix + value.slice(selEnd),
    caret: selStart + 1 + prefix.length,
  }
}

// applyEdit writes an edit into a CONTROLLED textarea: it sets the value through
// the native setter and dispatches an `input` event, which is what makes React
// see it as a real user edit and run the consumer's onChange (a plain
// `ta.value = x` assignment is invisible to React). The caret is placed before
// the dispatch so handlers that read selectionStart (e.g. the composers' undo
// snapshots) capture the right position.
export function applyEdit(ta: HTMLTextAreaElement, edit: TextareaEdit) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (setter) setter.call(ta, edit.value)
  else ta.value = edit.value
  ta.setSelectionRange(edit.caret, edit.caret)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  // React re-renders with the same value, so the DOM node is left alone and the
  // caret survives - but re-assert it on the next frame in case a consumer
  // normalises the text on the way through (which would rewrite value and drop
  // the caret to the end).
  requestAnimationFrame(() => {
    if (ta.value === edit.value && ta.selectionStart !== edit.caret) {
      ta.setSelectionRange(edit.caret, edit.caret)
    }
  })
}

// --- Visual lines -----------------------------------------------------------

// A hidden div that mirrors a textarea's box model and text so ranges can be
// measured inside it - a textarea's own text is not addressable by the Range
// API, so this is the only way to ask where a wrapped line actually breaks.
// One shared node, re-styled per measurement.
let mirror: HTMLDivElement | null = null
let mirrorText: Text | null = null

// The properties that decide where text wraps. Copied from the live textarea so
// the mirror breaks lines at exactly the same places.
const MIRROR_PROPS = [
  'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant',
  'letterSpacing', 'wordSpacing', 'lineHeight', 'textIndent', 'textTransform',
  'textRendering', 'whiteSpace', 'wordBreak', 'overflowWrap', 'tabSize', 'direction',
] as const

// syncMirror points the shared mirror at `ta`'s current geometry and text.
// Returns false when there's nothing to measure (no layout, e.g. jsdom).
function syncMirror(ta: HTMLTextAreaElement): boolean {
  if (typeof document === 'undefined' || ta.clientWidth === 0) return false
  if (!mirror) {
    mirror = document.createElement('div')
    mirrorText = document.createTextNode('')
    mirror.appendChild(mirrorText)
    mirror.setAttribute('aria-hidden', 'true')
    document.body.appendChild(mirror)
  }
  const cs = getComputedStyle(ta)
  const s = mirror.style
  s.cssText = ''
  for (const p of MIRROR_PROPS) {
    const css = p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
    s.setProperty(css, cs.getPropertyValue(css))
  }
  // clientWidth is the padding box minus any scrollbar gutter - i.e. exactly the
  // width the textarea wraps text in, whatever its computed `width` says.
  s.boxSizing = 'content-box'
  s.width = `${ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px`
  s.borderStyle = 'none'
  s.height = 'auto'
  // Parked off-screen (negative offsets create no scroll area) and hidden, so a
  // tall measurement can never disturb the page it is measuring.
  s.position = 'absolute'
  s.top = '-9999px'
  s.left = '0'
  s.visibility = 'hidden'
  s.pointerEvents = 'none'
  s.whiteSpace = 'pre-wrap'
  s.overflowWrap = cs.overflowWrap === 'normal' ? 'break-word' : cs.overflowWrap
  mirrorText!.data = ta.value
  return true
}

// segmentsOfLine breaks the hard line containing `pos` into its VISUAL lines -
// the segments a soft wrap splits it into - as absolute [start, end) offsets.
// Returns null when it can't be measured.
function segmentsOfLine(ta: HTMLTextAreaElement, pos: number): Array<[number, number]> | null {
  const value = ta.value
  const [ls, le] = lineBounds(value, pos)
  if (ls === le) return [[ls, le]] // empty line: one empty segment
  const node = mirrorText
  if (!node) return null
  const range = document.createRange()
  range.setStart(node, ls)
  range.setEnd(node, le)
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0)
  if (rects.length === 0) return null
  // One rect per visual line, top to bottom. Distinct tops only: a line can be
  // reported in several rects (differing heights) at the same y.
  const tops: number[] = []
  for (const r of rects) if (!tops.length || r.top > tops[tops.length - 1] + 0.5) tops.push(r.top)
  const topOf = (i: number): number => {
    range.setStart(node, i)
    range.setEnd(node, i + 1)
    return range.getBoundingClientRect().top
  }
  // For each wrapped segment after the first, binary-search the first character
  // that sits on it. Character tops increase monotonically along the line, so a
  // binary search is exact.
  const starts = [ls]
  for (let t = 1; t < tops.length; t++) {
    let lo = starts[t - 1] + 1
    let hi = le - 1
    let found = le
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (topOf(mid) >= tops[t] - 0.5) {
        found = mid
        hi = mid - 1
      } else lo = mid + 1
    }
    starts.push(found)
  }
  return starts.map((s, i) => [s, i + 1 < starts.length ? starts[i + 1] : le] as [number, number])
}

// visualLineTarget computes where Home/End should put the caret (item 5):
// End goes to the end of the caret's visual line, or - when the caret is
// ALREADY there and the line WRAPS on - to the end of the next wrapped
// segment; Home is the mirror image. The walk stays inside one hard line: at
// the real end (or start) of a line, End/Home do nothing, so the keys never
// carry the caret onto a different line of the text.
// Returns null when there is nothing to measure or nowhere to go, and the
// caller should leave the keystroke to the browser.
export function visualLineTarget(ta: HTMLTextAreaElement, caret: number, edge: 'start' | 'end'): number | null {
  if (!syncMirror(ta)) return null
  const segs = segmentsOfLine(ta, caret)
  if (!segs) return null
  if (edge === 'end') {
    const i = segs.findIndex(([, e]) => e >= caret)
    if (i === -1) return null
    if (segs[i][1] > caret) return segs[i][1]
    // Already at this segment's end: on to the next wrapped one, if the hard
    // line has one. If it doesn't, this is the end of the line - stay put.
    return i + 1 < segs.length ? segs[i + 1][1] : null
  }
  let i = -1
  for (let k = 0; k < segs.length; k++) if (segs[k][0] <= caret) i = k
  if (i === -1) return null
  if (segs[i][0] < caret) return segs[i][0]
  return i > 0 ? segs[i - 1][0] : null
}

// moveCaret places the caret at `to`, extending the selection instead when the
// move was made with Shift held (so Shift+Home/End still select, as they do
// natively).
export function moveCaret(ta: HTMLTextAreaElement, to: number, extend: boolean) {
  if (!extend) {
    ta.setSelectionRange(to, to)
    return
  }
  const backward = ta.selectionDirection === 'backward'
  const anchor = backward ? ta.selectionEnd : ta.selectionStart
  if (to >= anchor) ta.setSelectionRange(anchor, to, 'forward')
  else ta.setSelectionRange(to, anchor, 'backward')
}

// --- Keeping the caret in view ----------------------------------------------

// Extra room kept below the caret's line, on top of the textarea's own bottom
// padding. The markdown backdrop draws a hairline ring around a fenced block
// flush with the last line's box, so a scroll that stops exactly at the line's
// bottom edge shaves it off (item 6).
const CARET_SLACK_PX = 2

// ensureCaretVisible scrolls the textarea so the caret's LINE is fully visible,
// including the box's own padding and a little slack. Browsers scroll a typed
// caret just barely into frame - the bottom padding, and anything the highlight
// backdrop draws at the line's bottom edge (a code block's border), stay clipped.
export function ensureCaretVisible(ta: HTMLTextAreaElement) {
  if (ta.scrollHeight <= ta.clientHeight) return
  if (!syncMirror(ta) || !mirror || !mirrorText) return
  const caret = ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd
  const value = ta.value
  const range = document.createRange()
  // Measure the character the caret sits against - the one after it, or (at the
  // end of a line / of the text) the one before it, whose box is on the same
  // visual line.
  let a = caret
  let b = caret + 1
  if (caret >= value.length || value[caret] === '\n') {
    a = Math.max(0, caret - 1)
    b = caret
  }
  if (a === b) return // empty value: nothing to scroll to
  range.setStart(mirrorText, a)
  range.setEnd(mirrorText, b)
  const rect = range.getBoundingClientRect()
  if (rect.height === 0) return
  const mirrorRect = mirror.getBoundingClientRect()
  const cs = getComputedStyle(ta)
  const padTop = parseFloat(cs.paddingTop) || 0
  const padBottom = parseFloat(cs.paddingBottom) || 0
  // The mirror has the same padding, so a rect's offset inside it is already in
  // the textarea's scroll coordinates (scrollTop 0 = top of the padding box).
  const top = rect.top - mirrorRect.top
  const bottom = top + rect.height
  const max = ta.scrollHeight - ta.clientHeight
  if (bottom + padBottom + CARET_SLACK_PX > ta.scrollTop + ta.clientHeight) {
    const want = bottom + padBottom + CARET_SLACK_PX - ta.clientHeight
    // Within a few px of the end, go all the way: leaving a 2px sliver of the
    // last line unscrolled is exactly the clipping this is here to avoid, and
    // the mirror's metrics can differ from the textarea's by about that much.
    ta.scrollTop = want > max - 4 ? max : Math.max(0, want)
  } else if (top - padTop - CARET_SLACK_PX < ta.scrollTop) {
    ta.scrollTop = Math.max(0, top - padTop - CARET_SLACK_PX)
  }
}
