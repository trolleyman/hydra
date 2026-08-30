// Shared, dependency-light syntax-highlighting helpers used by both the main
// thread (synchronous fallback for tiny inputs) and the highlight Web Worker
// (`highlight.worker.ts`). Keeping these pure and in their own module means the
// worker bundle pulls in Prism's grammars without dragging in any React/DOM code.
import { highlightIgnore, isIgnoreLanguage } from './ignoreHighlight'
import { hasLanguage } from './prism'
import { escapeText, highlightTree, treeToHtml, treeToLines } from './prismHtml'
import { highlightShell, isShellLanguage } from './shellEmbed'

// cgoPreambleRanges finds the C preamble Go assigns to an `import "C"`.
// `//go:build cgo` is only a build condition and does not prove a file embeds C;
// the language-defined adjacency of a block comment and import does. Work
// backwards from each import so an earlier ordinary block comment can never be
// swallowed into the preamble.
function cgoPreambleRanges(code: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const imports = /^[ \t]*import[ \t]+"C"/gm
  for (let match = imports.exec(code); match; match = imports.exec(code)) {
    const before = code.slice(0, match.index)
    const close = before.lastIndexOf('*/')
    if (close < 0 || !/^[ \t]*\r?\n[ \t]*$/.test(before.slice(close + 2))) continue
    const start = before.lastIndexOf('/*', close)
    if (start >= 0) ranges.push({ start, end: close + 2 })
  }
  return ranges
}

function highlightCgo(code: string): string | null {
  const ranges = cgoPreambleRanges(code)
  if (!ranges.length) return null
  let cursor = 0
  let html = ''
  for (const range of ranges) {
    const goBefore = highlightTree(code.slice(cursor, range.start), 'go')
    const cBody = highlightTree(code.slice(range.start + 2, range.end - 2), 'c')
    if (goBefore == null || cBody == null) return null
    html += treeToHtml(goBefore.children)
    html += '<span class="token comment">/*</span>'
    html += treeToHtml(cBody.children)
    html += '<span class="token comment">*/</span>'
    cursor = range.end
  }
  const goAfter = highlightTree(code.slice(cursor), 'go')
  return goAfter == null ? null : html + treeToHtml(goAfter.children)
}

// splitHighlightedLines turns a single HTML string (whose token spans may
// straddle newlines) into one HTML string per line, re-opening any span still
// open at a line break. Only the shell path needs it - lib/shellEmbed composes
// HTML directly rather than building a tree; everything else splits the tree
// itself (prismHtml.treeToLines), where the nesting is known rather than
// inferred from the markup.
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

// highlightHtml returns Prism token HTML for a whole run of code, or null when
// the language isn't one we can highlight (the caller then renders plain text).
// This is THE entry point for highlighting: every surface - rendered markdown,
// the diff viewer, chat tool cards, approval toasts, the shell editor - goes
// through it, so an improvement lands everywhere at once.
//
// A shell snippet detours through lib/shellEmbed, which highlights heredoc
// bodies and inline interpreter code (`python3 -c "..."`) as the language they
// actually are instead of as more bash; an ignore file through
// lib/ignoreHighlight, which marks the machinery in each pattern.
export function highlightHtml(code: string, language: string): string | null {
  if (!code) return null
  // These checks come BEFORE hasLanguage: neither name is a grammar Prism can
  // load. `zsh` and `ksh` are shell scripts (its bash grammar answers to
  // bash/sh/shell only) and `gitignore` is highlighted here rather than by a
  // grammar at all - see canHighlight.
  if (isShellLanguage(language)) {
    try {
      return highlightShell(code)
    } catch {
      return null
    }
  }
  if (isIgnoreLanguage(language)) return highlightIgnore(code)
  if (language === 'go') {
    try {
      const embedded = highlightCgo(code)
      if (embedded != null) return embedded
    } catch {
      return null
    }
  }
  if (!hasLanguage(language)) return null
  const tree = highlightTree(code, language)
  return tree == null ? null : treeToHtml(tree.children)
}

