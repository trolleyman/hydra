// The one numbered, syntax-highlighted view of a whole text file.
//
// It started life inside RepositoryView (as CodeView) and now serves the
// lightbox's text viewer as well, so a file reads identically wherever you open
// it: the same gutter, the same wrapping rule, the same highlighter, and one
// place to fix any of them. The repository browser adds line selection and the
// URL-hash highlight on top through the optional props; the lightbox passes
// neither and gets the plain read-only pane.
//
// One line = one row: that (not a hanging indent) is what keeps a WRAPPED line
// lined up under its own code, and what lets the gutter cell stretch the full
// height of the line it numbers so its dividing rule has no gaps.
import { Fragment, useEffect, useMemo, useState } from 'react'
import { ensureLanguage } from '../lib/prismLazy'
import { canHighlight, highlightLines } from '../lib/highlightCore'
import { inRange, type LineRange } from '../lib/lineRange'
import { CODE_TEXT } from '../lib/diffMetrics'
import { renderWordDiffHtml, WORD_ADD_CLASS, WORD_DEL_CLASS } from '../lib/wordDiff'
import { markWhitespace } from '../lib/whitespaceMarks'
import { useWhitespaceMarks } from '../lib/whitespacePrefs'
import type { EditRow } from '../lib/editDiff'

// Above this, highlighting is skipped and the text renders plain. Prism runs
// synchronously on the main thread here (unlike the diff viewer, which has a
// worker), and a megabyte of tokenising is a visible freeze - on opening a
// lightbox, or on stepping into a generated file in the repository browser.
export const MAX_HIGHLIGHT_BYTES = 128 * 1024

// splitHighlighted highlights a whole file and returns it as one HTML string per
// line. Highlighting the file as a WHOLE (not line by line) is what colours a
// multi-line construct - a block comment, a template literal - correctly;
// highlightLines carries the resync guard for a grammar that derails, and falls
// back to escaped plain text when there is no grammar at all.
function splitHighlighted(content: string, lang: string): string[] {
  const lines = highlightLines(content, content.length > MAX_HIGHLIGHT_BYTES ? 'plaintext' : lang)
  // A file's final newline ends its last line, it doesn't start another one -
  // drop the empty tail it splits into so the gutter counts what an editor
  // counts.
  if (lines.length > 1 && lines[lines.length - 1] === '' && content.endsWith('\n')) lines.pop()
  return lines
}

