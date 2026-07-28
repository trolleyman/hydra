// Shared, dependency-light syntax-highlighting helpers used by both the main
// thread (synchronous fallback for tiny inputs) and the highlight Web Worker
// (`highlight.worker.ts`). Keeping these pure and in their own module means the
// worker bundle pulls in highlight.js without dragging in any React/DOM code.
import hljs from './hljs'
import { highlightShell, isShellLanguage } from './shellEmbed'

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

// highlightHtml returns highlight.js token HTML for a whole run of code, or null
// when the language isn't one we can highlight (the caller then renders plain
// text). This is THE entry point for highlighting: every surface - rendered
// markdown, the diff viewer, chat tool cards, approval toasts, the shell editor
// - goes through it, so an improvement lands everywhere at once.
//
// A shell snippet detours through lib/shellEmbed, which highlights heredoc
// bodies and inline interpreter code (`python3 -c "..."`) as the language they
// actually are instead of as more bash.
export function highlightHtml(code: string, language: string): string | null {
  // A grammar that isn't registered ('plaintext' is never bundled; a lazy
  // language may not have loaded yet) goes straight to the plain fallback:
  // hljs.highlight would console.error before throwing, so the catch below
  // isn't enough to keep the console clean.
  if (!code || !hljs.getLanguage(language)) return null
  try {
    if (isShellLanguage(language)) return highlightShell(code)
    return hljs.highlight(code, { language, ignoreIllegals: true }).value
  } catch {
    return null
  }
}

// How many times highlightLines will restart after losing the thread, and how
// short a tail is not worth restarting for. A handful of passes covers the real
// files that trip this (three for web/src/DiffViewer.tsx) while bounding the
// cost: each pass re-highlights only what is left, and the first one that finds
// nothing stops the loop.
const RESYNC_MAX_PASSES = 6
const RESYNC_MIN_TAIL = 20

// lastTokenedLine returns the index of the last line carrying any token markup,
// or from-1 when none of them do.
function lastTokenedLine(lines: string[], from: number): number {
  let last = from - 1
  for (let i = from; i < lines.length; i++) if (lines[i].includes('<span')) last = i
  return last
}

// highlightLines highlights a whole run of code (so multi-line constructs -
// block comments, template strings - colourise correctly) and returns the
// per-line HTML. On any failure it falls back to plain, HTML-escaped lines.
//
// A grammar can lose the thread partway through a file and emit everything
// after it as untokenized text. highlight.js handles JSX with one heuristic
// mode in its javascript grammar (which typescript inherits): the element runs
// from `<Tag` to the next `/Tag>` or `/>`, its body is handed to the `xml`
// sublanguage, and a nested `contains` skips inner tags. So an angle-bracketed
// word ANYWHERE inside an element opens a nested tag that swallows the real
// closing one - including inside a `//` comment in the opening tag, which XML
// has no notion of. `#L<n>/#R<n>` in one such comment ate the `</span>` closing
// DiffViewer.tsx's LineNumCell, leaving 3,596 of its 4,075 lines unhighlighted.
// There is no error to catch: `illegal` is false and the HTML is well-formed,
// just colourless.
//
// So: when the output goes dead well before the end, restart the highlighter on
// the remaining lines. Resuming at a line boundary can only lose a construct
// that spans the break, and highlighting there was already lost. A tail that
// comes back with no tokens at all is genuinely plain (data, prose), so the
// loop stops rather than re-scanning it.
export function highlightLines(code: string, language: string): string[] {
  const html = highlightHtml(code, language)
  if (html == null) return escapeLines(code)
  const srcLines = code.split('\n')
  let out = splitHighlightedLines(html)
  let from = 0
  for (let pass = 0; pass < RESYNC_MAX_PASSES; pass++) {
    const resumeAt = lastTokenedLine(out, from) + 1
    if (srcLines.length - resumeAt < RESYNC_MIN_TAIL) break
    const tailHtml = highlightHtml(srcLines.slice(resumeAt).join('\n'), language)
    if (tailHtml == null) break
    const tail = splitHighlightedLines(tailHtml)
    if (!tail.some((l) => l.includes('<span'))) break
    out = out.slice(0, resumeAt).concat(tail)
    from = resumeAt // strictly forward, so the loop always terminates
  }
  return out
}

function escapeLines(code: string): string[] {
  return code.split('\n').map((l) =>
    l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  )
}
