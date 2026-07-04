// Shared, dependency-light syntax-highlighting helpers used by both the main
// thread (synchronous fallback for tiny inputs) and the highlight Web Worker
// (`highlight.worker.ts`). Keeping these pure and in their own module means the
// worker bundle pulls in highlight.js without dragging in any React/DOM code.
import hljs from './hljs'

// splitHighlightedLines turns highlight.js' single HTML string (which spans
// newlines, with token <span>s that may straddle line boundaries) into one HTML
// string per source line, re-opening any spans still open at a line break so
// each line is independently valid markup.
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = []
  let current = ''
  const openSpans: string[] = []
  let i = 0

  while (i < html.length) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i)
      if (end === -1) { current += html.slice(i); break }
      const tag = html.slice(i, end + 1)
      if (tag.startsWith('<span')) {
        openSpans.push(tag)
        current += tag
      } else if (tag === '</span>') {
        openSpans.pop()
        current += tag
      } else {
        current += tag
      }
      i = end + 1
    } else if (html[i] === '\n') {
      current += openSpans.map(() => '</span>').join('')
      lines.push(current)
      current = openSpans.join('')
      i++
    } else {
      current += html[i]
      i++
    }
  }
  if (current.replace(/<[^>]*>/g, '') !== '' || current.includes('<span')) {
    current += openSpans.map(() => '</span>').join('')
    lines.push(current)
  }
  return lines
}

// highlightLines highlights a whole run of code (so multi-line constructs -
// block comments, template strings - colourise correctly) and returns the
// per-line HTML. On any failure it falls back to plain, HTML-escaped lines.
export function highlightLines(code: string, language: string): string[] {
  // A grammar that isn't registered ('plaintext' is never bundled; a lazy
  // language may not have loaded yet) goes straight to the escaped fallback:
  // hljs.highlight would console.error before throwing, so the catch below
  // isn't enough to keep the console clean.
  if (!hljs.getLanguage(language)) return escapeLines(code)
  try {
    const result = hljs.highlight(code, { language, ignoreIllegals: true })
    return splitHighlightedLines(result.value)
  } catch {
    return escapeLines(code)
  }
}

function escapeLines(code: string): string[] {
  return code.split('\n').map((l) =>
    l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  )
}