export function CodePane({ content, lang, wrap, className, highlightRange, onSelectLine }: {
  content: string
  /** Prism language name; '' (or one with no grammar) renders plain. */
  lang: string
  /** Soft-wrap long lines instead of scrolling the pane sideways. */
  wrap: boolean
  /** Extra classes for the pane itself - padding, type size overrides. */
  className?: string
  /** Lines to tint (the repository browser's URL-hash selection). */
  highlightRange?: LineRange | null
  /** Makes the gutter numbers clickable; shift-click extends the range. */
  onSelectLine?: (line: number, extend: boolean) => void
}) {
  // Fetch a not-yet-bundled grammar on demand (the diff viewer does the same via
  // its worker), then re-highlight: hasGrammar flips false->true once it lands.
  const [, bumpLoaded] = useState(0)
  useEffect(() => {
    if (canHighlight(lang)) return
    let cancelled = false
    ensureLanguage(lang).then((ok) => { if (ok && !cancelled) bumpLoaded((n) => n + 1) })
    return () => { cancelled = true }
  }, [lang])

  const hasGrammar = canHighlight(lang)
  const highlighted = useMemo(
    () => splitHighlighted(content, lang),
    // hasGrammar: re-run once a lazily-loaded grammar lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, lang, hasGrammar],
  )
  // The whitespace marks go on the finished HTML, in their own memo: selecting a
  // line re-renders this pane, and a whole file is too many lines to re-walk for
  // it. Off (the default) is the identity, so an untouched browser pays one
  // reference copy.
  const ws = useWhitespaceMarks()
  const lines = useMemo(
    () => (ws === 'off' ? highlighted : highlighted.map((l) => markWhitespace(l, ws))),
    [highlighted, ws],
  )

  const gutterWidth = `${Math.max(2, String(lines.length).length)}ch`

  // CODE_TEXT, not text-xs: this is a Code surface, so it follows the Code size
  // control (the gutter is already `ch`-based and follows by itself).
  // leading-snug stays a ratio - nothing here streams, so the whole-pixel rule
  // the diff rows follow doesn't apply.
  return (
    <div className={`${CODE_TEXT} font-mono leading-snug ${wrap ? 'w-full' : 'w-max min-w-full'} ${className ?? ''}`}>
      {lines.map((html, i) => {
        // The 1-based line number doubles as the scroll/highlight anchor: the
        // page scrolls the row carrying data-line into view when the URL hash
        // selects it, and we tint the selected range GitHub-style. Clicking the
        // gutter number selects the line (shift+click extends the range).
        const ln = i + 1
        const isHi = inRange(ln, highlightRange)
        return (
          <div key={i} data-line={ln} className={`flex ${isHi ? 'bg-amber-100/70 dark:bg-amber-400/10' : 'hover:bg-gray-50 dark:hover:bg-gray-800/40'}`}>
            <span
              onMouseDown={onSelectLine ? (e) => { if (e.shiftKey) e.preventDefault() } : undefined}
              onClick={onSelectLine ? (e) => onSelectLine(ln, e.shiftKey) : undefined}
              title={onSelectLine ? `Select line ${ln}` : undefined}
              // The rule sits BETWEEN the numbers and the code (8px / 10px), the
              // spacing the chat's Read card uses - it used to hug the code with
              // 12px of empty gutter behind it.
              style={{ width: `calc(${gutterWidth} + 1rem)` }}
              className={`sticky left-0 z-10 shrink-0 select-none text-right pr-2 pl-2 border-r ${onSelectLine ? 'cursor-pointer hover:text-blue-500 dark:hover:text-blue-400' : ''} ${isHi
                ? 'text-amber-700 dark:text-amber-300 bg-amber-100/70 dark:bg-amber-400/10 border-amber-200 dark:border-amber-500/20'
                : 'text-gray-400 dark:text-gray-600 bg-white dark:bg-gray-900 border-gray-100 dark:border-gray-800'}`}
            >
              {ln}
            </span>
            {/* A blank line renders a <br> rather than nothing: an empty box
                contributes nothing to a selection, so copying a file used to
                drop its blank lines entirely (verified in Chromium). The <br>
                serializes as the newline it stands for, and keeps the row one
                line tall without a min-height. */}
            <code
              className={`bg-transparent flex-1 pl-2.5 pr-3 ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}
              dangerouslySetInnerHTML={{ __html: html || '<br>' }}
            />
          </div>
        )
      })}
    </div>
  )
}

// DiffPane renders a unified diff of two whole files, in the same gutter/wrap
// language as CodePane above: two number columns (before, after), a -/+ marker
// inside the copied text, and the changed characters within a line marked by the
// shared word diff (lib/wordDiff) exactly as the diff viewer and the chat's Edit
// cards mark them.
//
// The rows come from lib/editDiff - the same LCS the chat uses to diff an Edit's
// two strings - so there is one line-diff engine in the app, not two.
export function DiffPane({ rows, lang, wrap, className }: {
  rows: EditRow[]
  lang: string
  wrap: boolean
  className?: string
}) {
  const [, bumpLoaded] = useState(0)
  useEffect(() => {
    if (canHighlight(lang)) return
    let cancelled = false
    ensureLanguage(lang).then((ok) => { if (ok && !cancelled) bumpLoaded((n) => n + 1) })
    return () => { cancelled = true }
  }, [lang])

  const hasGrammar = canHighlight(lang)
  // Each SIDE is highlighted as one run of code, not line by line, so a
  // multi-line construct colourises correctly - and each side is reassembled
  // whole (a context line belongs to both) so neither is highlighted as if the
  // other side's lines were missing. Same approach as the chat's EditDiffPanel.
  const html = useMemo(() => {
    const oldSrc: string[] = []
    const newSrc: string[] = []
    const pick = rows.map((r) => {
      if (r.type !== 'add') oldSrc.push(r.content)
      if (r.type !== 'del') newSrc.push(r.content)
      return r.type === 'del' ? oldSrc.length - 1 : newSrc.length - 1
    })
    const oldLines = splitHighlighted(oldSrc.join('\n'), lang)
    const newLines = splitHighlighted(newSrc.join('\n'), lang)
    return rows.map((r, i) => (r.type === 'del' ? oldLines[pick[i]] : newLines[pick[i]]) ?? '')
    // hasGrammar: re-run once a lazily-loaded grammar lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, lang, hasGrammar])

  const ws = useWhitespaceMarks()
  const width = Math.max(2, ...rows.map((r) => String(r.newNum ?? r.oldNum ?? '').length))
  const numStyle = { width: `calc(${width}ch + 1rem)` }

  return (
    <div className={`${CODE_TEXT} font-mono leading-snug ${wrap ? 'w-full' : 'w-max min-w-full'} ${className ?? ''}`}>
      {rows.map((row, i) => {
        if (row.type === 'gap') {
          return (
            <div key={i} className="select-none px-2 py-0.5 text-gray-400 dark:text-gray-600 border-y border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40">
              ...
            </div>
          )
        }
        const isAdd = row.type === 'add'
        const isDel = row.type === 'del'
        const bg = isAdd ? 'bg-green-50 dark:bg-green-500/10' : isDel ? 'bg-red-50 dark:bg-red-500/10' : ''
        const numBg = isAdd ? 'bg-green-100/70 dark:bg-green-500/15' : isDel ? 'bg-red-100/70 dark:bg-red-500/15' : 'bg-white dark:bg-gray-900'
        // Whitespace marks last, over the word diff as well as the highlighting.
        const code = markWhitespace(row.ranges?.length
          ? renderWordDiffHtml(html[i], row.content, row.ranges, isAdd ? WORD_ADD_CLASS : WORD_DEL_CLASS)
          : html[i], ws)
        // The two number columns are one sticky unit, so they stay put together
        // when an unwrapped long line scrolls the pane sideways.
        return (
          <div key={i} className={`flex ${bg}`}>
            <span className={`sticky left-0 z-10 flex shrink-0 select-none border-r border-gray-100 dark:border-gray-800 ${numBg}`}>
              {[row.oldNum, row.newNum].map((n, side) => (
                <Fragment key={side}>
                  <span style={numStyle} className="text-right pr-1.5 pl-1.5 text-gray-400 dark:text-gray-600">{n ?? ''}</span>
                </Fragment>
              ))}
            </span>
            <code className={`bg-transparent flex-1 pl-2.5 pr-3 ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}>
              {/* The marker sits INSIDE the copied text (and the numbers
                  outside, select-none), so what you copy is a diff you can
                  paste rather than a column of numbers. */}
              <span className={`select-none mr-1 ${isAdd ? 'text-green-600 dark:text-green-400' : isDel ? 'text-red-600 dark:text-red-400' : 'text-gray-300 dark:text-gray-700'}`}>
                {isAdd ? '+' : isDel ? '-' : ' '}
              </span>
              <span dangerouslySetInnerHTML={{ __html: code || '<br>' }} />
            </code>
          </div>
        )
      })}
    </div>
  )
}
