// Whitespace marks: the faint dot-per-space / arrow-per-tab overlay that makes
// the whitespace in rendered code visible. Off by default, switched on per
// browser (Settings -> Browser -> Whitespace, lib/whitespacePrefs).
//
// The marks are DRAWN BY CSS (`.ws-space` / `.ws-tab` in index.css - a tiled dot
// background, an absolutely positioned arrow) around the real character, rather
// than substituting a middle-dot glyph for it. That is the load-bearing choice:
// a background and a pseudo-element are not put on the clipboard, so what you
// copy out of a diff is still the code. It also means the marks add no layout -
// nothing here changes where a line wraps, which the diff viewer's height probe
// (lib/diffMetrics) depends on.
//
// This runs over the FINAL line HTML - after syntax highlighting and after the
// word-diff overlay - so it needs no cooperation from either, and flipping the
// setting re-renders without re-highlighting a file. Tags are copied through
// verbatim; only the text between them is touched.

// off: render whitespace as whitespace, as every other code viewer here did
// before this existed.
// boundary: mark only the whitespace at the two ends of a line - the indent, and
// any trailing spaces. The two places whitespace is a fact about the code rather
// than the gap between two words, and the reading most people want.
// all: mark every space and tab, including the ones between words.
export type WhitespaceMarks = 'off' | 'boundary' | 'all'

export const WHITESPACE_MARK_MODES: WhitespaceMarks[] = ['off', 'boundary', 'all']

export const WHITESPACE_MARK_LABEL: Record<WhitespaceMarks, string> = {
  off: 'Off',
  boundary: 'Indent + trailing',
  all: 'All',
}

const SPACE_CLASS = 'ws-space'
const TAB_CLASS = 'ws-tab'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// trailingRunStart returns the index at which `html` stops carrying anything but
// whitespace and tags - i.e. where its trailing whitespace begins - or its
// length when the line ends in ink.
//
// Scanned backwards, which stays linear: a '>' can only be the end of a tag (a
// literal one in the text is escaped to &gt; before it gets here), so the '<' it
// pairs with is simply the previous one.
function trailingRunStart(html: string): number {
  let i = html.length
  for (;;) {
    if (i > 0 && (html[i - 1] === ' ' || html[i - 1] === '\t')) { i--; continue }
    if (i > 0 && html[i - 1] === '>') {
      const open = html.lastIndexOf('<', i - 1)
      if (open >= 0) { i = open; continue }
    }
    return i
  }
}

// markWhitespace wraps the marked whitespace of one line of code HTML in the
// spans the CSS draws on. A run of spaces becomes one span (the dots tile at
// 1ch, so a run needs no more markup than a single space); each tab gets its own
// span, because each draws one arrow across its own width.
export function markWhitespace(html: string, mode: WhitespaceMarks): string {
  if (mode === 'off' || !html) return html
  // In `all` every run qualifies, so the backwards scan is skipped entirely.
  const trailStart = mode === 'all' ? 0 : trailingRunStart(html)
  let out = ''
  let i = 0
  // Whether any non-whitespace character has been passed yet, which is all
  // "is this the indent" needs to know.
  let ink = false
  while (i < html.length) {
    const c = html[i]
    if (c === '<') {
      const end = html.indexOf('>', i)
      if (end === -1) { out += html.slice(i); break }
      out += html.slice(i, end + 1)
      i = end + 1
    } else if (c === ' ' || c === '\t') {
      let j = i + 1
      if (c === ' ') while (j < html.length && html[j] === ' ') j++
      const run = html.slice(i, j)
      // A run split across a token boundary arrives as two runs and gets two
      // spans; they tile from their own left edges, so it looks identical.
      out += ink && i < trailStart ? run : `<span class="${c === ' ' ? SPACE_CLASS : TAB_CLASS}">${run}</span>`
      i = j
    } else {
      // An entity (&amp;) is ink like any other character, and its interior
      // holds no whitespace, so it needs no special case beyond this.
      ink = true
      out += c
      i++
    }
  }
  return out
}

// markWhitespaceText is the same thing for a line that was never highlighted:
// it escapes the raw text and marks it, returning null when there is nothing to
// mark. Null lets a caller keep rendering the line as a plain text node instead
// of reaching for dangerouslySetInnerHTML to say the same thing.
export function markWhitespaceText(text: string, mode: WhitespaceMarks): string | null {
  if (mode === 'off' || !text) return null
  const escaped = escapeHtml(text)
  const marked = markWhitespace(escaped, mode)
  return marked === escaped ? null : marked
}