// canHighlight reports whether anything here can colour `language` right now -
// a registered Prism grammar, or one of the two languages this module renders
// without one (a shell snippet, an ignore file). It is what a caller should ask
// before falling back to plain text or reaching for prismLazy: hasLanguage alone
// answers "is there a grammar", which is a narrower question and got `gitignore`
// rendered plain in the diff viewer while the same file colourised in the chat.
export function canHighlight(language: string): boolean {
  return isShellLanguage(language) || isIgnoreLanguage(language) || hasLanguage(language)
}

// How many times highlightLines will restart after losing the thread, and how
// short a tail is not worth restarting for. A handful of passes covers the real
// files that trip this while bounding the cost: each pass re-highlights only
// what is left, and the first one that finds nothing stops the loop.
const RESYNC_MAX_PASSES = 6
const RESYNC_MIN_TAIL = 20

// lastTokenedLine returns the index of the last line carrying any token markup,
// or from-1 when none of them do.
function lastTokenedLine(lines: string[], from: number): number {
  let last = from - 1
  for (let i = from; i < lines.length; i++) if (lines[i].includes('<span')) last = i
  return last
}

// linesOnce highlights a run of code and returns per-line HTML, without the
// resync loop. Null when the language isn't highlightable at all.
function linesOnce(code: string, language: string): string[] | null {
  // The two languages with no grammar behind them compose HTML directly, so
  // there is no tree to split - the markup is cut at the newlines instead.
  const hasEmbeddedC = language === 'go' && cgoPreambleRanges(code).length > 0
  if (isShellLanguage(language) || isIgnoreLanguage(language) || hasEmbeddedC) {
    const html = highlightHtml(code, language)
    return html == null ? null : splitHighlightedLines(html)
  }
  const tree = highlightTree(code, language)
  return tree == null ? null : treeToLines(tree)
}

// resyncDeadTail re-runs `highlight` on the part of a file whose output came
// back with no tokens, splicing each retry in, and returns the repaired lines.
//
// A grammar can lose the thread partway through a file and emit everything after
// it as untokenized text. There is no error to catch: the result is well-formed,
// just colourless. highlight.js, which this used to run on, did it to every long
// TSX file in this repo - it has no JSX grammar, so an angle-bracketed word
// inside a JSX element (even inside a `//` comment in the opening tag, which XML
// has no notion of) swallowed the closing tag and took the remaining 3,596 lines
// of DiffViewer.tsx with it.
//
// Prism's grammars survive every derailment we can construct (unterminated
// strings, templates, block comments, JSX tags, heredocs) and this never fires
// across the 635 files of this repo, so it is now insurance rather than a fix:
// kept because it is grammar-agnostic and a healthy file pays only the O(lines)
// scan below, against a failure that is silent and total. Restarting at a line
// boundary can only lose a construct spanning the break, where highlighting was
// already lost; a tail that comes back with no tokens at all is genuinely plain
// (data, prose), so the loop stops rather than re-scanning it.
//
// Exported for its own tests: no real Prism input reaches the recovery path, so
// the tests drive it with a highlighter that derails on purpose.
export function resyncDeadTail(
  srcLines: string[],
  first: string[],
  highlight: (code: string) => string[] | null,
): string[] {
  let out = first
  let from = 0
  for (let pass = 0; pass < RESYNC_MAX_PASSES; pass++) {
    const resumeAt = lastTokenedLine(out, from) + 1
    if (srcLines.length - resumeAt < RESYNC_MIN_TAIL) break
    const tail = highlight(srcLines.slice(resumeAt).join('\n'))
    if (tail == null || !tail.some((l) => l.includes('<span'))) break
    out = out.slice(0, resumeAt).concat(tail)
    from = resumeAt // strictly forward, so the loop always terminates
  }
  return out
}

// highlightLines highlights a whole run of code (so multi-line constructs -
// block comments, template strings - colourise correctly) and returns the
// per-line HTML. On any failure it falls back to plain, HTML-escaped lines.
export function highlightLines(code: string, language: string): string[] {
  const first = linesOnce(code, language)
  if (first == null) return escapeLines(code)
  return resyncDeadTail(code.split('\n'), first, (tail) => linesOnce(tail, language))
}

function escapeLines(code: string): string[] {
  return code.split('\n').map(escapeText)
}
