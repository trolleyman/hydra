import { useEffect, useRef, useState, useCallback, Fragment, useMemo, memo, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, linkOptions, type LinkProps } from '@tanstack/react-router'
import { highlightLines } from './lib/highlightCore'
import { highlightSides } from './lib/highlightClient'
import { getLanguage } from './lib/language'
import hljs from './lib/hljs'
import { ensureLanguage } from './lib/hljsLazy'
import { api } from './stores/apiClient'
import { formatError, apiErrorBody } from './api/format_error'
import { runWithToast } from './lib/apiAction'
import type { AgentResponse, CommitInfo, DiffFile, DiffHunk, DiffLine, DiffResponse } from './api'
import {
  Plus, Calendar, TriangleAlert,
  ChevronDown, ChevronUp, ChevronRight, ChevronLeft, Check, LoaderCircle, RefreshCw, RotateCcw,
  Folder, FolderOpen, X, GitMergeConflict, Bot, File, Files as FilesIcon,
  ArrowRightLeft, MessageSquarePlus, FolderSync,
  SquarePlus, SquareMinus, SquareArrowRight, SquareArrowOutUpRight,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react'
import { DialogIconTile, DialogSectionLabel, DialogCancelButton, DialogConfirmButton } from './components/dialogPrimitives'
import { IconButton } from './components/IconButton'
import { getFileIcon } from './lib/fileIcons'
import { buildFileTree, compactTree, getGroupedFiles, type TreeNode } from './lib/fileTree'
import { hashDiffFile, hashHunks } from './lib/diffSig'
import { buildWordRangeMaps, renderWordDiffHtml, type WordRange } from './lib/wordDiff'
import { Tooltip } from './components/Tooltip'
import { ResizeGrip } from './components/ResizeGrip'
import { pinCardToTop, scrollCardToTop, scrollToDiffLine } from './lib/diffScroll'
import { useMeasuredHeight, useMeasuredWidth } from './lib/useMeasuredHeight'
import {
  UNIFIED_ROW, UNIFIED_GUTTER, UNIFIED_LINE_NUM_CLASS, UNIFIED_MARKER, UNIFIED_CODE_CLASS,
  SBS_ROW, SBS_HALF, SBS_LINE_NUM, SBS_MARKER, SBS_CODE,
  EXPANDER_ROW, EXPANDER_BTN, NOTICE_BLOCK, HIDDEN_BLOCK,
  measureBodyHeight, queueMeasure,
} from './lib/diffMetrics'
import {
  buildSideBySide, buildSegments, bodyShape, computeGap, trailingContext, isContiguous, isChangeLine,
  CTX, MIN_COLLAPSE_GAP, FULL_MAX_LINES, type RenderSeg, type RevealMap,
} from './lib/diffBody'
import { ArtifactsPanel } from './components/ArtifactsPanel'
import { ReviewDraftPopover } from './components/ReviewDraftPopover'
import { TestsPanel } from './components/TestsPanel'
import { PreviewPanel } from './components/PreviewPanel'
import { ImageDiffView, type ImageDiffMode } from './components/ArtifactImageDiff'
import { SettingsPopover, SettingsGroupLabel, SettingsOptionRow } from './components/SettingsPopover'
import { InfoTooltip } from './components/InfoTooltip'
import { isImagePath, agentBlobUrl } from './lib/imageDiff'
import { useArtifactSpans } from './lib/artifactColumns'
import { useDialogStore } from './stores/dialogStore'
import { StorageKeys, readLocal, writeLocal } from './lib/storage'
import { loadAgentViewPrefs, patchAgentViewPrefs } from './lib/agentViewPrefs'
import { addReviewComment, removeReviewComment, clearReviewDraft, loadReviewDraft, type PendingReviewComment } from './lib/reviewDrafts'
import { useCopyFlash } from './lib/useCopyFlash'
import { CopyStateIcon } from './components/CopyStateIcon'

// ── Syntax highlighting helpers ───────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const { state, copy } = useCopyFlash()
  // Reuse the same hint tooltip rather than adding a second one: swap its label
  // to reflect the copy outcome while the icon flashes, then revert to "Copy path".
  const label = state === 'ok' ? 'Copied to clipboard' : state === 'err' ? 'Copy failed' : 'Copy path'
  return (
    <Tooltip content={label}>
      <button
        onClick={(e) => { e.stopPropagation(); void copy(text) }}
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 shrink-0 cursor-pointer transition-colors"
      >
        <CopyStateIcon state={state} idleColor="text-gray-400" />
      </button>
    </Tooltip>
  )
}

// RepoOpenButton deep-links the file to the repository browser at the agent's
// branch - the diff-header sibling of the tests panel's "open in repository"
// affordance (CaseTree's RepoLinkButton). It renders a real <Link> (an <a href>)
// so middle-click / Ctrl-click open it in a new tab natively; stopPropagation
// keeps a left-click from also toggling the header's collapse. Styled to match
// the adjacent CopyButton rather than the test row's hover-reveal look, since
// the header's actions are always visible.
function RepoOpenButton({ target }: { target: LinkProps }) {
  return (
    <Tooltip content="Open in repository">
      <Link
        {...target}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 shrink-0 cursor-pointer transition-colors"
      >
        <SquareArrowOutUpRight className="w-3.5 h-3.5 text-gray-400" />
      </Link>
    </Tooltip>
  )
}


// A per-line comment editor. "Send" fires the comment at the agent immediately;
// "Add to review" (when onAddToReview is wired - i.e. not the read-only repo
// view) instead queues it into the per-agent review batch for a later single
// submit. onAddToReview is synchronous (a localStorage write), so it just closes
// the row via the parent's onCancel after queuing.
function CommentRow({ onSubmit, onAddToReview, onCancel }: {
  onSubmit: (text: string) => Promise<void>
  onAddToReview?: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { ref.current?.focus() }, [])

  const handleSubmit = async () => {
    if (!text.trim() || sending) return
    setSending(true)
    await onSubmit(text)
    setSending(false)
  }

  const handleAdd = () => {
    if (!text.trim() || sending || !onAddToReview) return
    onAddToReview(text)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      // Ctrl+Enter queues into the review batch when that's available (the common
      // reviewing flow), else sends immediately.
      if (onAddToReview) handleAdd(); else handleSubmit()
    } else if (e.key === 'Escape') onCancel()
  }

  return (
    <div className="border-y border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/10 px-4 py-3">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full h-20 p-2 text-xs font-sans bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded focus:ring-1 focus:ring-blue-500 outline-none resize-none"
        placeholder={onAddToReview ? 'Write a comment... (Ctrl+Enter to add to review)' : 'Write a comment... (Ctrl+Enter to submit)'}
      />
      <div className="flex justify-end gap-2 mt-2">
        <button
          onClick={onCancel}
          className="px-2 py-1 text-[10px] font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors cursor-pointer"
        >
          Cancel
        </button>
        {onAddToReview && (
          <button
            disabled={!text.trim() || sending}
            onClick={handleAdd}
            className="px-2 py-1 text-[10px] font-medium text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50 rounded transition-colors cursor-pointer"
          >
            Add to review
          </button>
        )}
        <button
          disabled={!text.trim() || sending}
          onClick={handleSubmit}
          className="px-2 py-1 text-[10px] font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded transition-colors cursor-pointer"
        >
          {sending ? 'Sending...' : 'Send'}
        </button>
      </div>
    </div>
  )
}

// CommentButton overlays a line-number gutter cell and reveals a small "add
// comment" button centred over the gutter on hover. The button has a solid
// button-style background so the icon stays legible on top of code/line
// backgrounds, and its tooltip sits directly above the icon's centre.
// memo + an (idx, onToggle) shape rather than a bound `onClick`: a diff line
// re-renders whenever its file re-highlights (the agent edits it), but the gutter
// comment button is identical across those. A stable onToggle (see UnifiedHunk /
// SideBySideHunk) lets this skip that churn - one button per line adds up.
const CommentButton = memo(function CommentButton({ idx, onToggle }: { idx: number; onToggle: (idx: number) => void }) {
  return (
    // The overlay spans the gutter to centre the button but is pointer-events-none
    // so it doesn't swallow clicks meant for the (now clickable) line numbers
    // underneath; only the button (via the Tooltip wrapper) re-enables pointer
    // events, so both commenting and its hover hint still work.
    <div className="absolute inset-0 z-10 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
      <Tooltip content="Add comment" side="top" className="pointer-events-auto">
        <button
          onClick={(e) => { e.stopPropagation(); onToggle(idx) }}
          className="flex items-center justify-center w-4 h-4 rounded bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 shadow-sm hover:bg-blue-50 dark:hover:bg-blue-900/40 cursor-pointer"
        >
          <MessageSquarePlus className="w-3 h-3 text-blue-500" />
        </button>
      </Tooltip>
    </div>
  )
})



// ── Line selection ────────────────────────────────────────────────────────────
// Clicking a gutter number selects that line (shift+click extends the range);
// the selection is a side (old/new) plus a 1-based [start,end]. By default this
// lives in local per-file state (the agent diff has no per-file route, so it
// isn't URL-addressable there). The repository compare-diff's single-file view
// IS URL-addressable, so it drives the selection from the URL by passing the
// optional controlled `selection`/`onSelectLine` props to FileDiff below.

export type DiffSide = 'old' | 'new'
export type DiffLineSelection = { side: DiffSide; start: number; end: number }

function selectionHas(sel: DiffLineSelection | null | undefined, side: DiffSide, num: number | null | undefined): boolean {
  return !!sel && num != null && sel.side === side && num >= sel.start && num <= sel.end
}

// A left accent bar for a selected diff row/side. Inset box-shadow so it reads
// clearly over the green/red change tints without shifting layout.
const SELECTED_ROW_STYLE = { boxShadow: 'inset 2px 0 0 0 #f59e0b' }
const SELECTED_NUM_CLASS = 'bg-amber-100 dark:bg-amber-400/15 !text-amber-700 dark:!text-amber-300'

// LineNumCell renders one gutter line number that, when a line number is present
// and onSelectLine is wired, is clickable to select the line (shift+click to
// extend the range). It sits under the hover comment overlay, which is
// pointer-events-none until hovered, so plain clicks reach this.
// memo: a line re-renders whenever its file re-highlights (live edits stream a
// new highlight map into the hunk), but a gutter number only changes when the
// line's own number/selection does. Skipping the unchanged cells cuts the diff's
// biggest render cost - there are two of these per line, across every hunk.
const LineNumCell = memo(function LineNumCell({ num, side, baseClass, selected, onSelectLine }: {
  num: number | null | undefined
  side: DiffSide
  baseClass: string
  selected: boolean
  onSelectLine?: (side: DiffSide, line: number, extend: boolean) => void
}) {
  const clickable = !!onSelectLine && num != null
  return (
    <span
      onMouseDown={clickable ? (e) => { if (e.shiftKey) e.preventDefault() } : undefined}
      onClick={clickable ? (e) => { e.stopPropagation(); onSelectLine!(side, num!, e.shiftKey) } : undefined}
      title={clickable ? `Select line ${num}` : undefined}
      // Locates a line+side for scroll-into-view when a selection is deep-linked
      // (the repository compare-diff scrolls #L<n>/#R<n>'s first row into view).
      data-diff-ln={num != null ? `${side}:${num}` : undefined}
      className={`${baseClass} ${clickable ? 'cursor-pointer hover:!text-blue-500 dark:hover:!text-blue-400' : ''} ${selected ? SELECTED_NUM_CLASS : ''}`}
    >
      {num ?? ''}
    </span>
  )
})

// ── Diff Hunk rendering ───────────────────────────────────────────────────────


// Row hover tint. This is a translucent overlay rather than `hover:brightness-95`
// on the row: a filter promotes the row to its own compositing layer and forces a
// re-raster of its text on every pointer move between rows, which leaves ghosted
// glyph fragments from neighbouring wrapped rows. A black overlay at alpha a is
// arithmetically identical to brightness(1-a), so the light-mode tint is unchanged.
const UNIFIED_ROW_HOVER = "after:content-[''] after:pointer-events-none hover:after:absolute hover:after:inset-0 hover:after:bg-black/[0.05] dark:hover:after:bg-white/[0.04]"

// Intra-line "word diff" tints. A changed line already carries a faint whole-row
// tint (bg-*-50); these darker spans mark the exact characters that differ so the
// eye lands on the actual edit rather than re-reading the whole line. Deletions
// read red, additions green - the same red/green language as the row.
const WORD_DEL_CLASS = 'rounded-[2px] bg-red-300/45 dark:bg-red-400/25'
const WORD_ADD_CLASS = 'rounded-[2px] bg-green-300/45 dark:bg-green-400/25'

// Empty maps shared by every line without word-diff data, so the memo'd hunks
// keep a stable prop identity when word highlighting is off or a file has none.
const EMPTY_WORD_RANGES: Map<number, WordRange[]> = new Map()

// codeCellHtml resolves the HTML for a diff line's code cell: the word-diff
// overlay when this line has changed ranges, else the plain syntax-highlighted
// HTML. Returns null to signal "render the raw content as a text node" (no
// highlight, no word ranges) - the safe path that needs no dangerouslySetInnerHTML.
function codeCellHtml(highlighted: string | undefined, content: string, ranges: WordRange[] | undefined, wordClass: string): string | null {
  if (ranges && ranges.length) return renderWordDiffHtml(highlighted, content, ranges, wordClass)
  return highlighted ?? null
}

const UnifiedHunk = memo(function UnifiedHunk({ hunk, highlightedOld, highlightedNew, wordRangesOld, wordRangesNew, onComment, onAddToReview, readOnly, selection, onSelectLine }: {
  hunk: DiffHunk
  highlightedOld: Map<number, string>
  highlightedNew: Map<number, string>
  wordRangesOld: Map<number, WordRange[]>
  wordRangesNew: Map<number, WordRange[]>
  onComment: (lineNum: number, isNew: boolean, text: string) => void
  onAddToReview?: (lineNum: number, isNew: boolean, text: string) => void
  readOnly?: boolean
  selection?: DiffLineSelection | null
  onSelectLine?: (side: DiffSide, line: number, extend: boolean) => void
}) {
  const [openCommentIdx, setOpenCommentIdx] = useState<number | null>(null)
  // Stable so the memo'd CommentButton on each line skips a re-highlight tick.
  const toggleComment = useCallback((idx: number) => setOpenCommentIdx((cur) => (cur === idx ? null : idx)), [])
  return (
    <div>
      {hunk.lines.map((line, idx) => {
        const isAdd = line.type === 'addition'
        const isDel = line.type === 'deletion'
        const isNoNewline = line.type === 'no_newline'
        const highlighted = isAdd
          ? (line.new_line_num != null ? highlightedNew.get(line.new_line_num) : undefined)
          : (line.old_line_num != null ? highlightedOld.get(line.old_line_num) : undefined)
        const wordRanges = isAdd
          ? (line.new_line_num != null ? wordRangesNew.get(line.new_line_num) : undefined)
          : isDel ? (line.old_line_num != null ? wordRangesOld.get(line.old_line_num) : undefined) : undefined
        const codeHtml = codeCellHtml(highlighted, line.content, wordRanges, isAdd ? WORD_ADD_CLASS : WORD_DEL_CLASS)
        const bgClass = isAdd ? 'bg-green-50 dark:bg-green-500/15' : isDel ? 'bg-red-50 dark:bg-red-500/15' : ''
        const selOld = selectionHas(selection, 'old', line.old_line_num)
        const selNew = selectionHas(selection, 'new', line.new_line_num)
        const rowSel = selOld || selNew
        return (
          <Fragment key={idx}>
            <div className={`${UNIFIED_ROW} ${UNIFIED_ROW_HOVER} relative group ${bgClass}`} style={rowSel ? SELECTED_ROW_STYLE : undefined}>
              <div className={UNIFIED_GUTTER}>
                <LineNumCell num={line.old_line_num} side="old" baseClass={UNIFIED_LINE_NUM_CLASS} selected={selOld} onSelectLine={onSelectLine} />
                <LineNumCell num={line.new_line_num} side="new" baseClass={UNIFIED_LINE_NUM_CLASS} selected={selNew} onSelectLine={onSelectLine} />
                {!isNoNewline && !readOnly && (
                  <CommentButton idx={idx} onToggle={toggleComment} />
                )}
              </div>
              <span className={`${UNIFIED_MARKER} ${isAdd ? 'text-green-600 dark:text-green-400' : isDel ? 'text-red-600 dark:text-red-400' : 'text-gray-300 dark:text-gray-700'
                }`}>
                {isAdd ? '+' : isDel ? '-' : isNoNewline ? '\\' : ' '}
              </span>
              {isNoNewline ? (
                <span className={`${UNIFIED_CODE_CLASS} text-gray-400 dark:text-gray-500 italic`}>{line.content}</span>
              ) : codeHtml != null ? (
                <span className={UNIFIED_CODE_CLASS} dangerouslySetInnerHTML={{ __html: codeHtml }} />
              ) : (
                <span className={UNIFIED_CODE_CLASS}>{line.content}</span>
              )}
            </div>
            {openCommentIdx === idx && (
              <CommentRow
                onSubmit={async (text) => {
                  // Context lines exist on both sides; comment against the new side
                  // (like the side-by-side view) so the line number matches isNew.
                  const isNew = isAdd || line.type === 'context'
                  await onComment(isNew ? line.new_line_num! : line.old_line_num!, isNew, text)
                  setOpenCommentIdx(null)
                }}
                onAddToReview={onAddToReview ? (text) => {
                  const isNew = isAdd || line.type === 'context'
                  onAddToReview(isNew ? line.new_line_num! : line.old_line_num!, isNew, text)
                  setOpenCommentIdx(null)
                } : undefined}
                onCancel={() => setOpenCommentIdx(null)}
              />
            )}
          </Fragment>
        )
      })}
    </div>
  )
})


const SideBySideHunk = memo(function SideBySideHunk({ hunk, highlightedOld, highlightedNew, wordRangesOld, wordRangesNew, onComment, onAddToReview, readOnly, selection, onSelectLine }: {
  hunk: DiffHunk
  highlightedOld: Map<number, string>
  highlightedNew: Map<number, string>
  wordRangesOld: Map<number, WordRange[]>
  wordRangesNew: Map<number, WordRange[]>
  onComment: (lineNum: number, isNew: boolean, text: string) => void
  onAddToReview?: (lineNum: number, isNew: boolean, text: string) => void
  readOnly?: boolean
  selection?: DiffLineSelection | null
  onSelectLine?: (side: DiffSide, line: number, extend: boolean) => void
}) {
  const [openCommentIdx, setOpenCommentIdx] = useState<number | null>(null)
  const toggleComment = useCallback((idx: number) => setOpenCommentIdx((cur) => (cur === idx ? null : idx)), [])
  const sbsLines = buildSideBySide(hunk.lines)
  return (
    <div>
      {sbsLines.map((line, idx) => {
        const oldHighlighted = line.oldLineNum != null ? highlightedOld.get(line.oldLineNum) : undefined
        const newHighlighted = line.newLineNum != null ? highlightedNew.get(line.newLineNum) : undefined
        // Word-diff overlay only for a real changed line (deletion/addition), not
        // a context line shown on both sides.
        const oldWordRanges = line.oldType === 'deletion' && line.oldLineNum != null ? wordRangesOld.get(line.oldLineNum) : undefined
        const newWordRanges = line.newType === 'addition' && line.newLineNum != null ? wordRangesNew.get(line.newLineNum) : undefined
        const oldCodeHtml = line.oldContent != null ? codeCellHtml(oldHighlighted, line.oldContent, oldWordRanges, WORD_DEL_CLASS) : null
        const newCodeHtml = line.newContent != null ? codeCellHtml(newHighlighted, line.newContent, newWordRanges, WORD_ADD_CLASS) : null
        const oldBg = line.oldType === 'deletion' ? 'bg-red-50 dark:bg-red-500/15' : line.oldType === 'empty' ? 'bg-gray-50 dark:bg-gray-900/50' : ''
        const newBg = line.newType === 'addition' ? 'bg-green-50 dark:bg-green-500/15' : line.newType === 'empty' ? 'bg-gray-50 dark:bg-gray-900/50' : ''
        const selOld = selectionHas(selection, 'old', line.oldLineNum)
        const selNew = selectionHas(selection, 'new', line.newLineNum)
        return (
          <Fragment key={idx}>
            <div className={SBS_ROW}>
              <div className={`${SBS_HALF} ${oldBg}`} style={selOld ? SELECTED_ROW_STYLE : undefined}>
                <div className={UNIFIED_GUTTER}>
                  <LineNumCell num={line.oldLineNum} side="old" baseClass={SBS_LINE_NUM} selected={selOld} onSelectLine={onSelectLine} />
                  {line.oldLineNum != null && !readOnly && (
                    <CommentButton idx={idx} onToggle={toggleComment} />
                  )}
                </div>
                <span className={`${SBS_MARKER} ${line.oldType === 'deletion' ? 'text-red-500' : 'text-gray-300 dark:text-gray-700'}`}>
                  {line.oldType === 'deletion' ? '-' : line.oldType === 'empty' ? '' : ' '}
                </span>
                {line.oldContent != null && oldCodeHtml != null
                  ? <span className={SBS_CODE} dangerouslySetInnerHTML={{ __html: oldCodeHtml }} />
                  : <span className={SBS_CODE}>{line.oldContent ?? ''}</span>
                }
              </div>
              <div className={`${SBS_HALF} ${newBg}`} style={selNew ? SELECTED_ROW_STYLE : undefined}>
                <div className={UNIFIED_GUTTER}>
                  <LineNumCell num={line.newLineNum} side="new" baseClass={SBS_LINE_NUM} selected={selNew} onSelectLine={onSelectLine} />
                  {line.newLineNum != null && !readOnly && (
                    <CommentButton idx={idx} onToggle={toggleComment} />
                  )}
                </div>
                <span className={`${SBS_MARKER} ${line.newType === 'addition' ? 'text-green-500' : 'text-gray-300 dark:text-gray-700'}`}>
                  {line.newType === 'addition' ? '+' : line.newType === 'empty' ? '' : ' '}
                </span>
                {line.newContent != null && newCodeHtml != null
                  ? <span className={SBS_CODE} dangerouslySetInnerHTML={{ __html: newCodeHtml }} />
                  : <span className={SBS_CODE}>{line.newContent ?? ''}</span>
                }
              </div>
            </div>
            {openCommentIdx === idx && (
              <CommentRow
                onSubmit={async (text) => {
                  const lineNum = line.newLineNum ?? line.oldLineNum!
                  const isNew = line.newLineNum != null
                  await onComment(lineNum, isNew, text)
                  setOpenCommentIdx(null)
                }}
                onAddToReview={onAddToReview ? (text) => {
                  const lineNum = line.newLineNum ?? line.oldLineNum!
                  const isNew = line.newLineNum != null
                  onAddToReview(lineNum, isNew, text)
                  setOpenCommentIdx(null)
                } : undefined}
                onCancel={() => setOpenCommentIdx(null)}
              />
            )}
          </Fragment>
        )
      })}
    </div>
  )
})

// ── File diff card ────────────────────────────────────────────────────────────

// PathName renders a file path with the leading directory part lowlit so the eye
// lands on the filename (last segment), which keeps the normal text colour. The
// git change type is conveyed by a ChangeTypeIcon badge next to the name rather
// than by colouring the text.
function PathName({ path }: { path: string }) {
  const idx = path.lastIndexOf('/')
  const dir = idx === -1 ? '' : path.slice(0, idx + 1)
  const base = idx === -1 ? path : path.slice(idx + 1)
  return (
    <>
      {dir && <span className="text-gray-400 dark:text-gray-500">{dir}</span>}
      <span className="text-gray-700 dark:text-gray-300">{base}</span>
    </>
  )
}

// ChangeTypeIcon marks a file's git change type next to its name (in the diff
// header and the sidebar file list): green [+] added, red [-] removed, cyan [→]
// renamed. Modified files (the common case) get no badge. The change type is
// conveyed by this coloured icon rather than by colouring the filename text.
export function ChangeTypeIcon({ type, className = 'w-3.5 h-3.5' }: { type: string; className?: string }) {
  const cls = `${className} shrink-0`
  switch (type) {
    case 'added':
      return <SquarePlus className={`${cls} text-green-600 dark:text-green-400`} />
    case 'deleted':
      return <SquareMinus className={`${cls} text-red-600 dark:text-red-400`} />
    case 'renamed':
      return <SquareArrowRight className={`${cls} text-cyan-600 dark:text-cyan-400`} />
    default:
      return null
  }
}

// How many extra lines each ⌄/⌃ expander reveals per click (the default context
// either side of a change is diffBody's CTX).
const EXPAND_STEP = 20

// Files with at least this many changed lines start hidden ("Load diff" button)
// and aren't auto-expanded in the full_context response (passed as
// max_full_changes), so a large diff doesn't ship every big file's full content.
const HIDDEN_FILE_THRESHOLD = 1000

// Files at or below this many lines are syntax-highlighted synchronously during
// render: tiny inputs are cheap, so highlighting inline avoids both a plain→
// coloured flash and the round-trip overhead of dispatching to a worker. Larger
// files (the ones that actually stack up into a long main-thread task when a
// multi-file diff renders) are highlighted off-thread in the Web Worker pool
// (`highlightClient`): they paint immediately as plain text and the colours
// stream in as each highlight completes. Highlighting always runs over the whole
// file either way, so multi-line constructs stay correct.
const HL_SYNC_MAX = 80

const EMPTY_HIGHLIGHT = {
  highlightedOld: new Map<number, string>(),
  highlightedNew: new Map<number, string>(),
}

interface SideLine { lineNum: number; content: string }

// extractSides splits a flat run of diff lines into the old-side and new-side
// line lists (number + content), preserving file order so the joined content
// highlights as a whole.
function extractSides(lines: DiffLine[]): { oldLines: SideLine[]; newLines: SideLine[] } {
  const oldLines: SideLine[] = []
  const newLines: SideLine[] = []
  for (const l of lines) {
    if ((l.type === 'context' || l.type === 'deletion') && l.old_line_num != null)
      oldLines.push({ lineNum: l.old_line_num, content: l.content })
    if ((l.type === 'context' || l.type === 'addition') && l.new_line_num != null)
      newLines.push({ lineNum: l.new_line_num, content: l.content })
  }
  return { oldLines, newLines }
}

// mapFromHtml zips a side's lines back together with the per-line highlighted
// HTML returned by the highlighter into a line-number → HTML map.
function mapFromHtml(ls: SideLine[], html: string[] | null): Map<number, string> {
  const map = new Map<number, string>()
  if (!html) return map
  ls.forEach((l, i) => { if (html[i] !== undefined) map.set(l.lineNum, html[i]) })
  return map
}

// buildHighlightMaps syntax-highlights a flat run of diff lines synchronously
// (so multi-line constructs - block comments, template strings - highlight
// correctly) and returns per-line-number → HTML maps for the old and new sides.
// Used only for the small-file fast path; larger files go through the worker.
function buildHighlightMaps(lines: DiffLine[], lang: string) {
  const { oldLines, newLines } = extractSides(lines)
  const highlight = (ls: SideLine[]): Map<number, string> =>
    mapFromHtml(ls, ls.length ? highlightLines(ls.map((l) => l.content).join('\n'), lang) : null)
  return { highlightedOld: highlight(oldLines), highlightedNew: highlight(newLines) }
}



// ── Lazy body mounting ────────────────────────────────────────────────────────
// A big diff used to mount every file's rows (and highlight them) in one render,
// blocking the main thread for seconds. Instead each file's body stays an empty
// placeholder until its card first scrolls near the viewport.
//
// The placeholder's height is *measured*, not guessed: bodyShape below describes
// exactly which lines and expander rows the body will render, and diffMetrics
// lays that text out once offscreen at the real width (see the note there for
// why the browser does the wrapping rather than us). Each file does this in an
// idle slice right after load, so by the time you scroll to a card its
// placeholder already holds the height its rows will take - the document stops
// growing under the scrollbar as you go. estimateVisibleRows is the crude
// stand-in used only for the frame or two before the measurement lands (and for
// in-tree images, whose height nothing can predict).

// Diff rows are one leading-5 (20px) line each (wrapped lines make a row taller,
// but this is only the pre-measurement stand-in).
const EST_ROW_H = 20
// How far beyond the viewport a body mounts, so scrolling at a normal pace hits
// already-rendered rows instead of placeholders.
const LAZY_MARGIN = '1000px 0px'

// nearestScrollParent walks up to the element's scroll container (the agent
// page's overflow-auto main pane). The IntersectionObserver's rootMargin must be
// measured against it: with the default viewport root, the container's clipping
// would cancel the pre-mount margin and bodies would only mount once actually
// visible.
function nearestScrollParent(el: HTMLElement): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if (overflowY === 'auto' || overflowY === 'scroll') return p
  }
  return null
}

// estimateVisibleRows approximates how many rows a file's body renders in its
// default state (no per-region reveals) without building anything: change runs
// count in full, each unchanged run contributes up to CTX context per adjacent
// change plus one expander row - mirroring buildSegments. Non-expanded files
// render their -U3 hunks as-is plus expander rows.
function estimateVisibleRows(file: DiffFile): number {
  const hunks = file.hunks ?? []
  if (hunks.length === 0) return 2
  if (!file.expanded) {
    let rows = hunks.length + 1 // expander rows between/around hunks
    for (const h of hunks) rows += h.lines.length
    return rows
  }
  const runs: { change: boolean; len: number }[] = []
  for (const h of hunks) {
    for (const l of h.lines) {
      const change = isChangeLine(l)
      const last = runs[runs.length - 1]
      if (last && last.change === change) last.len++
      else runs.push({ change, len: 1 })
    }
  }
  let rows = 0
  runs.forEach((run, ri) => {
    if (run.change) { rows += run.len; return }
    const top = Math.min(run.len, ri === 0 ? 0 : CTX)
    const bot = Math.min(run.len - top, ri === runs.length - 1 ? 0 : CTX)
    const hidden = run.len - top - bot
    rows += hidden <= MIN_COLLAPSE_GAP ? run.len : top + bot + 1
  })
  return rows
}


function GapCount({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex-1 text-center text-xs text-blue-400 dark:text-blue-500 font-mono py-0.5 hover:bg-blue-100/50 dark:hover:bg-blue-900/30 rounded cursor-pointer"
    >
      ···  {hidden} line{hidden !== 1 ? 's' : ''}  ···
    </button>
  )
}

// GapExpander sits between two changes. Both ⌄ (reveal more after the upper
// change) and ⌃ (reveal more before the lower change) live together on the left;
// the "··· N lines ···" label reveals the whole gap.
function GapExpander({ seg, onDown, onUp, onAll }: {
  seg: RenderSeg; onDown: () => void; onUp: () => void; onAll: () => void
}) {
  return (
    <div className={EXPANDER_ROW}>
      <div className="flex items-center gap-0.5 shrink-0 mr-1">
        <Tooltip side="top" content={`Expand down ${EXPAND_STEP} lines`}>
          <button onClick={onDown} className={EXPANDER_BTN}><ChevronDown className="w-3 h-3" /></button>
        </Tooltip>
        <Tooltip side="top" content={`Expand up ${EXPAND_STEP} lines`}>
          <button onClick={onUp} className={EXPANDER_BTN}><ChevronUp className="w-3 h-3" /></button>
        </Tooltip>
      </div>
      <GapCount hidden={seg.hidden!} onClick={onAll} />
    </div>
  )
}

// EdgeExpander reveals the file's hidden top (⌃, toward line 1) or bottom (⌄,
// toward EOF). It is only rendered while lines remain hidden, so it disappears
// once the file's first/last line is reached.
function EdgeExpander({ seg, onStep, onAll }: {
  seg: RenderSeg; onStep: () => void; onAll: () => void
}) {
  const up = seg.kind === 'topedge'
  return (
    <div className={EXPANDER_ROW}>
      <Tooltip side="top" content={`Expand ${up ? 'up' : 'down'} ${EXPAND_STEP} lines`}>
        <button onClick={onStep} className={`${EXPANDER_BTN} mr-1`}>
          {up ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </Tooltip>
      <GapCount hidden={seg.hidden!} onClick={onAll} />
    </div>
  )
}

// The sticky `top` shared by each file header and the file-list sidebar so they
// dock at the same Y, flush against the bottom of the Changes toolbar (which docks
// flush at the scroll-container top via -top-4). --sticky-changes-h is the toolbar's
// measured height (published on the panel root); the -16px cancels the scroll
// container's pt-4 so the header pins exactly at the toolbar's bottom edge. No gap:
// any gap here lets scrolling diff content peek through above the sticky header.
// --sticky-files-h is the sticky "Files" section header's height (also published on
// the panel root, 0 when there are no files): the file rows/headers dock just below
// it, the same way Tests/Artifacts cards dock below their section header via
// --sticky-section-h. Mirrors STICKY_CARD_TOP's approach.
export const FILE_STICKY_TOP = 'calc(var(--sticky-changes-h, 45px) - 16px + var(--sticky-files-h, 0px))'

// How long the file-body collapse/expand height glide runs - kept in JS so the
// deferred-unmount timer matches the CSS duration (mirrors CollapsibleCard's
// COLLAPSE_MS). See FileDiff's `bodyMounted`.
const FILE_COLLAPSE_MS = 200

export const FileDiff = memo(function FileDiff({ file, sideBySide, wordHighlight = true, fileRef, onComment, onAddToReview, isCollapsed, onToggleCollapse, onExpand, isHidden, onShow, currentContext, readOnly, headless, imageDiffMode, imageBefore, imageAfter, selection, onSelectLine, openInRepo }: {
  file: DiffFile
  sideBySide: boolean
  // Highlight the exact changed words within a modified line (on top of the
  // whole-row tint). Defaults on; the diff toolbar's settings cog toggles it.
  wordHighlight?: boolean
  fileRef?: (el: HTMLDivElement | null) => void
  onComment: (path: string, lineNum: number, isNew: boolean, text: string) => void
  // Optional "Add to review" (queue for batch submit). Omitted in the read-only
  // repo view, where the line-level comment affordances are hidden entirely.
  onAddToReview?: (path: string, lineNum: number, isNew: boolean, text: string) => void
  isCollapsed: boolean
  onToggleCollapse: (path: string) => void
  onExpand: (path: string, context: number) => void
  isHidden?: boolean
  onShow?: () => void
  currentContext: number
  // An in-tree image (binary) renders the artifacts panel's before/after image
  // differ instead of the "Binary file changed" placeholder. imageBefore/After
  // are the raw-blob URLs for each side (null when the file was added/deleted on
  // that side); imageDiffMode picks the comparison style (shared with artifacts).
  imageDiffMode?: ImageDiffMode
  imageBefore?: string | null
  imageAfter?: string | null
  // When true, the line-level "add comment" affordances are hidden - used by the
  // repository diff view, which has no agent to send comments to.
  readOnly?: boolean
  // When true, the per-file card chrome (border + collapsible header) is dropped
  // and the diff body is rendered bare and always-expanded - used by the
  // repository diff's one-file-at-a-time view, whose surrounding header already
  // carries the filename, change type, line counts and copy/raw actions.
  headless?: boolean
  // Optional controlled line selection. When onSelectLine is provided the
  // selection is driven from the parent (the repository compare-diff wires it to
  // the URL hash); otherwise FileDiff keeps a local per-file selection. `extend`
  // is the shift-click flag - the parent resolves the anchor.
  selection?: DiffLineSelection | null
  onSelectLine?: (side: DiffSide, line: number, extend: boolean) => void
  // Builds the "open in repository" <Link> target for this file at the agent's
  // branch. Omitted in the read-only repo view (no header) and whenever there's
  // no ref to browse, which hides the header button.
  openInRepo?: (path: string) => LinkProps
}) {
  const lang = getLanguage(file.path)

  const [reveal, setReveal] = useState<RevealMap>(new Map())

  // Lazy body mount: the body renders as a fixed-height placeholder until the
  // card first scrolls near the viewport (one-way latch - once mounted, a body
  // stays mounted so scrolling back up never re-does the work). The headless
  // one-file view renders immediately; so do environments without
  // IntersectionObserver (tests).
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [near, setNear] = useState(() => headless || typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (near) return
    const el = cardRef.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true)
        io.disconnect()
      }
    }, { root: nearestScrollParent(el), rootMargin: LAZY_MARGIN })
    io.observe(el)
    return () => io.disconnect()
  }, [near])

  // Collapse/expand glides the file body between 0 and its measured height - the
  // same height-tween the tests/artifacts CollapsibleCard uses, so the two feel
  // identical. The body stays mounted while open and for one collapse animation,
  // then unmounts so a collapsed file (and its highlighting) costs nothing -
  // hence the derived memos below key off `bodyMounted`, not the raw prop, so
  // their content stays put for the 200ms the glide plays. headless mode (the
  // repository one-file view) is always open and never animates.
  const [bodyRef, bodyH] = useMeasuredHeight(0)
  const [bodyMounted, setBodyMounted] = useState(!isCollapsed)
  useEffect(() => {
    // Mount on the next frame (not synchronously here) so the body first paints at
    // height 0 and the 0->height glide can play - deferring via rAF also keeps this
    // out of the synchronous effect body. Cancel it if we re-collapse before it fires.
    if (!isCollapsed) {
      const r = requestAnimationFrame(() => setBodyMounted(true))
      return () => cancelAnimationFrame(r)
    }
    const t = setTimeout(() => setBodyMounted(false), FILE_COLLAPSE_MS)
    return () => clearTimeout(t)
  }, [isCollapsed])
  // Open (fully expanded, height = content) vs. animating/closed. bodyMounted
  // stays true through the collapse tween; bodyOpen flips to false at once so the
  // height animates back to 0. On expand, bodyMounted is set in the effect above
  // (after a paint at height 0) so the 0→height glide can play.
  const bodyOpen = !isCollapsed && bodyMounted

  // Signature of the visible hunks. A background refresh hands us new file
  // objects even when nothing changed, so keying derived work on identity would
  // recompute on every refresh. The string signature is stable across no-op
  // refreshes, so we only recompute when content truly changes. Skipped (along
  // with everything derived from it) while the body is still a lazy placeholder.
  const hunksSig = useMemo(() => (near ? hashHunks(file.hunks) : ''), [file.hunks, near])

  // Whole-file content for the reveal/collapse model. The server returns each
  // eligible file's entire content in the main diff response (full_context) and
  // marks it `expanded`, so we derive the line list straight from the hunks -
  // no per-file round-trip. Files the server left at windowed context (too
  // large) aren't marked expanded and fall through to the `-U3` hunks + network
  // expand below. The size/contiguity checks are a defensive guard so a
  // malformed response can't drive the reveal model with non-whole-file lines.
  const fullLines = useMemo<DiffLine[] | null>(() => {
    if (file.binary || isHidden || !bodyMounted || !near || !file.expanded) return null
    const lines = file.hunks ? file.hunks.flatMap((h) => h.lines) : []
    if (lines.length === 0 || lines.length > FULL_MAX_LINES || !isContiguous(lines)) return null
    return lines
    // hunksSig stands in for file.hunks identity (stable across no-op refreshes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hunksSig, file.binary, file.expanded, isHidden, bodyMounted, near])

  // Lines to highlight: the whole file when expanded (so multi-line constructs
  // stay correct), else the visible `-U3` hunks. Null when nothing is rendered
  // (binary/collapsed/hidden) - highlighting an unseen body would be wasted work.
  const highlightSource = useMemo<DiffLine[] | null>(() => {
    if (file.binary || !bodyMounted || isHidden || !near) return null
    const lines = fullLines ?? (file.hunks ? file.hunks.flatMap((h) => h.lines) : [])
    return lines.length ? lines : null
    // hunksSig (not file.hunks identity) so an unchanged file isn't recomputed
    // when an unrelated file changes and the whole diff object is replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullLines, hunksSig, file.binary, bodyMounted, isHidden, near])

  // Small files highlight inline (no flash, no worker round-trip). Larger files
  // would block the main thread if every one highlighted during the same render,
  // so they paint as plain text and colourise from the Web Worker pool - the
  // hljs work runs fully off the UI thread. Whole-file input keeps the
  // highlighting correct regardless of which path runs.
  // Fetch a not-yet-bundled grammar on demand (the worker path does this itself);
  // langReady flips false→true once it lands, re-running the sync highlight below.
  const [, bumpGrammar] = useState(0)
  useEffect(() => {
    if (lang === 'plaintext' || hljs.getLanguage(lang)) return
    let cancelled = false
    ensureLanguage(lang).then((ok) => { if (ok && !cancelled) bumpGrammar((n) => n + 1) })
    return () => { cancelled = true }
  }, [lang])
  const langReady = lang === 'plaintext' || !!hljs.getLanguage(lang)
  const syncHighlight = useMemo(
    () => (highlightSource && highlightSource.length <= HL_SYNC_MAX
      ? buildHighlightMaps(highlightSource, langReady ? lang : 'plaintext')
      : null),
    [highlightSource, lang, langReady],
  )
  const [asyncHighlight, setAsyncHighlight] = useState(EMPTY_HIGHLIGHT)
  // When the async-highlighted content (or its language) changes, repaint as plain
  // text immediately DURING RENDER while the worker re-highlights - this avoids a
  // flash of stale highlighting and keeps the reset out of the synchronous effect
  // body. Tracked via prev-as-state compared by reference, so no large-string work
  // per render.
  const [prevHlSource, setPrevHlSource] = useState(highlightSource)
  const [prevHlLang, setPrevHlLang] = useState(lang)
  if (prevHlSource !== highlightSource || prevHlLang !== lang) {
    setPrevHlSource(highlightSource)
    setPrevHlLang(lang)
    if (highlightSource && highlightSource.length > HL_SYNC_MAX) setAsyncHighlight(EMPTY_HIGHLIGHT)
  }
  useEffect(() => {
    if (!highlightSource || highlightSource.length <= HL_SYNC_MAX) return
    let cancelled = false
    const { oldLines, newLines } = extractSides(highlightSource)
    highlightSides(
      lang,
      oldLines.length ? oldLines.map((l) => l.content).join('\n') : null,
      newLines.length ? newLines.map((l) => l.content).join('\n') : null,
    ).then((res) => {
      if (cancelled) return
      setAsyncHighlight({
        highlightedOld: mapFromHtml(oldLines, res.old),
        highlightedNew: mapFromHtml(newLines, res.new),
      })
    })
    return () => { cancelled = true }
  }, [highlightSource, lang])
  const { highlightedOld, highlightedNew } = syncHighlight ?? asyncHighlight

  // Word-diff ranges: for each changed line, the character sub-ranges that
  // actually differ from its paired line (so the viewer can tint just those
  // words). Computed from the same line list as the highlighting and keyed the
  // same way (old_line_num / new_line_num), memoised off hunksSig so a no-op
  // background refresh doesn't recompute it. Empty maps when the toggle is off.
  const { wordRangesOld, wordRangesNew } = useMemo(() => {
    if (!wordHighlight || !highlightSource) return { wordRangesOld: EMPTY_WORD_RANGES, wordRangesNew: EMPTY_WORD_RANGES }
    const maps = buildWordRangeMaps(highlightSource)
    return { wordRangesOld: maps.old, wordRangesNew: maps.new }
  }, [highlightSource, wordHighlight])

  // Placeholder height while the body is lazy-unmounted. Also used directly as
  // the tween wrapper's height during that phase: bodyH is 0 until the
  // ResizeObserver's first measurement, and if every card rendered at ~0 body
  // height for that first frame they would all cluster inside the observer's
  // pre-mount margin and defeat the laziness entirely.
  //
  // measuredBodyH is the real thing - diffMetrics lays the body's text out
  // offscreen at boxW (the width the rows will wrap at) and returns the exact
  // height, so the placeholder doesn't have to be corrected once the rows mount.
  // It runs in an idle slice, hence the row estimate as the interim value.
  const [boxRef, boxW] = useMeasuredWidth(0)
  const [measuredBodyH, setMeasuredBodyH] = useState<number | null>(null)
  useEffect(() => {
    if (near || headless || boxW <= 0) return
    return queueMeasure(() => {
      const shape = bodyShape(file, sideBySide, !!isHidden, currentContext)
      setMeasuredBodyH(shape && measureBodyHeight(boxW, shape))
    })
  }, [near, headless, boxW, file, sideBySide, isHidden, currentContext])
  const estBodyH = useMemo(
    () => (near ? 0 : measuredBodyH ?? (isHidden || file.binary ? 100 : estimateVisibleRows(file) * EST_ROW_H)),
    [near, measuredBodyH, isHidden, file],
  )

  // A file with whole-file content but no additions/deletions (e.g. a pure
  // rename) has nothing to collapse - render its lines plainly rather than
  // folding the entire body behind one expander.
  const noChanges = file.additions === 0 && file.deletions === 0
  const segments = useMemo(() => (fullLines && !noChanges ? buildSegments(fullLines, reveal) : null), [fullLines, reveal, noChanges])

  const setRegion = useCallback((id: string, patch: { top?: number; bot?: number }) => {
    setReveal((prev) => {
      const next = new Map(prev)
      next.set(id, { ...(next.get(id) ?? {}), ...patch })
      return next
    })
  }, [])

  const expand = (newCtx: number) => onExpand(file.path, newCtx)

  const synthHunk = (lines: DiffLine[]): DiffHunk => ({ header: '', old_start: 0, new_start: 0, lines })

  // Per-file line selection driven by clicking gutter numbers. A plain click
  // selects one line (and becomes the shift-anchor); shift+click extends the
  // range from the anchor along the same side. Uncontrolled by default (local
  // state); the repository compare-diff drives it from the URL via the
  // controlled selection/onSelectLine props - see the note by DiffLineSelection.
  const [localSel, setLocalSel] = useState<DiffLineSelection | null>(null)
  const selAnchorRef = useRef<{ side: DiffSide; line: number } | null>(null)
  const localSelectLine = useCallback((side: DiffSide, line: number, extend: boolean) => {
    setLocalSel((prev) => {
      if (extend && prev && prev.side === side) {
        const anchor = selAnchorRef.current?.side === side ? selAnchorRef.current.line : prev.start
        return { side, start: Math.min(anchor, line), end: Math.max(anchor, line) }
      }
      selAnchorRef.current = { side, line }
      return { side, start: line, end: line }
    })
  }, [])
  const controlled = onSelectLine != null
  const lineSel = controlled ? (selection ?? null) : localSel
  const selectLine = controlled ? onSelectLine : localSelectLine

  // Stable per-file comment handler. Passed to the memo'd hunks below - an inline
  // arrow here would mint a new identity every render, defeating UnifiedHunk /
  // SideBySideHunk's memo so EVERY line re-rendered whenever this FileDiff did
  // (e.g. an unrelated live-tick re-render of the diff subtree). Binding file.path
  // once keeps the hunks' props stable so unchanged lines skip the render.
  const onCommentForFile = useCallback(
    (ln: number, isNew: boolean, txt: string) => onComment(file.path, ln, isNew, txt),
    [onComment, file.path],
  )
  const onAddToReviewForFile = useCallback(
    (ln: number, isNew: boolean, txt: string) => onAddToReview?.(file.path, ln, isNew, txt),
    [onAddToReview, file.path],
  )
  // Only wire the queue callback into hunks when the parent provided one, so the
  // read-only repo view keeps no "Add to review" button at all.
  const addToReviewForHunk = onAddToReview ? onAddToReviewForFile : undefined

  const renderLines = (lines: DiffLine[], key: string) => (
    sideBySide
      ? <SideBySideHunk key={key} hunk={synthHunk(lines)} highlightedOld={highlightedOld} highlightedNew={highlightedNew}
        wordRangesOld={wordRangesOld} wordRangesNew={wordRangesNew}
        onComment={onCommentForFile} onAddToReview={addToReviewForHunk} readOnly={readOnly} selection={lineSel} onSelectLine={selectLine} />
      : <UnifiedHunk key={key} hunk={synthHunk(lines)} highlightedOld={highlightedOld} highlightedNew={highlightedNew}
        wordRangesOld={wordRangesOld} wordRangesNew={wordRangesNew}
        onComment={onCommentForFile} onAddToReview={addToReviewForHunk} readOnly={readOnly} selection={lineSel} onSelectLine={selectLine} />
  )

  // Collapsing a file whose top has scrolled above the viewport would leave
  // the scroll at a random depth of the files below - pin the (now short)
  // card to the top instead, docked under the sticky chrome (see pinCardToTop
  // for why it's a pin, not a one-shot scroll).
  const toggleCollapse = () => {
    if (!isCollapsed && cardRef.current) pinCardToTop(cardRef.current)
    onToggleCollapse(file.path)
  }

  return (
    <div
      ref={(el) => { cardRef.current = el; fileRef?.(el) }}
      data-file-card={file.path}
      // Dock target for jump-to-file. FILE_STICKY_TOP subtracts 16px (the scroll
      // container's pt-4) so the header PINS flush at the bar bottom while
      // reading; that same -16 must be added back here or the card lands 16px
      // too high and the pinned header floats down over the first content line
      // (scrolls "too far"). +16 lands the card border exactly at the sticky
      // bar stack's bottom edge, so the header sits flush and line 1 is visible.
      style={headless ? undefined : { scrollMarginTop: `calc(${FILE_STICKY_TOP} + 16px)` }}
      className={headless ? '' : 'border border-gray-200 dark:border-gray-700 rounded-lg mb-4 bg-white dark:bg-gray-900 shadow-sm'}
    >
      {!headless && (
      // Sticky header: pins flush below the Changes toolbar (FILE_STICKY_TOP, the
      // same Y as the file-list sidebar) while the file's diff scrolls under it,
      // releasing when the card ends. The root drops its overflow-hidden (which
      // would trap this sticky header inside the card); the header carries its own
      // overflow-hidden + rounded-t-lg instead, plus rounded-b-lg while collapsed.
      <div
        style={{ top: FILE_STICKY_TOP }}
        className={`flex items-center gap-2 px-3 py-1.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 sticky z-20 overflow-hidden rounded-t-lg ${isCollapsed ? 'rounded-b-lg' : ''} cursor-pointer`}
        onClick={toggleCollapse}
      >
        {/* No onClick of its own: the header div handles the toggle, and a
            second handler here would fire too (bubbling) and toggle right
            back - the chevron was a no-op because of exactly that. */}
        <button
          aria-label={isCollapsed ? 'Expand file' : 'Collapse file'}
          className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 cursor-pointer transition-colors"
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
        </button>
        {(() => { const { Icon, className } = getFileIcon(file.path.split('/').pop() ?? file.path); return <Icon className={`w-3.5 h-3.5 shrink-0 ${className}`} /> })()}
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {/* The file-header path reads as sans (item 2); the diff body stays mono. */}
          <span className="text-xs min-w-0 truncate cursor-pointer hover:underline">
            {file.change_type === 'renamed' && file.old_path ? (
              <>
                <PathName path={file.old_path} />
                <span className="text-gray-400 dark:text-gray-500"> → </span>
                <PathName path={file.path} />
              </>
            ) : (
              <PathName path={file.path} />
            )}
          </span>
          <ChangeTypeIcon type={file.change_type} />
        </div>
        <CopyButton text={file.path} />
        {/* A deleted file no longer exists at the branch tip, so a repo-view link
            would 404 - hide it there; every other change type opens fine. */}
        {openInRepo && file.change_type !== 'deleted' && <RepoOpenButton target={openInRepo(file.path)} />}
        {!file.binary && (
          <div className="flex items-center gap-1.5 shrink-0 ml-1">
            {file.additions > 0 && <span className="text-xs text-green-600 dark:text-green-400 font-medium">+{file.additions}</span>}
            {file.deletions > 0 && <span className="text-xs text-red-600 dark:text-red-400 font-medium">-{file.deletions}</span>}
          </div>
        )}
      </div>
      )}
      {/* Body. rounded-b-lg + overflow-hidden clip the edge-to-edge diff content's
          bottom corners (the root dropped its overflow-hidden so the header can be
          sticky). For the stacked view the wrapper also height-tweens the body on
          collapse/expand - the inner measured div carries bodyRef; see
          bodyOpen/bodyMounted. headless (the repo one-file view) is bare, always
          open, and never animates. */}
      <div
        // Also the width reference for the offscreen body measurement above: its
        // clientWidth is exactly the width the rows inside it wrap at.
        ref={boxRef}
        // `isolate` keeps this body's positioned content (an in-tree image renders
        // as `absolute inset-0` via ImageDiffView) in its own stacking context so
        // it can't paint over the sticky file/section/changes bars above it - see
        // the matching note in CollapsibleCard.
        className={headless ? 'isolate' : 'isolate overflow-hidden rounded-b-lg transition-[height] duration-200 ease-out motion-reduce:transition-none'}
        style={headless ? undefined : { height: !bodyOpen ? 0 : near ? bodyH : estBodyH }}
        aria-hidden={headless ? undefined : !bodyOpen}
      >
        {(headless || bodyMounted) && (
        <div ref={headless ? undefined : bodyRef}>
          {!near ? (
            // Placeholder while the card is still far off-screen: hold roughly
            // the height the rows will take so the scrollbar and jump-to-file
            // targets stay stable, without paying for any row or highlight work.
            <div data-lazy-placeholder style={{ height: estBodyH }} />
          ) : file.binary && isImagePath(file.path) ? (
            // In-tree image: reuse the artifacts panel's before/after differ.
            <div className="p-3">
              <ImageDiffView left={imageBefore} right={imageAfter} mode={imageDiffMode ?? 'ab'} name={file.path} />
            </div>
          ) : file.binary ? (
            <div className={NOTICE_BLOCK}>Binary file changed</div>
          ) : isHidden ? (
            <div className={HIDDEN_BLOCK}>
              <div className="text-sm mb-2">{file.additions + file.deletions} lines changed</div>
              <button
                onClick={onShow}
                className="px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md hover:bg-blue-100 dark:hover:bg-blue-900/40 cursor-pointer transition-colors"
              >
                Load diff
              </button>
            </div>
          ) : noChanges ? (
            // A whole, unchanged file (e.g. a pure rename). The one-by-one view
            // (headless) shows it in full like the file viewer; the stacked view
            // collapses it to a label so a rename doesn't dump the file inline.
            headless && fullLines
              ? <div className="overflow-hidden">{renderLines(fullLines, 'full')}</div>
              : <div className={NOTICE_BLOCK}>No changes</div>
          ) : !file.hunks || file.hunks.length === 0 ? (
            <div className={NOTICE_BLOCK}>No changes</div>
          ) : segments ? (
            // Full-file model: every expander reveals already-fetched lines
            // client-side (no network), per-region, with whole-file highlighting.
            <div className="overflow-hidden">
              {segments.map((seg) => {
                if (seg.kind === 'lines') return renderLines(seg.lines!, seg.key)
                if (seg.kind === 'gap') return (
                  <GapExpander key={seg.key} seg={seg}
                    onDown={() => setRegion(seg.regionId!, { top: seg.top! + EXPAND_STEP })}
                    onUp={() => setRegion(seg.regionId!, { bot: seg.bot! + EXPAND_STEP })}
                    onAll={() => setRegion(seg.regionId!, { top: seg.length! })} />
                )
                return (
                  <EdgeExpander key={seg.key} seg={seg}
                    onStep={() => setRegion(seg.regionId!, seg.kind === 'topedge'
                      ? { bot: seg.bot! + EXPAND_STEP } : { top: seg.top! + EXPAND_STEP })}
                    onAll={() => setRegion(seg.regionId!, seg.kind === 'topedge'
                      ? { bot: seg.length! } : { top: seg.length! })} />
                )
              })}
            </div>
          ) : (
            // Fallback for very large files: keep the `-U3` hunks and widen the
            // whole-file context over the network on expand.
            <div className="overflow-hidden">
              {file.hunks.map((hunk, i) => {
                const isFirst = i === 0
                const isLast = i === file.hunks.length - 1
                const prevHunk = isFirst ? null : file.hunks[i - 1]
                const gapSize = prevHunk ? computeGap(prevHunk, hunk) : 0
                const atTopOfFile = isFirst && hunk.new_start <= 1 && hunk.old_start <= 1
                const atEndOfFile = isLast && trailingContext(hunk) < currentContext
                return (
                  <Fragment key={hunk.header}>
                    {isFirst && !atTopOfFile && (
                      <div className={EXPANDER_ROW}>
                        <Tooltip side="top" content={`Expand up ${EXPAND_STEP} lines`}>
                          <button onClick={() => expand(currentContext + EXPAND_STEP)} className={`${EXPANDER_BTN} mr-1`}>
                            <ChevronUp className="w-3 h-3" />
                          </button>
                        </Tooltip>
                      </div>
                    )}
                    {!isFirst && gapSize > 0 && (
                      <div className={EXPANDER_ROW}>
                        <div className="flex items-center gap-0.5 shrink-0 mr-1">
                          <Tooltip side="top" content={`Expand down ${EXPAND_STEP} lines`}>
                            <button onClick={() => expand(currentContext + EXPAND_STEP)} className={EXPANDER_BTN}>
                              <ChevronDown className="w-3 h-3" />
                            </button>
                          </Tooltip>
                          <Tooltip side="top" content={`Expand up ${EXPAND_STEP} lines`}>
                            <button onClick={() => expand(currentContext + EXPAND_STEP)} className={EXPANDER_BTN}>
                              <ChevronUp className="w-3 h-3" />
                            </button>
                          </Tooltip>
                        </div>
                        <GapCount hidden={gapSize} onClick={() => expand(currentContext + Math.max(gapSize, EXPAND_STEP))} />
                      </div>
                    )}
                    {sideBySide
                      ? <SideBySideHunk hunk={hunk} highlightedOld={highlightedOld} highlightedNew={highlightedNew}
                        wordRangesOld={wordRangesOld} wordRangesNew={wordRangesNew}
                        onComment={onCommentForFile} onAddToReview={addToReviewForHunk} readOnly={readOnly} selection={lineSel} onSelectLine={selectLine} />
                      : <UnifiedHunk hunk={hunk} highlightedOld={highlightedOld} highlightedNew={highlightedNew}
                        wordRangesOld={wordRangesOld} wordRangesNew={wordRangesNew}
                        onComment={onCommentForFile} onAddToReview={addToReviewForHunk} readOnly={readOnly} selection={lineSel} onSelectLine={selectLine} />
                    }
                    {isLast && !atEndOfFile && (
                      <div className={EXPANDER_ROW}>
                        <Tooltip side="top" content={`Expand down ${EXPAND_STEP} lines`}>
                          <button onClick={() => expand(currentContext + EXPAND_STEP)} className={`${EXPANDER_BTN} mr-1`}>
                            <ChevronDown className="w-3 h-3" />
                          </button>
                        </Tooltip>
                      </div>
                    )}
                  </Fragment>
                )
              })}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  )
})

// ── Commit selector types & helpers ───────────────────────────────────────────

type LeftSel = { type: 'base' } | { type: 'latest' } | { type: 'commit'; sha: string }
type RightSel = { type: 'uncommitted' } | { type: 'latest' } | { type: 'commit'; sha: string }

function commitIdx(sha: string, commits: CommitInfo[]): number {
  return commits.findIndex((c) => c.sha === sha)
}

type DiffParams = { baseRef?: string; headRef?: string; ignoreWhitespace?: boolean; includeUncommitted?: boolean }

// buildDiffParams maps the left/right selectors to the getAgentDiff query
// params. Shared by every diff fetch (initial load, silent refresh, per-file
// full fetch, context expansion) so they stay in lock-step.
function buildDiffParams(leftSel: LeftSel, rightSel: RightSel, ignoreWhitespace: boolean, commits: CommitInfo[]): DiffParams {
  const params: DiffParams = {}
  if (ignoreWhitespace) params.ignoreWhitespace = true
  if (leftSel.type === 'commit') params.baseRef = leftSel.sha
  else if (leftSel.type === 'latest' && commits.length > 0) params.baseRef = commits[0].sha
  if (rightSel.type === 'uncommitted') params.includeUncommitted = true
  else if (rightSel.type === 'commit') params.headRef = rightSel.sha
  return params
}

// ── Diff-comment context (shared by "Send" and "Add to review") ───────────────

// Human labels for the two sides of the current comparison, embedded in a comment
// so the agent knows which diff it was written against. Commit selectors resolve
// to a concrete short sha here (not just "latest"), so a queued comment still
// names the right commit even after new work lands.
function resolveDiffLabels(
  leftSel: LeftSel,
  rightSel: RightSel,
  commits: CommitInfo[],
  baseBranch: string,
): { fromLabel: string; toLabel: string } {
  const fromLabel = leftSel.type === 'base'
    ? baseBranch
    : leftSel.type === 'latest'
      ? (commits[0]?.short_sha ? `HEAD (${commits[0].short_sha})` : 'HEAD')
      : (commits.find((c) => c.sha === leftSel.sha)?.short_sha ?? leftSel.sha.slice(0, 8))
  const toLabel = rightSel.type === 'latest' ? 'latest commit'
    : rightSel.type === 'uncommitted' ? 'uncommitted changes'
      : (commits.find((c) => c.sha === rightSel.sha)?.short_sha ?? rightSel.sha.slice(0, 8))
  return { fromLabel, toLabel }
}

// Find the hunk in a file that contains the given line (on the new or old side).
function findHunkForLine(file: DiffFile | undefined, lineNum: number, isNew: boolean): DiffHunk | undefined {
  return file?.hunks?.find((h) =>
    h.lines.some((l) => (isNew ? l.new_line_num === lineNum : l.old_line_num === lineNum)),
  )
}

// Build the fenced ```diff context block for a commented line: three lines either
// side. Each row is `<sign> | <old line> | <new line> | <code>` (line numbers
// padded to align within the window), and the commented line is followed by a
// `# ^ Comment by user` caret so the agent can see exactly which line is meant.
// Returns '' when the hunk/line can't be located.
function diffContextBlock(path: string, hunk: DiffHunk | undefined, lineNum: number, isNew: boolean): string {
  if (!hunk) return ''
  const targetIdx = hunk.lines.findIndex((l) => (isNew ? l.new_line_num === lineNum : l.old_line_num === lineNum))
  if (targetIdx < 0) return ''
  const start = Math.max(0, targetIdx - 3)
  const end = Math.min(hunk.lines.length, targetIdx + 4)
  const ctxLines = hunk.lines.slice(start, end)
  const oldStr = (l: DiffLine) => (l.old_line_num != null ? String(l.old_line_num) : '')
  const newStr = (l: DiffLine) => (l.new_line_num != null ? String(l.new_line_num) : '')
  const wOld = Math.max(1, ...ctxLines.map((l) => oldStr(l).length))
  const wNew = Math.max(1, ...ctxLines.map((l) => newStr(l).length))
  const rows: string[] = []
  ctxLines.forEach((l, i) => {
    const sign = l.type === 'addition' ? '+' : l.type === 'deletion' ? '-' : ' '
    rows.push(`${sign} | ${oldStr(l).padStart(wOld)} | ${newStr(l).padStart(wNew)} | ${l.content}`)
    if (start + i === targetIdx) rows.push('# ^ Comment by user')
  })
  return `\`\`\`diff\n# ${path}\n${hunk.header}\n${rows.join('\n')}\n\`\`\`\n`
}

function formatShortLabel(commit: CommitInfo | null | undefined, sha: string): string {
  if (!commit) return sha.slice(0, 7)
  const msg = commit.message.slice(0, 24)
  return `${commit.short_sha} ${msg}${commit.message.length > 24 ? '...' : ''}`
}

// ── Commit info formatting ────────────────────────────────────────────────────

function formatCommitDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

// ── Custom tooltip ────────────────────────────────────────────────────────────

// Only one CustomTooltip is ever visible at a time. Showing a tooltip
// immediately dismisses whichever was previously active, so scrolling the
// pointer across many triggers (e.g. the commit list) can't leave a trail of
// stale, lingering boxes behind.
let activeTooltip: { id: object; hide: () => void } | null = null

function CustomTooltip({ content, children, side = 'bottom', className = 'w-full' }: {
  content: React.ReactNode
  children: React.ReactNode
  side?: 'bottom' | 'right' | 'top' | 'left'
  className?: string
}) {
  const [visible, setVisible] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A stable per-instance identity for the "which tooltip is active" singleton, so
  // hideNow can tell if it still owns the slot without referencing itself.
  const id = useMemo(() => ({}), [])

  const cancelHide = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }, [])

  const hideNow = useCallback(() => {
    cancelHide()
    setVisible(false)
    if (activeTooltip?.id === id) activeTooltip = null
  }, [cancelHide, id])

  const show = useCallback(() => {
    cancelHide()
    // Dismiss any other tooltip before we claim the active slot.
    if (activeTooltip && activeTooltip.id !== id) activeTooltip.hide()
    activeTooltip = { id, hide: hideNow }
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      if (side === 'right') {
        setPos({ top: rect.top, left: rect.right })
      } else if (side === 'left') {
        setPos({ top: rect.top, left: rect.left })
      } else if (side === 'top') {
        setPos({ top: rect.top - 8, left: rect.left })
      } else {
        setPos({ top: rect.bottom + 6, left: rect.left })
      }
    }
    setVisible(true)
  }, [side, cancelHide, hideNow, id])

  // Hide after a short grace period so the pointer can travel from the trigger
  // into the tooltip (and back) without it disappearing.
  const scheduleHide = useCallback(() => {
    cancelHide()
    hideTimer.current = setTimeout(hideNow, 150)
  }, [cancelHide, hideNow])

  // The position is captured once on show, so it goes stale the moment the
  // page scrolls. Dismiss on scroll rather than leave a detached box floating.
  useEffect(() => {
    if (!visible) return
    const onScroll = () => hideNow()
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [visible, hideNow])

  useEffect(() => () => hideNow(), [hideNow])

  return (
    <div ref={ref} className={`relative inline-flex ${className}`} onMouseEnter={show} onMouseLeave={scheduleHide}>
      {children}
      {visible && pos && (
        <div
          className="fixed z-[200] bg-gray-900 dark:bg-gray-700 text-white text-xs rounded-lg px-3 py-2 shadow-xl"
          style={{
            top: pos.top,
            left: pos.left,
            transform: side === 'left' ? 'translateX(-100%)' : side === 'top' ? 'translateY(-100%)' : undefined
          }}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        >
          {content}
        </div>
      )}
    </div>
  )
}

function CommitTooltipContent({ commit }: { commit: CommitInfo }) {
  return (
    <div className="font-mono space-y-0.5 min-w-[260px] max-w-[80ch]">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-yellow-400">commit</span>
        <span className="text-gray-300 break-all">{commit.sha}</span>
      </div>
      <div><span className="text-gray-400 w-14 inline-block">Author:</span><span className="text-gray-200">{commit.author_name} &lt;{commit.author_email}&gt;</span></div>
      <div><span className="text-gray-400 w-14 inline-block">Date:</span><span className="text-gray-200">{formatCommitDate(commit.timestamp)}</span></div>
      <div className="mt-2 pt-2 border-t border-gray-700 text-gray-100 whitespace-pre-wrap break-words leading-relaxed">
        {commit.message}
      </div>
    </div>
  )
}

// ── Left commit selector ──────────────────────────────────────────────────────

// memo (both selectors): they sit in the always-visible Changes toolbar, whose
// owner re-renders on every diff/panel state change; their props only change
// when the commit list or the selection itself does.
const LeftSelector = memo(function LeftSelector({ commits, selected, onChange, baseBranch, rightSel }: {
  commits: CommitInfo[]
  selected: LeftSel
  onChange: (v: LeftSel) => void
  baseBranch: string
  rightSel: RightSel
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const label = selected.type === 'base'
    ? baseBranch
    : selected.type === 'latest'
      ? 'Latest commit'
      : formatShortLabel(commits.find((c) => c.sha === selected.sha), selected.sha)

  // Determine which commits are valid for the left selector (must be older than right)
  const rightIdx = rightSel.type === 'commit' ? commitIdx(rightSel.sha, commits) : -1
  const latestValid = rightSel.type === 'uncommitted'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors cursor-pointer"
      >
        <Calendar className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        <span className="max-w-[150px] truncate">{label}</span>
        <ChevronDown className="w-3 h-3 text-gray-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 overflow-hidden">
          {/* Latest commit at top */}
          {commits.length > 0 && (
            <div className="py-1 border-b border-gray-100 dark:border-gray-700">
              <button
                onClick={() => { if (latestValid) { onChange({ type: 'latest' }); setOpen(false) } }}
                disabled={!latestValid}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${selected.type === 'latest' ? 'bg-blue-50 dark:bg-blue-900/20' : latestValid ? 'hover:bg-gray-50 dark:hover:bg-gray-700' : ''}`}
              >
                <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                <span className="font-medium text-gray-800 dark:text-gray-200">Latest commit</span>
                <span className="text-gray-400 dark:text-gray-500 ml-auto text-[10px]">HEAD</span>
                {selected.type === 'latest' && <Check className="w-3 h-3 text-blue-500 shrink-0" />}
              </button>
            </div>
          )}
          {/* Commits in the middle */}
          {commits.length > 0 && (
            <div className="max-h-64 overflow-y-auto py-1">
              <p className="px-3 py-1 text-[11px] text-gray-400 dark:text-gray-500 font-medium">
                Commits · {commits.length}
              </p>
              {commits.map((c, cIdx) => {
                // Commit is valid if right is not a specific commit, or right commit is newer (lower idx)
                const commitValid = rightSel.type === 'uncommitted' || rightSel.type === 'latest'
                  || (rightIdx !== -1 && cIdx > rightIdx)
                return (
                  <CustomTooltip key={c.sha} side="right" content={<CommitTooltipContent commit={c} />}>
                    <button
                      onClick={() => { if (commitValid) { onChange({ type: 'commit', sha: c.sha }); setOpen(false) } }}
                      disabled={!commitValid}
                      className={`w-full flex items-start gap-2 px-3 py-1.5 text-left transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${selected.type === 'commit' && selected.sha === c.sha ? 'bg-blue-50 dark:bg-blue-900/20' : commitValid ? 'hover:bg-gray-50 dark:hover:bg-gray-700' : ''}`}
                    >
                      <span className="font-mono text-[10px] text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded shrink-0 mt-0.5">
                        {c.short_sha}
                      </span>
                      <span className="text-xs text-gray-700 dark:text-gray-300 leading-tight truncate">{c.message}</span>
                      {selected.type === 'commit' && selected.sha === c.sha && <Check className="w-3 h-3 text-blue-500 shrink-0 mt-0.5" />}
                    </button>
                  </CustomTooltip>
                )
              })}
            </div>
          )}
          {/* Base branch at the bottom */}
          <div className="py-1 border-t border-gray-100 dark:border-gray-700">
            <button
              onClick={() => { onChange({ type: 'base' }); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer ${selected.type === 'base' ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
            >
              <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              <span className="font-medium text-gray-800 dark:text-gray-200">{baseBranch}</span>
              <span className="text-gray-400 dark:text-gray-500 ml-auto text-[10px]">branch point</span>
              {selected.type === 'base' && <Check className="w-3 h-3 text-blue-500 shrink-0" />}
            </button>
          </div>
        </div>
      )}
    </div>
  )
})

// ── Right commit selector ─────────────────────────────────────────────────────

const RightSelector = memo(function RightSelector({ commits, selected, onChange, left, hasUncommitted }: {
  commits: CommitInfo[]
  selected: RightSel
  onChange: (v: RightSel) => void
  left: LeftSel
  hasUncommitted?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const label = selected.type === 'uncommitted' ? 'Latest changes'
    : selected.type === 'latest' ? 'Latest commit'
      : formatShortLabel(commits.find((c) => c.sha === selected.sha), selected.sha)

  const validCommits = commits.filter((_, idx) => {
    if (left.type === 'base') return true
    if (left.type === 'latest') return false // all commits are before 'latest'
    const li = commitIdx(left.sha, commits)
    return li === -1 || idx < li
  })
  const latestCommitValid = left.type !== 'latest'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors cursor-pointer"
      >
        <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        <span className="max-w-[150px] truncate">{label}</span>
        {hasUncommitted && selected.type !== 'uncommitted' && (
          <TriangleAlert className="w-3.5 h-3.5 text-amber-500 shrink-0" />
        )}
        <ChevronDown className="w-3 h-3 text-gray-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 overflow-hidden">
          <div className="py-1 border-b border-gray-100 dark:border-gray-700">
            <button
              onClick={() => { onChange({ type: 'uncommitted' }); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer ${selected.type === 'uncommitted' ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                }`}
            >
              <Plus className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              <span className="font-medium text-gray-800 dark:text-gray-200">Latest changes</span>
              <span className="text-gray-400 dark:text-gray-500 ml-auto text-[10px]">incl. uncommitted</span>
              {selected.type === 'uncommitted' && <Check className="w-3 h-3 text-blue-500 shrink-0" />}
            </button>
            <button
              onClick={() => { if (latestCommitValid) { onChange({ type: 'latest' }); setOpen(false) } }}
              disabled={!latestCommitValid}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${selected.type === 'latest' ? 'bg-blue-50 dark:bg-blue-900/20' : latestCommitValid ? 'hover:bg-gray-50 dark:hover:bg-gray-700' : ''}`}
            >
              <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              <span className="font-medium text-gray-800 dark:text-gray-200">Latest commit</span>
              <span className="text-gray-400 dark:text-gray-500 ml-auto text-[10px]">HEAD</span>
              {selected.type === 'latest' && <Check className="w-3 h-3 text-blue-500 shrink-0" />}
            </button>
          </div>
          {validCommits.length > 0 && (
            <div className="max-h-64 overflow-y-auto py-1">
              <p className="px-3 py-1 text-[11px] text-gray-400 dark:text-gray-500 font-medium">
                Commits · {validCommits.length}
              </p>
              {validCommits.map((c) => (
                <CustomTooltip key={c.sha} side="right" content={<CommitTooltipContent commit={c} />}>
                  <button
                    onClick={() => { onChange({ type: 'commit', sha: c.sha }); setOpen(false) }}
                    className={`w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer ${selected.type === 'commit' && selected.sha === c.sha ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                      }`}
                  >
                    <span className="font-mono text-[10px] text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded shrink-0 mt-0.5">
                      {c.short_sha}
                    </span>
                    <span className="text-xs text-gray-700 dark:text-gray-300 leading-tight truncate">{c.message}</span>
                    {selected.type === 'commit' && selected.sha === c.sha && <Check className="w-3 h-3 text-blue-500 shrink-0 mt-0.5" />}
                  </button>
                </CustomTooltip>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// ── Uncommitted changes button ────────────────────────────────────────────────

function UncommittedButton({ diff, onJumpToUncommitted }: {
  diff: DiffResponse | null
  onJumpToUncommitted: () => void
}) {
  const summary = diff?.uncommitted_summary
  if (!summary || (summary.tracked_count === 0 && summary.untracked_count === 0)) return null

  const lines: string[] = []
  if (summary.tracked_count > 0) lines.push(`${summary.tracked_count} tracked file${summary.tracked_count !== 1 ? 's' : ''} modified`)
  if (summary.untracked_count > 0) lines.push(`${summary.untracked_count} untracked file${summary.untracked_count !== 1 ? 's' : ''}`)

  return (
    <Tooltip className="shrink-0" content={
      <div>
        <p className="font-semibold mb-1">Uncommitted changes</p>
        {lines.map((l) => <p key={l} className="text-gray-300">{l}</p>)}
        <p className="text-gray-400 mt-1 text-[10px]">Click to view uncommitted changes</p>
      </div>
    }>
      <button
        onClick={onJumpToUncommitted}
        className="flex items-center gap-1 h-7 px-2 rounded-md text-xs font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors cursor-pointer"
      >
        <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
        <span>{summary.tracked_count + summary.untracked_count}</span>
      </button>
    </Tooltip>
  )
}

// ── Merge conflict panel ──────────────────────────────────────────────────────

function MergeConflictButton({ diff, agent, projectId }: {
  diff: DiffResponse | null
  agent: AgentResponse
  projectId: string | null
}) {
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)

  const baseBranch = agent.base_branch

  const handleFixWithAgent = useCallback(async () => {
    setSending(true)
    const res = await runWithToast(
      () => api.default.sendAgentInput(projectId ?? '', agent.id, { text: `Fix the merge conflicts by merging the local ${baseBranch} branch into this one (do not git fetch first), resolving the conflicts that arise.` }),
      { errorPrefix: 'Failed to send fix request to agent' },
    )
    setSending(false)
    // Keep the panel open on failure so the user can retry; the toast explains why.
    if (res.ok) setOpen(false)
  }, [projectId, agent.id, baseBranch])

  // Escape closes the panel; Enter confirms (Fix with agent), mirroring the
  // footer buttons. The keyboard path bypasses the button's disabled attribute,
  // so guard against a double-send while one is already in flight.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
      else if (e.key === 'Enter' && !sending) {
        e.preventDefault()
        void handleFixWithAgent()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, sending, handleFixWithAgent])

  if (!diff?.merge_conflict) return null

  const conflictFiles = diff.conflict_files ?? []
  const n = conflictFiles.length
  const count = n || '?'
  const plural = n !== 1
  const worktreePath = agent.worktree_path ?? '<worktree-path>'

  return (
    <>
      <div className="relative">
        <Tooltip className="shrink-0" content={
          <div>
            <p className="font-semibold mb-1">Merge Conflict</p>
            <p className="text-gray-300">{count} file{count !== 1 ? 's' : ''} conflict with <span className="font-mono">{baseBranch}</span></p>
            <p className="text-gray-400 mt-1 text-[10px]">Click for resolution instructions</p>
          </div>
        }>
          <button
            onClick={() => setOpen(true)}
            className="flex items-center gap-1 h-7 px-2 rounded-md text-xs font-medium text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors cursor-pointer"
          >
            <GitMergeConflict className="w-3.5 h-3.5 shrink-0" />
            <span>{count} conflict{plural ? 's' : ''}</span>
          </button>
        </Tooltip>

        {open && (
          <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            {/* Backdrop */}
            <div className="absolute inset-0" onClick={() => setOpen(false)} />

            {/* Panel - mirrors the merge/kill RichConfirmPanel: icon tile + stacked
                title/description, section labels, shared footer buttons. */}
            <div
              className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-[560px] overflow-hidden animate-in zoom-in-95 duration-200"
              role="dialog"
              aria-modal="true"
            >
              {/* Header */}
              <div className="flex items-start gap-3.5 px-5 pt-5 pb-4">
                <DialogIconTile tone="red">
                  <GitMergeConflict className="w-5 h-5" />
                </DialogIconTile>
                <div className="flex flex-col gap-1 min-w-0 pt-0.5 flex-1">
                  <h3 className="text-[16px] font-bold leading-tight text-gray-900 dark:text-gray-100">
                    Merge conflict
                  </h3>
                  <p className="text-[12.5px] leading-snug text-gray-500 dark:text-gray-400">
                    {count} file{plural ? 's' : ''} conflict{plural ? '' : 's'} with{' '}
                    <span className="font-mono font-semibold text-red-600 dark:text-red-400">{baseBranch}</span> - resolve{' '}
                    {plural ? 'them' : 'it'} before this branch can merge.
                  </p>
                </div>
                <IconButton onClick={() => setOpen(false)} aria-label="Close">
                  <X className="w-5 h-5" />
                </IconButton>
              </div>

              <div className="px-5 pb-2 flex flex-col gap-4">
                {/* Conflicting files */}
                {conflictFiles.length > 0 && (
                  <div>
                    <DialogSectionLabel>Conflicting files</DialogSectionLabel>
                    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 divide-y divide-gray-100 dark:divide-gray-700/50 max-h-40 overflow-y-auto">
                      {conflictFiles.map((f) => (
                        <div key={f} className="flex items-center gap-2.5 px-3.5 py-2.5">
                          <File className="w-4 h-4 shrink-0 text-red-500 dark:text-red-400" />
                          <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{f}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Resolution instructions */}
                <div>
                  <DialogSectionLabel>Resolving locally</DialogSectionLabel>
                  <div className="bg-gray-900 dark:bg-gray-950 rounded-xl p-4 space-y-1.5 text-[13px] font-mono leading-relaxed">
                    <p className="text-gray-400"># Navigate to the agent's worktree</p>
                    <p className="text-green-400 break-all">cd {worktreePath}</p>
                    <p className="text-gray-400 pt-2"># Merge the base branch (triggers conflict markers)</p>
                    <p className="text-green-400">git merge {baseBranch}</p>
                    <p className="text-gray-400 pt-2"># Edit conflicting files, then stage and commit</p>
                    <p className="text-green-400">git add {'<resolved-files>'}</p>
                    <p className="text-green-400">git commit</p>
                  </div>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-2.5 leading-snug">
                    The worktree at <span className="font-mono">{worktreePath}</span> is isolated - changes only affect this agent's branch.
                  </p>
                </div>
              </div>

              {/* Footer */}
              <div className="flex justify-end gap-2.5 px-5 py-3.5 mt-2 border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40">
                <DialogCancelButton onClick={() => setOpen(false)}>Dismiss</DialogCancelButton>
                <DialogConfirmButton
                  tone="indigo"
                  onClick={handleFixWithAgent}
                  disabled={sending}
                  icon={sending ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
                >
                  {sending ? 'Sending...' : 'Fix with agent'}
                </DialogConfirmButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

// ── Out-of-date (behind base) button ──────────────────────────────────────────

// BehindBaseButton warns when the branch trails its base branch and offers to
// merge the base in (update-from-base). It uses the same icon as the header's
// "Update from base branch" action for consistency. When an agent session is
// live or there are uncommitted changes, it surfaces those risks and requires an
// explicit confirmation before merging into the worktree.
function BehindBaseButton({ diff, agent, projectId, onUpdated }: {
  diff: DiffResponse | null
  agent: AgentResponse
  projectId: string | null
  onUpdated: () => void
}) {
  const [updating, setUpdating] = useState(false)
  const behind = diff?.behind_count ?? 0
  if (behind <= 0 || !agent.branch_name) return null

  const baseBranch = agent.base_branch
  // Warn about a collision only when the agent is *actively working*, not merely
  // alive. `session_status` is "running" for the whole life of the PTY session -
  // including while the agent sits idle waiting for input - so gating on it
  // showed the "work in progress" warning even for a waiting/finished agent.
  // The activity status (running|waiting|finished|...) reflects what it's doing.
  const running = agent.agent_status?.status === 'running'
  const hasUncommitted = diff?.uncommitted_changes ?? false

  const handleClick = () => {
    // A running session is the headline caution (merging shifts files under
    // active work); it takes precedence over the uncommitted-changes note, the
    // way the merge dialog prioritises its parent-running warning.
    const note = running
      ? 'An agent session is running - merging now may collide with work in progress.'
      : hasUncommitted
        ? "This branch has uncommitted changes - the merge may fail or conflict until they're committed."
        : undefined

    useDialogStore.getState().show({
      // The updateBase panel builds its body from `details` (branch pills +
      // behind count); `message` is unused for this variant but kept non-empty
      // for the store contract.
      title: 'Update from base',
      message: `Update from ${baseBranch}`,
      type: note ? 'warning' : 'confirm',
      variant: 'updateBase',
      details: { fromBranch: baseBranch ?? '-', toBranch: agent.branch_name ?? '-', behind, note },
      secondaryLabel: 'Fix with agent',
      // Hand the update off to the agent session instead of merging server-side -
      // mirrors the merge-conflict dialog's "Fix with agent". The primary Confirm
      // stays a plain server-side update-from-base. Injects the request into the
      // agent's input, the same channel the chat box uses.
      onSecondary: async () => {
        await runWithToast(
          () => api.default.sendAgentInput(projectId ?? '', agent.id, {
            text: `Update this branch from its base by merging the local ${baseBranch} branch in (do not git fetch first), resolving any conflicts that arise.`,
          }),
          { errorPrefix: 'Failed to send update request to agent' },
        )
      },
      onConfirm: async () => {
        setUpdating(true)
        try {
          await api.default.updateAgentFromBase(projectId ?? '', agent.id)
          onUpdated()
        } catch (err) {
          const body = apiErrorBody(err)
          if (body?.error === 'uncommitted_changes') {
            // The worktree has uncommitted changes the incoming base would overwrite
            // - not a content conflict. Name the files and ask the user to commit/stash.
            const files = body.conflicting_files ?? []
            const fileList = files.length ? `\n\n${files.map((f) => `• ${f}`).join('\n')}` : ''
            useDialogStore.getState().show({
              title: 'Uncommitted Changes',
              message: `Can't update: your worktree has uncommitted changes that merging "${baseBranch}" would overwrite. Commit or stash them, then try again.${fileList}`,
              type: 'warning',
            })
          } else if (body?.error === 'merge_conflict') {
            useDialogStore.getState().show({
              title: 'Update Conflict',
              message: `CONFLICT: Merging "${baseBranch}" failed due to git conflicts. Resolve them manually in the worktree.`,
              type: 'warning',
            })
          } else {
            useDialogStore.getState().show({
              title: 'Update Failed',
              message: `Failed to update from base: ${formatError(err)}`,
              type: 'error',
            })
          }
        } finally {
          setUpdating(false)
        }
      },
    })
  }

  return (
    <Tooltip className="shrink-0" content={
      <div>
        <p className="font-semibold mb-1">Branch out of date</p>
        <p className="text-gray-300">{behind} commit{behind !== 1 ? 's' : ''} behind <span className="font-mono">{baseBranch}</span></p>
        <p className="text-gray-400 mt-1 text-[10px]">Click to merge {baseBranch} in</p>
      </div>
    }>
      <button
        onClick={handleClick}
        disabled={updating}
        className="flex items-center gap-1 h-7 px-2 rounded-md text-xs font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {updating ? <LoaderCircle className="w-3.5 h-3.5 animate-spin shrink-0" /> : <FolderSync className="w-3.5 h-3.5 shrink-0" />}
        <span>{behind} behind</span>
      </button>
    </Tooltip>
  )
}

// ── File tree helpers ─────────────────────────────────────────────────────────

export type FileView = 'tree' | 'flat' | 'grouped'

// ── Sidebar components ────────────────────────────────────────────────────────

export function FileRow({ file, isActive, onClick, indent = 0 }: {
  file: DiffFile; isActive: boolean; onClick: () => void; indent?: number
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-1.5 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors group cursor-pointer ${isActive ? 'bg-blue-50 dark:bg-blue-900/20' : ''
        }`}
      style={{ paddingLeft: `${10 + indent}px`, paddingRight: '10px' }}
    >
      {(() => { const { Icon, className } = getFileIcon(file.path.split('/').pop() ?? file.path); return <Icon className={`w-3.5 h-3.5 shrink-0 ${className}`} /> })()}
      <Tooltip content={file.path} className="min-w-0">
        {/* File names read as sans (item 2), not monospace. */}
        <span className="text-xs truncate flex-1 min-w-0 text-gray-700 dark:text-gray-300">
          {file.path.split('/').pop()}
        </span>
      </Tooltip>
      <ChangeTypeIcon type={file.change_type} className="w-3 h-3 shrink-0" />
      <div className="flex items-center gap-1 shrink-0 ml-auto">
        {file.additions > 0 && <span className="text-[10px] text-green-600 dark:text-green-400">+{file.additions}</span>}
        {file.deletions > 0 && <span className="text-[10px] text-red-600 dark:text-red-400">-{file.deletions}</span>}
      </div>
    </button>
  )
}

export function TreeNodeView({ node, depth, collapsedFolders, toggleFolder, onFileClick, activeFilePath }: {
  node: TreeNode; depth: number; collapsedFolders: Set<string>
  toggleFolder: (path: string) => void; onFileClick: (path: string) => void; activeFilePath: string | null
}) {
  const indent = depth * 12
  if (node.type === 'dir') {
    const isOpen = !collapsedFolders.has(node.path)
    return (
      <div>
        <button
          onClick={() => toggleFolder(node.path)}
          className="w-full flex items-center gap-1.5 py-1 hover:bg-gray-50 dark:hover:bg-gray-700 text-left group cursor-pointer"
          style={{ paddingLeft: `${10 + indent}px`, paddingRight: '10px' }}
        >
          {isOpen
            ? <FolderOpen className="w-3.5 h-3.5 text-blue-400 dark:text-blue-500 shrink-0" />
            : <Folder className="w-3.5 h-3.5 text-blue-400 dark:text-blue-500 shrink-0" />
          }
          <span className="text-xs text-gray-600 dark:text-gray-400 flex-1 min-w-0 truncate">{node.name}</span>
          <ChevronDown className={`w-3 h-3 text-gray-400 shrink-0 transition-transform ${isOpen ? '' : '-rotate-90'}`} />
        </button>
        {/* Children stay mounted and their height animates via the grid-rows
            0fr<->1fr trick (the inner wrapper is overflow-hidden), so expand /
            collapse glides open and shut without measuring heights. */}
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out"
          style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}
        >
          <div className="overflow-hidden min-h-0">
            {node.children.map((child) => (
              <TreeNodeView key={child.path} node={child} depth={depth + 1}
                collapsedFolders={collapsedFolders} toggleFolder={toggleFolder}
                onFileClick={onFileClick} activeFilePath={activeFilePath} />
            ))}
          </div>
        </div>
      </div>
    )
  }
  return (
    <FileRow file={node.file!} isActive={node.file!.path === activeFilePath}
      onClick={() => onFileClick(node.file!.path)} indent={indent} />
  )
}


// ── Main DiffViewer component ─────────────────────────────────────────────────

// DiffViewer only reads a handful of the agent's fields (listed in the memo
// comparator below). The parent AgentDetail re-renders on EVERY live tick of
// the agent - activity-line changes, streamed test counts - and each of those
// hands us a structurally-new `agent` object, so a plain memo() would never
// hold. Comparing just the consumed fields keeps the whole diff subtree
// (toolbar, tests/preview/artifact panels, file list) out of those ticks.
export const DiffViewer = memo(DiffViewerImpl, (prev, next) =>
  prev.projectId === next.projectId &&
  prev.externalRefreshTrigger === next.externalRefreshTrigger &&
  prev.externalArtifactRefresh === next.externalArtifactRefresh &&
  prev.externalCommitSelect === next.externalCommitSelect &&
  prev.inspector === next.inspector &&
  prev.changesLeading === next.changesLeading &&
  prev.leadingInline === next.leadingInline &&
  prev.agent.id === next.agent.id &&
  prev.agent.branch_name === next.agent.branch_name &&
  prev.agent.base_branch === next.agent.base_branch &&
  prev.agent.worktree_path === next.agent.worktree_path &&
  prev.agent.agent_status?.status === next.agent.agent_status?.status)

// inspector: renders in the new two-pane layout's right pane. Same stacked
// layout as the classic single-column page (Changes bar with the base -> head
// selectors, then tests, previews, artifacts, and the diff itself), just
// without the top margin - the pane's own padding supplies it.
function DiffViewerImpl({ agent, projectId, externalRefreshTrigger, externalArtifactRefresh, externalCommitSelect, inspector, changesLeading, leadingInline }: { agent: AgentResponse; projectId: string | null; externalRefreshTrigger?: number; externalArtifactRefresh?: number; externalCommitSelect?: { sha: string; nonce: number } | null; inspector?: boolean; changesLeading?: ReactNode; leadingInline?: boolean }) {
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [leftSel, setLeftSel] = useState<LeftSel>({ type: 'base' })
  const [rightSel, setRightSel] = useState<RightSel>({ type: 'latest' })
  const [diff, setDiff] = useState<DiffResponse | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const [sideBySide, setSideBySide] = useState(() => readLocal(StorageKeys.diffSideBySide) === 'true')
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(() => readLocal(StorageKeys.diffIgnoreWhitespace) === 'true')
  const [wordHighlight, setWordHighlight] = useState(() => readLocal(StorageKeys.diffWordHighlight) !== 'false')
  const [singleFile, setSingleFile] = useState(() => readLocal(StorageKeys.diffSingleFile) === 'true')
  const [fileView, setFileView] = useState<FileView>(() => {
    const stored = readLocal(StorageKeys.diffFileView)
    if (stored === 'tree' || stored === 'flat' || stored === 'grouped') return stored
    return 'tree'
  })
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = readLocal(StorageKeys.diffSidebarWidth)
    if (stored) return parseInt(stored, 10)
    return 220
  })
  // Mobile file-picker sheet (item 31): below md the side file-list column is
  // hidden, so the "in N files" chip in the Changes bar opens this bottom sheet
  // to jump between changed files. Ephemeral (no persistence).
  const [fileSheetOpen, setFileSheetOpen] = useState(false)
  // Whether the file-list column is hidden (the Files header's show/hide toggle).
  // Persisted globally like the other diff view options.
  const [filesListHidden, setFilesListHidden] = useState(() => readLocal(StorageKeys.diffFilesListHidden) === 'true')
  useEffect(() => { writeLocal(StorageKeys.diffFilesListHidden, String(filesListHidden)) }, [filesListHidden])
  const [imageDiffMode, setImageDiffMode] = useState<ImageDiffMode>(() => {
    const stored = readLocal(StorageKeys.diffImageMode)
    if (stored === 'side-by-side' || stored === 'ab' || stored === 'slider' || stored === 'onion') return stored
    return 'ab'
  })
  // Global artifact-tile size multiplier (the diff settings size slider). Clamped to
  // [0.5, 2]; 1 = the aspect-ratio default. Scales every tile's auto span at once.
  const [artifactScale, setArtifactScale] = useState<number>(() => {
    const stored = Number(readLocal(StorageKeys.diffArtifactScale))
    return Number.isFinite(stored) && stored > 0 ? Math.min(2, Math.max(0.5, stored)) : 1
  })
  // Global before/after view + "highlight changed pixels", shared across every A/B
  // tile so they all flip / highlight together (keyboard B / H - see ArtifactsPanel).
  const [artifactView, setArtifactView] = useState<'before' | 'after'>(() => (readLocal(StorageKeys.diffArtifactView) === 'before' ? 'before' : 'after'))
  const [artifactHighlight, setArtifactHighlight] = useState<boolean>(() => readLocal(StorageKeys.diffArtifactHighlight) === 'true')
  // Artifact masonry layout - per-tile span overrides (dragging a tile's edge);
  // tiles without an override auto-span by aspect ratio. One set of overrides shared
  // across the artifacts panel and the repository artifacts view; persisted (see
  // lib/artifactColumns).
  const { spans: artifactSpans, setSpanOverride: setArtifactSpanOverride } = useArtifactSpans()

  const [singleFileIdx, setSingleFileIdx] = useState(0)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  // Collapsed diff files persist per agent so each agent's page restores which
  // files were folded away.
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(
    () => new Set(loadAgentViewPrefs(projectId, agent.id).collapsedFiles ?? []),
  )
  const [hiddenFiles, setHiddenFiles] = useState<Set<string>>(new Set())
  const userShownFilesRef = useRef<Set<string>>(new Set())
  // Per-file context (number of surrounding lines). Persists across polling refreshes.
  const [fileContexts, setFileContexts] = useState<Map<string, number>>(new Map())
  const fileContextsRef = useRef<Map<string, number>>(new Map())
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const fileRefCallbacksRef = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map())
  const sidebarRef = useRef<HTMLDivElement>(null)
  const commitsRef = useRef<CommitInfo[]>([])

  useEffect(() => { writeLocal(StorageKeys.diffSideBySide, String(sideBySide)) }, [sideBySide])
  useEffect(() => { writeLocal(StorageKeys.diffIgnoreWhitespace, String(ignoreWhitespace)) }, [ignoreWhitespace])
  useEffect(() => { writeLocal(StorageKeys.diffWordHighlight, String(wordHighlight)) }, [wordHighlight])
  useEffect(() => { writeLocal(StorageKeys.diffSingleFile, String(singleFile)) }, [singleFile])
  useEffect(() => { writeLocal(StorageKeys.diffFileView, fileView) }, [fileView])
  useEffect(() => { writeLocal(StorageKeys.diffSidebarWidth, String(sidebarWidth)) }, [sidebarWidth])
  useEffect(() => { writeLocal(StorageKeys.diffImageMode, imageDiffMode) }, [imageDiffMode])
  useEffect(() => { writeLocal(StorageKeys.diffArtifactScale, String(artifactScale)) }, [artifactScale])
  useEffect(() => { writeLocal(StorageKeys.diffArtifactView, artifactView) }, [artifactView])
  useEffect(() => { writeLocal(StorageKeys.diffArtifactHighlight, String(artifactHighlight)) }, [artifactHighlight])

  // Deep-links each diff file's header to the repository browser at the agent's
  // branch - the same target the tests panel builds (see TestsPanel's
  // onOpenInRepo). Undefined (button hidden) when there's no ref to browse.
  const openInRepo = useMemo(() => {
    const ref = agent.branch_name
    if (!ref || !projectId) return undefined
    return (path: string) => linkOptions({
      to: '/project/$projectId/repository/$',
      params: { projectId, _splat: `${ref}/${path}` },
    })
  }, [projectId, agent.branch_name])

  // DiffViewer is remounted on every agent switch (the route keys the whole
  // AgentDetail subtree by project+agent), so the collapsed-file set and the
  // commit selectors initialise fresh from this agent's prefs above - no
  // hand-reset on an agent-id change is needed.
  useEffect(() => {
    patchAgentViewPrefs(projectId, agent.id, { collapsedFiles: [...collapsedFiles] })
  }, [projectId, agent.id, collapsedFiles])

  // Tests-panel view modes - the two orthogonal cog checkboxes (see
  // TESTS_PLAN.md Feature 1), persisted per agent like collapsedFiles.
  // Group-by-result defaults ON (undefined stored pref -> true); an explicit
  // stored false is respected.
  const [testGroupResult, setTestGroupResult] = useState<boolean>(() => loadAgentViewPrefs(projectId, agent.id).testGroupResult ?? true)
  const [testUseScope, setTestUseScope] = useState<boolean>(() => !!loadAgentViewPrefs(projectId, agent.id).testUseScope)
  // Whether any loaded test case carries a logical scope (class/describe
  // chain) - reported up by the TestsPanel so the cog can grey the "Group by
  // scope" checkbox when the axis doesn't exist for this project's runners.
  const [testsHaveScope, setTestsHaveScope] = useState(false)
  useEffect(() => {
    patchAgentViewPrefs(projectId, agent.id, { testGroupResult, testUseScope })
  }, [projectId, agent.id, testGroupResult, testUseScope])

  const toggleFolder = useCallback((path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const toggleFileCollapse = useCallback((path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  useEffect(() => {
    if (!agent.branch_name) return
    api.default.getAgentCommits(projectId ?? '', agent.id)
      .then((c) => {
        setCommits(c)
        commitsRef.current = c
        lastCommitsSigRef.current = JSON.stringify(c.map((x) => x.sha))
      }).catch(() => setCommits([]))
  }, [agent.id, agent.branch_name, projectId, refreshKey])

  // expandFileDiff: fetches a single file's diff with a given context (for context expansion only).
  const expandFileDiff = useCallback(async (path: string, context: number = 3) => {
    if (!agent.branch_name) return

    // Record this context for use across polling refreshes
    fileContextsRef.current.set(path, context)
    setFileContexts(new Map(fileContextsRef.current))

    const params = buildDiffParams(leftSel, rightSel, ignoreWhitespace, commitsRef.current)

    try {
      const fileDiff = await api.default.getAgentDiff(projectId ?? '', agent.id,
        params.baseRef, params.headRef, params.ignoreWhitespace, params.includeUncommitted, path, context)

      // Select by path rather than [0] - the backend may return more than the
      // requested file (e.g. the simulation server ignores the path filter).
      const updated = fileDiff.files.find((x) => x.path === path)
      setDiff((prev) => {
        if (!prev) return prev
        const nextFiles = prev.files.map((f) => {
          if (f.path === path) {
            return { ...f, hunks: updated?.hunks ?? [] }
          }
          return f
        })
        return { ...prev, files: nextFiles }
      })
    } catch (e) {
      console.error('Failed to fetch file diff:', e)
    }
  }, [agent.id, agent.branch_name, projectId, leftSel, rightSel, ignoreWhitespace])

  // Compute hidden-file state from a fresh diff response.
  // Large files (HIDDEN_FILE_THRESHOLD changed lines) start hidden, unless the user has explicitly shown them.
  const applyHiddenFiles = useCallback((files: DiffFile[]) => {
    setHiddenFiles(() => {
      const next = new Set<string>()
      for (const f of files) {
        if (!userShownFilesRef.current.has(f.path) && f.additions + f.deletions >= HIDDEN_FILE_THRESHOLD) {
          next.add(f.path)
        }
      }
      return next
    })
  }, [])

  const handleShowFile = useCallback((path: string) => {
    userShownFilesRef.current.add(path)
    setHiddenFiles((prev) => { const next = new Set(prev); next.delete(path); return next })
  }, [])

  // Per-path content signatures + the file objects last handed to React, used to
  // reconcile a freshly-fetched diff against what's already shown. A background
  // refresh hands us an all-new file array even when most files are byte-identical;
  // re-rendering every FileDiff then re-stringifies and re-highlights each file's
  // (now full) content on the main thread, which janks the always-mounted viewer
  // while an agent is actively working. reconcileFiles reuses the previous object
  // for unchanged files so memo()'d FileDiffs skip the work entirely, and reports
  // whether anything changed at all (so a true no-op skips setDiff).
  const prevFileSigByPathRef = useRef<Map<string, string>>(new Map())
  const prevFilesByPathRef = useRef<Map<string, DiffFile>>(new Map())

  const reconcileFiles = useCallback((newFiles: DiffFile[]): { files: DiffFile[]; changed: boolean } => {
    const prevSig = prevFileSigByPathRef.current
    const prevFiles = prevFilesByPathRef.current
    const nextSig = new Map<string, string>()
    const nextFiles = new Map<string, DiffFile>()
    let changed = newFiles.length !== prevFiles.size
    const files = newFiles.map((f) => {
      const sig = hashDiffFile(f)
      nextSig.set(f.path, sig)
      if (prevSig.get(f.path) === sig) {
        // Identical content - reuse the existing object so its FileDiff (memo)
        // doesn't re-render, re-stringify, or re-highlight.
        const reused = prevFiles.get(f.path)!
        nextFiles.set(f.path, reused)
        return reused
      }
      changed = true
      nextFiles.set(f.path, f)
      return f
    })
    prevFileSigByPathRef.current = nextSig
    prevFilesByPathRef.current = nextFiles
    return { files, changed }
  }, [])

  useEffect(() => {
    if (!agent.branch_name) return
    let cancelled = false
    // Legitimate data-fetch effect: reset to the loading state before the async
    // fetch. This can't move to render (it sits alongside the fileContextsRef write,
    // and a ref must not be written during render), and the cascading render is
    // intended - it clears the stale diff + context expansions on a params change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingDiff(true)
    setDiffError(null)
    // Reset per-file context expansions when diff params change
    fileContextsRef.current = new Map()
    setFileContexts(new Map())

    const params = buildDiffParams(leftSel, rightSel, ignoreWhitespace, commitsRef.current)

    // Fetch the whole diff in one request: all files at -U3, plus each eligible
    // file's full content inline (full_context) so context expansion needs no
    // per-file follow-up requests.
    api.default.getAgentDiff(projectId ?? '', agent.id,
      params.baseRef, params.headRef, params.ignoreWhitespace, params.includeUncommitted, undefined, 3, true, HIDDEN_FILE_THRESHOLD, FULL_MAX_LINES)
      .then((d) => {
        if (!cancelled) {
          const { files } = reconcileFiles(d.files)
          setDiff({ ...d, files })
          applyHiddenFiles(files)
          setLoadingDiff(false)
        }
      })
      .catch((e) => { if (!cancelled) { setDiffError(formatError(e)); setLoadingDiff(false) } })

    return () => { cancelled = true }
  }, [agent.id, agent.branch_name, projectId, leftSel, rightSel, refreshKey, ignoreWhitespace, applyHiddenFiles, reconcileFiles])

  // Version params for the artifacts panel, mirroring the diff request logic.
  // Artifacts (e.g. screenshots) don't care about whitespace, so pass false.
  const artifactParams = useMemo(
    () => buildDiffParams(leftSel, rightSel, false, commits),
    [leftSel, rightSel, commits],
  )

  // Before/after raw-blob URLs for an in-tree image file in the diff, so FileDiff
  // can render the image differ. The before side reads the base ref; the after
  // side reads the head ref, or - when the right side is the worktree
  // (head_ref === "", i.e. an uncommitted/untracked change) - the worktree file
  // itself. Returns nulls for the missing side of an added/deleted file.
  const imageUrlsFor = (file: DiffFile): { before: string | null; after: string | null } => {
    if (!diff || !projectId || !file.binary || !isImagePath(file.path)) return { before: null, after: null }
    const before = file.change_type === 'added'
      ? null
      : agentBlobUrl(projectId, agent.id, file.old_path || file.path, { ref: diff.base_ref })
    const after = file.change_type === 'deleted'
      ? null
      : diff.head_ref
        ? agentBlobUrl(projectId, agent.id, file.path, { ref: diff.head_ref })
        : agentBlobUrl(projectId, agent.id, file.path, { worktree: true })
    return { before, after }
  }

  // Keep a ref to expandFileDiff so the silent refresh can call it without stale closures.
  const expandFileDiffRef = useRef(expandFileDiff)
  useEffect(() => { expandFileDiffRef.current = expandFileDiff }, [expandFileDiff])

  // Root container, used to scope the active-selection check below to this diff.
  const rootRef = useRef<HTMLDivElement>(null)

  // The Changes toolbar sticks to the top of the scroll area; the artifacts filter
  // bar and each artifact-card header stack flush beneath it (see ArtifactsPanel).
  // Their sticky `top` offsets need the toolbar's CURRENT height, which grows when
  // it wraps to multiple rows on narrow widths - so measure it and publish it as a
  // CSS var (--sticky-changes-h) that those descendants read in their top: calc(...).
  // Defaults to the unwrapped height until the first measure lands.
  const changesBarRef = useRef<HTMLDivElement>(null)
  const [changesBarH, setChangesBarH] = useState(45)
  useEffect(() => {
    const el = changesBarRef.current
    if (!el) return
    const measure = () => setChangesBarH(el.offsetHeight)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  // The sticky "Files" section header's height, published as --sticky-files-h so
  // the file rows + each file's sticky header dock just below it (see
  // FILE_STICKY_TOP) - the same mechanism the Tests/Artifacts panels use for
  // their cards. Measured (it can wrap on narrow widths).
  const [filesHeaderRef, filesHeaderH] = useMeasuredHeight(33)

  // True when the user currently has a non-collapsed text selection inside the diff.
  // Applying a background refresh in this state would replace the DOM nodes the
  // selection is anchored to and wipe it, so we defer the refresh until it clears.
  const hasActiveSelection = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false
    const root = rootRef.current
    if (!root) return false
    return root.contains(sel.getRangeAt(0).commonAncestorContainer)
  }, [])

  // Signature of the last-applied commits list. A silent refresh must not call
  // setCommits with an identical list: that re-renders DiffViewer for nothing, and a
  // re-render is enough to disturb an in-progress text selection (issue #34).
  const lastCommitsSigRef = useRef<string | null>(null)

  // Apply a silently-fetched diff and re-apply the user's per-file context expansions.
  // No-ops when the content is byte-identical to what's already shown.
  const applySilentDiff = useCallback((d: DiffResponse, contexts: Map<string, number>) => {
    const { files, changed } = reconcileFiles(d.files)
    if (!changed) return
    setDiff({ ...d, files })
    applyHiddenFiles(files)
    for (const [path, ctx] of contexts) {
      if (ctx > 3) expandFileDiffRef.current(path, ctx).catch(() => { })
    }
  }, [applyHiddenFiles, reconcileFiles])

  // A background refresh deferred because the user had an active selection. Flushed
  // by the selectionchange listener once the selection clears. Latest fetch wins.
  const pendingSilentRef = useRef<{ d: DiffResponse; contexts: Map<string, number> } | null>(null)
  useEffect(() => {
    const flush = () => {
      const pending = pendingSilentRef.current
      if (!pending || hasActiveSelection()) return
      pendingSilentRef.current = null
      applySilentDiff(pending.d, pending.contexts)
    }
    document.addEventListener('selectionchange', flush)
    return () => document.removeEventListener('selectionchange', flush)
  }, [hasActiveSelection, applySilentDiff])

  // Background (silent) refresh when triggered externally (e.g. git command detected via WS).
  //
  // Triggers must COALESCE, not drop. A diff_refresh that lands while a previous
  // silent fetch is still in flight has to be serviced once that fetch finishes -
  // otherwise a commit made moments after an edit is lost: the edit's fetch reads
  // the pre-commit state, the commit's trigger is dropped because a fetch was in
  // flight, and since externalRefreshTrigger never changes again nothing re-fetches,
  // so the diff stays stale. We record the latest trigger and re-run when a newer
  // one arrived during the fetch.
  const silentRefreshRunningRef = useRef(false)
  const latestTriggerRef = useRef(0)
  useEffect(() => {
    if (!externalRefreshTrigger || !agent.branch_name) return
    // Always remember the most recent trigger so an in-flight fetch picks it up.
    latestTriggerRef.current = externalRefreshTrigger
    if (silentRefreshRunningRef.current) return

    const run = () => {
      silentRefreshRunningRef.current = true
      // The trigger value this pass is servicing; if it advances before we finish,
      // a newer refresh landed mid-fetch and we run again.
      const servicing = latestTriggerRef.current

      const params = buildDiffParams(leftSel, rightSel, ignoreWhitespace, commitsRef.current)

      // Snapshot current per-file contexts before async work
      const contextsSnap = new Map(fileContextsRef.current)

      // Refresh commits list silently - but only push it into state when it actually
      // changed, so an idle/no-op refresh never re-renders (and never disturbs a
      // text selection the user has in the diff).
      const commitsP = api.default.getAgentCommits(projectId ?? '', agent.id)
        .then((c) => {
          commitsRef.current = c
          const sig = JSON.stringify(c.map((x) => x.sha))
          if (sig !== lastCommitsSigRef.current) {
            lastCommitsSigRef.current = sig
            setCommits(c)
          }
        }).catch(() => { })

      // Fetch full diff silently - preserves open comments since we diff against previous state.
      const diffP = api.default.getAgentDiff(projectId ?? '', agent.id,
        params.baseRef, params.headRef, params.ignoreWhitespace, params.includeUncommitted, undefined, 3, true, HIDDEN_FILE_THRESHOLD, FULL_MAX_LINES)
        .then((d) => {
          // Defer applying while the user is selecting text - otherwise the re-render
          // wipes their selection. The selectionchange listener flushes it later.
          if (hasActiveSelection()) {
            pendingSilentRef.current = { d, contexts: contextsSnap }
          } else {
            pendingSilentRef.current = null
            applySilentDiff(d, contextsSnap)
          }
        })
        .catch(() => { })

      Promise.allSettled([commitsP, diffP]).then(() => {
        silentRefreshRunningRef.current = false
        // A newer trigger arrived while we were fetching - service it now.
        if (latestTriggerRef.current !== servicing) run()
      })
    }
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalRefreshTrigger])

  const handleLeftChange = useCallback((newLeft: LeftSel) => {
    setLeftSel(newLeft)
  }, [])

  // Correct invalid selection combos DURING RENDER (the adjust-state-during-render
  // idiom) rather than in an effect: React re-renders immediately and the guards make
  // each correction idempotent (it converges in one step), so there's no cascading
  // effect render.
  if (leftSel.type === 'latest' && rightSel.type === 'latest') {
    // left='latest' and right='latest' is invalid - switch right to uncommitted
    setRightSel({ type: 'uncommitted' })
  } else if (leftSel.type === 'commit' && rightSel.type === 'commit') {
    const li = commitIdx(leftSel.sha, commits)
    const ri = commitIdx(rightSel.sha, commits)
    if (li !== -1 && ri !== -1 && li <= ri) setRightSel({ type: 'latest' })
  }

  // An externally-driven "show just this commit" selection (a commit chip
  // clicked in the chat transcript): parent -> commit, like picking the
  // adjacent pair in the selectors by hand. Applied once per nonce - the
  // selectors stay user-driven afterwards. When the sha isn't in our list yet
  // (the chip's list can be fresher than ours right after a commit), refetch
  // once and re-apply when the fresh list lands; if it's still missing then,
  // the commit is gone for real (a rebase) and the click is dropped.
  const appliedCommitNonceRef = useRef(0)
  const retriedCommitNonceRef = useRef(0)
  useEffect(() => {
    const sel = externalCommitSelect
    if (!sel || sel.nonce === appliedCommitNonceRef.current || commits.length === 0) return
    const idx = commitIdx(sel.sha, commits)
    if (idx === -1) {
      if (retriedCommitNonceRef.current !== sel.nonce) {
        retriedCommitNonceRef.current = sel.nonce
        setRefreshKey((k) => k + 1)
      } else {
        appliedCommitNonceRef.current = sel.nonce
      }
      return
    }
    appliedCommitNonceRef.current = sel.nonce
    // Legitimate effect: applies an external "show this commit" command (a nonce from
    // the parent), guarded to fire once per nonce, alongside a smooth-scroll side
    // effect - so it belongs in an effect, not render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLeftSel(idx + 1 < commits.length ? { type: 'commit', sha: commits[idx + 1].sha } : { type: 'base' })
    setRightSel({ type: 'commit', sha: sel.sha })
    // Bring the Changes bar + file list into view in whichever scroll context
    // hosts us (the inspector pane, or the archived page's main scroll).
    rootRef.current?.closest('[data-inspector-scroll], [data-main-scroll]')?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [externalCommitSelect, commits])

  const getFileRef = useCallback((path: string) => {
    if (!fileRefCallbacksRef.current.has(path)) {
      fileRefCallbacksRef.current.set(path, (el: HTMLDivElement | null) => {
        if (el) fileRefs.current.set(path, el)
        else fileRefs.current.delete(path)
      })
    }
    return fileRefCallbacksRef.current.get(path)!
  }, [])

  // Stable per-path "show this file" callbacks. An inline `() => handleShowFile(path)`
  // would be a fresh function identity on every render, breaking FileDiff's memo() -
  // every DiffViewer re-render would then re-render every FileDiff, re-apply the
  // highlighted lines' dangerouslySetInnerHTML, and recreate the text nodes an
  // in-progress sub-line selection is anchored to, collapsing it (issue #34). Caching
  // by path (like getFileRef) keeps the prop reference-stable so memo() holds.
  const showCallbacksRef = useRef<Map<string, () => void>>(new Map())
  const getShowCallback = useCallback((path: string) => {
    if (!showCallbacksRef.current.has(path)) {
      showCallbacksRef.current.set(path, () => handleShowFile(path))
    }
    return showCallbacksRef.current.get(path)!
  }, [handleShowFile])

  const scrollToFile = useCallback((path: string) => {
    const el = fileRefs.current.get(path)
    if (el) scrollCardToTop(el)
  }, [])

  const handleFileClick = useCallback((path: string) => {
    if (singleFile && diff) {
      const idx = diff.files.findIndex((f) => f.path === path)
      if (idx >= 0) setSingleFileIdx(idx)
    } else {
      if (collapsedFiles.has(path)) toggleFileCollapse(path)
      // No wait for the expand to render: scrollCardToTop re-measures every
      // frame, so it rides out the 200ms collapse glide (and the lazy bodies
      // mounting along the way) rather than trusting one stale measurement.
      scrollToFile(path)
    }
  }, [singleFile, diff, scrollToFile, collapsedFiles, toggleFileCollapse])

  // Jump from a queued review comment to the line it anchors to: reveal the file
  // (select it in single-file view; expand/show it otherwise), then centre the
  // line and flash it. scrollToDiffLine re-acquires the card and re-measures each
  // frame, so it copes with the file mounting a beat after these state updates.
  // No-op for a comment whose file has dropped out of the current comparison.
  const handleJumpToComment = useCallback((c: PendingReviewComment) => {
    if (!diff) return
    const idx = diff.files.findIndex((f) => f.path === c.path)
    if (idx < 0) return
    // In one-file-at-a-time view, switch to the commented file first (only its
    // card is mounted). scrollToDiffLine re-acquires the card each frame, so it
    // waits for the swapped-in card to mount.
    if (singleFile) setSingleFileIdx(idx)
    // Reveal the file's body in EITHER view: expand it if collapsed, un-hide it
    // if it's a big "Load diff" file - otherwise its rows never mount and there's
    // no line to scroll to.
    if (collapsedFiles.has(c.path)) toggleFileCollapse(c.path)
    if (hiddenFiles.has(c.path)) handleShowFile(c.path)
    scrollToDiffLine(
      () => fileRefs.current.get(c.path) ?? null,
      c.isNew ? 'new' : 'old',
      c.lineNum,
      (row) => {
        const rowEl = row.closest<HTMLElement>('.group') ?? row.parentElement
        if (!rowEl) return
        const prevShadow = rowEl.style.boxShadow
        const prevBg = rowEl.style.backgroundColor
        rowEl.style.transition = 'box-shadow 0.2s, background-color 0.2s'
        rowEl.style.boxShadow = 'inset 3px 0 0 0 #f59e0b'
        rowEl.style.backgroundColor = 'rgba(245, 158, 11, 0.18)'
        setTimeout(() => {
          rowEl.style.boxShadow = prevShadow
          rowEl.style.backgroundColor = prevBg
        }, 1600)
      },
    )
  }, [diff, singleFile, collapsedFiles, toggleFileCollapse, hiddenFiles, handleShowFile])

  const handleSingleFileChange = useCallback((v: boolean) => {
    setSingleFile(v); setSingleFileIdx(0)
  }, [])

  const handleJumpToUncommittedActual = useCallback(() => {
    setLeftSel({ type: 'latest' })
    setRightSel({ type: 'uncommitted' })
  }, [])

  // Confirmation toast text (a single "Comment sent" or a batch "Review sent"),
  // or null when hidden. One state so both paths share the same toast UI.
  const [sentToast, setSentToast] = useState<string | null>(null)
  const showSentToast = useCallback((text: string) => {
    setSentToast(text)
    setTimeout(() => setSentToast(null), 3000)
  }, [])

  // Queued "Add to review" comments for THIS agent, mirrored from localStorage so
  // the count/badge and the review popover update as the user adds or removes
  // them. Reloaded when the agent changes (DiffViewerImpl is not remounted per
  // agent - see the memo comparator - so switching agents re-runs this effect).
  const [reviewComments, setReviewComments] = useState<PendingReviewComment[]>(
    () => loadReviewDraft(projectId, agent.id),
  )
  // Reload the mirrored draft when the agent changes, during render (previous-key
  // idiom) rather than in an effect - DiffViewerImpl isn't remounted per agent, so
  // this reacts to the id change without a cascading effect render.
  const [prevReviewDraftKey, setPrevReviewDraftKey] = useState(`${projectId}\0${agent.id}`)
  if (prevReviewDraftKey !== `${projectId}\0${agent.id}`) {
    setPrevReviewDraftKey(`${projectId}\0${agent.id}`)
    setReviewComments(loadReviewDraft(projectId, agent.id))
  }
  const [submittingReview, setSubmittingReview] = useState(false)

  // Latest-value refs so handleComment (passed to every FileDiff) keeps a stable
  // identity across silent refreshes. Depending on diff/commits/sel directly would
  // give it a new identity on each refresh and re-render every FileDiff, defeating
  // their memo() - the main cost behind the agent-view jank. The refs are published
  // in an effect (a render must never write a ref); handleComment only reads them
  // asynchronously, well after commit.
  const diffRef = useRef(diff)
  const leftSelRef = useRef(leftSel)
  const rightSelRef = useRef(rightSel)
  useEffect(() => {
    diffRef.current = diff
    leftSelRef.current = leftSel
    rightSelRef.current = rightSel
  })

  const handleComment = useCallback(async (path: string, lineNum: number, isNew: boolean, text: string) => {
    const { fromLabel, toLabel } = resolveDiffLabels(leftSelRef.current, rightSelRef.current, commitsRef.current, agent.base_branch)
    const file = diffRef.current?.files.find(f => f.path === path)
    const block = diffContextBlock(path, findHunkForLine(file, lineNum, isNew), lineNum, isNew)

    let msg = `Comment on \`${path}\` line ${lineNum} (marked with \`# ^\` in the block below) (diff: ${fromLabel} -> ${toLabel})\n`
    if (block) msg += `\n${block}`
    msg += `\nComment:\n${text}`

    try {
      await api.default.sendAgentInput(projectId ?? '', agent.id, { text: msg })
      showSentToast('Comment sent to agent')
    } catch (e) {
      console.error('Failed to send comment:', e)
    }
  }, [agent.id, agent.base_branch, projectId, showSentToast])

  // "Add to review": cache the comment (with a frozen context block + the current
  // hunk's hash for staleness detection) instead of sending it now. The batch is
  // flushed later by submitReview. Kept stable (refs + functional setState) so it
  // doesn't bust FileDiff's memo, just like handleComment.
  const handleAddToReview = useCallback((path: string, lineNum: number, isNew: boolean, text: string) => {
    const { fromLabel, toLabel } = resolveDiffLabels(leftSelRef.current, rightSelRef.current, commitsRef.current, agent.base_branch)
    const file = diffRef.current?.files.find(f => f.path === path)
    const hunk = findHunkForLine(file, lineNum, isNew)
    const next = addReviewComment(projectId, agent.id, {
      path, lineNum, isNew, text, fromLabel, toLabel,
      contextBlock: diffContextBlock(path, hunk, lineNum, isNew),
      hunkHash: hunk ? hashHunks([hunk]) : '',
    })
    setReviewComments(next)
  }, [agent.id, agent.base_branch, projectId])

  const removeQueuedComment = useCallback((id: string) => {
    setReviewComments(removeReviewComment(projectId, agent.id, id))
  }, [projectId, agent.id])

  // Flush the whole queued batch to the agent as one message, then clear the
  // draft. Each comment carries its own frozen context, so the message is built
  // entirely from the stored data - independent of what the live diff shows now.
  const submitReview = useCallback(async () => {
    const comments = loadReviewDraft(projectId, agent.id)
    if (comments.length === 0 || submittingReview) return
    setSubmittingReview(true)
    const header = comments.length === 1
      ? `Please address the following review comment:`
      : `Please address the following ${comments.length} review comments:`
    const body = comments.map((c, i) => {
      let s = `## ${i + 1}. \`${c.path}\` line ${c.lineNum} (diff: ${c.fromLabel} -> ${c.toLabel})\n`
      if (c.contextBlock) s += `\n${c.contextBlock}`
      s += `\nComment:\n${c.text}`
      return s
    }).join('\n\n')
    try {
      await api.default.sendAgentInput(projectId ?? '', agent.id, { text: `${header}\n\n${body}` })
      clearReviewDraft(projectId, agent.id)
      setReviewComments([])
      showSentToast(comments.length === 1 ? 'Review sent to agent' : `Review of ${comments.length} comments sent to agent`)
    } catch (e) {
      console.error('Failed to submit review:', e)
    } finally {
      setSubmittingReview(false)
    }
  }, [agent.id, projectId, submittingReview, showSentToast])

  // Which queued comments have gone stale: the diff under them changed since they
  // were added (the anchoring hunk's content hash no longer matches, or the line
  // is gone from the current comparison entirely). Recomputed against the LIVE
  // diff so it updates on refresh and when the comparison selectors change. A
  // comment stored with no hunk (hash '') can't be judged, so it's never stale.
  const staleReviewIds = useMemo(() => {
    const stale = new Set<string>()
    for (const c of reviewComments) {
      if (!c.hunkHash) continue
      const file = diff?.files.find(f => f.path === c.path)
      const hunk = findHunkForLine(file, c.lineNum, c.isNew)
      if ((hunk ? hashHunks([hunk]) : '') !== c.hunkHash) stale.add(c.id)
    }
    return stale
  }, [diff, reviewComments])

  const [isResizing, setIsResizing] = useState(false)
  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  useEffect(() => {
    if (!isResizing) return
    const handleMouseMove = (e: MouseEvent) => {
      if (!sidebarRef.current) return
      const rect = sidebarRef.current.getBoundingClientRect()
      const newWidth = e.clientX - rect.left
      if (newWidth > 100 && newWidth < 600) setSidebarWidth(newWidth)
    }
    const handleMouseUp = () => setIsResizing(false)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, setSidebarWidth])

  const totalAdditions = diff?.files.reduce((s, f) => s + f.additions, 0) ?? 0
  const totalDeletions = diff?.files.reduce((s, f) => s + f.deletions, 0) ?? 0
  const activeFilePath = singleFile && diff ? (diff.files[singleFileIdx]?.path ?? null) : null
  const hasExistingDiff = diff !== null

  // The file order exactly as the sidebar lays it out for the current view, so
  // the single-file pager (prev/next) walks files in the SAME order the list
  // shows them, rather than diff.files' raw order (which groups differently and
  // made the pager jump around - image6). Tree = depth-first leaf order,
  // grouped = per-folder, flat = as-is.
  const orderedFiles = useMemo(() => {
    const files = diff?.files ?? []
    if (fileView === 'grouped') return getGroupedFiles(files).flatMap(([, gf]) => gf)
    if (fileView === 'tree') {
      const out: DiffFile[] = []
      const walk = (nodes: TreeNode[]) => nodes.forEach((n) => {
        if (n.type === 'dir') walk(n.children)
        else if (n.file) out.push(n.file)
      })
      walk(compactTree(buildFileTree(files)))
      return out
    }
    return files
  }, [diff, fileView])
  // Position of the currently-shown single file within that display order, and a
  // jump helper that maps an ordered position back to its diff.files index (which
  // is what singleFileIdx / FileRow.isActive key off).
  const singleOrderPos = diff ? orderedFiles.findIndex((f) => f.path === diff.files[singleFileIdx]?.path) : -1
  const goToOrderPos = useCallback((pos: number) => {
    const target = orderedFiles[pos]
    if (!target) return
    const idx = (diff?.files ?? []).findIndex((f) => f.path === target.path)
    if (idx >= 0) setSingleFileIdx(idx)
  }, [orderedFiles, diff])

  const renderSidebar = (files: DiffFile[]) => {
    if (fileView === 'tree') {
      const tree = compactTree(buildFileTree(files))
      return tree.map((node) => (
        <TreeNodeView key={node.path} node={node} depth={0}
          collapsedFolders={collapsedFolders} toggleFolder={toggleFolder}
          onFileClick={handleFileClick} activeFilePath={activeFilePath} />
      ))
    }
    if (fileView === 'grouped') {
      const groups = getGroupedFiles(files)
      return groups.map(([folder, groupFiles]) => (
        <div key={folder || '__root__'}>
          {folder && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-50 dark:bg-gray-700/50 border-y border-gray-100 dark:border-gray-700/50 group">
              <Folder className="w-3 h-3 text-blue-400 dark:text-blue-500 shrink-0" />
              <span className="font-mono text-[9px] text-gray-500 dark:text-gray-400 truncate flex-1 min-w-0">{folder}</span>
            </div>
          )}
          {groupFiles.map((f) => {
            const idx = diff!.files.findIndex((df) => df.path === f.path)
            return <FileRow key={f.path} file={f} isActive={singleFile && idx === singleFileIdx}
              onClick={() => handleFileClick(f.path)} indent={folder ? 4 : 0} />
          })}
        </div>
      ))
    }
    return files.map((f, i) => (
      <FileRow key={f.path} file={f} isActive={singleFile && i === singleFileIdx}
        onClick={() => handleFileClick(f.path)} />
    ))
  }

  if (!agent.branch_name) return null

  // ── Shared render fragments ────────────────────────────────────────────────
  // Assembled one way by the classic single-column stacked layout and another by
  // the new inspector layout (Diff / Tests / Previews behind a view selector).
  const statsEl = diff && (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-green-600 dark:text-green-400 font-medium">+{totalAdditions}</span>
      <span className="text-xs text-red-600 dark:text-red-400 font-medium">-{totalDeletions}</span>
      {/* Desktop: plain label (the side file list is visible). Mobile (< md, where
          that list is hidden): a tappable chip that opens the file-picker sheet. */}
      <span className="hidden md:inline text-xs text-gray-400 dark:text-gray-500">in {diff.files.length} file{diff.files.length !== 1 ? 's' : ''}</span>
      {diff.files.length > 0 ? (
        <button
          type="button"
          onClick={() => setFileSheetOpen(true)}
          className="md:hidden inline-flex items-center gap-0.5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline decoration-dotted underline-offset-2 cursor-pointer"
        >
          in {diff.files.length} file{diff.files.length !== 1 ? 's' : ''}
          <ChevronDown className="w-3 h-3" />
        </button>
      ) : (
        <span className="md:hidden text-xs text-gray-400 dark:text-gray-500">in 0 files</span>
      )}
    </div>
  )
  const resetBtn = !(leftSel.type === 'base' && rightSel.type === 'latest') && (
    <Tooltip content="Reset to base -> latest">
      <button
        onClick={() => { setLeftSel({ type: 'base' }); setRightSel({ type: 'latest' }) }}
        className="flex items-center justify-center w-7 h-7 rounded-md text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors cursor-pointer"
      >
        <RotateCcw className="w-3.5 h-3.5" />
      </button>
    </Tooltip>
  )
  const warningButtons = (
    <>
      <UncommittedButton diff={diff} onJumpToUncommitted={handleJumpToUncommittedActual} />
      <MergeConflictButton diff={diff} agent={agent} projectId={projectId} />
      <BehindBaseButton diff={diff} agent={agent} projectId={projectId} onUpdated={() => setRefreshKey((k) => k + 1)} />
    </>
  )
  const refreshBtn = (
    <Tooltip content="Refresh">
      <button
        onClick={() => setRefreshKey((k) => k + 1)}
        disabled={loadingDiff}
        className="flex items-center justify-center w-7 h-7 rounded-md text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors cursor-pointer"
      >
        <RefreshCw className="w-3.5 h-3.5" />
      </button>
    </Tooltip>
  )
  const loadingSpinner = loadingDiff && hasExistingDiff && (
    <LoaderCircle className="w-3.5 h-3.5 animate-spin text-gray-400 dark:text-gray-500 shrink-0" />
  )
  // The Files section's own settings (was the diff-toolbar cog): the file-list
  // view mode plus the diff-rendering options. Lives in the Files header now, so
  // Tests/Artifacts each carry only their own options in their own headers.
  const filesSettingsBtn = (
    <SettingsPopover label="File options" width={208}>
      <SettingsGroupLabel className="mb-2">File List</SettingsGroupLabel>
      <div className="flex flex-col gap-0.5 mb-3">
        {([
          { value: 'tree', label: 'Tree' },
          { value: 'flat', label: 'Flat list' },
          { value: 'grouped', label: 'Grouped by folder' },
        ] as { value: FileView; label: string }[]).map((opt) => (
          <SettingsOptionRow key={opt.value} type="radio" name="hydra-file-view"
            checked={fileView === opt.value} onChange={() => setFileView(opt.value)} label={opt.label} />
        ))}
      </div>
      <SettingsGroupLabel className="mb-2">Options</SettingsGroupLabel>
      <div className="flex flex-col gap-0.5">
        <SettingsOptionRow type="checkbox" checked={sideBySide} onChange={setSideBySide} label="Side by side" />
        <SettingsOptionRow type="checkbox" checked={wordHighlight} onChange={setWordHighlight} label="Highlight changed words" />
        <SettingsOptionRow type="checkbox" checked={ignoreWhitespace} onChange={setIgnoreWhitespace} label="Ignore whitespace" />
        <SettingsOptionRow type="checkbox" checked={singleFile} onChange={handleSingleFileChange} label="One file at a time" />
      </div>
    </SettingsPopover>
  )

  const testsPanelEl = agent.branch_name && projectId && (
    <TestsPanel
      projectId={projectId}
      agentId={agent.id}
      repoRef={agent.branch_name ?? undefined}
      headRef={artifactParams.headRef}
      includeUncommitted={artifactParams.includeUncommitted}
      refreshKey={refreshKey + (externalArtifactRefresh ?? 0)}
      groupResult={testGroupResult}
      onGroupResultChange={setTestGroupResult}
      useScope={testUseScope && testsHaveScope}
      onUseScopeChange={setTestUseScope}
      onScopeAvailable={setTestsHaveScope}
    />
  )
  const previewPanelEl = agent.branch_name && projectId && (
    <PreviewPanel
      projectId={projectId}
      agentId={agent.id}
      headRef={artifactParams.headRef}
      includeUncommitted={artifactParams.includeUncommitted}
      refreshKey={refreshKey + (externalArtifactRefresh ?? 0)}
    />
  )
  const artifactsPanelEl = agent.branch_name && (
    <ArtifactsPanel
      projectId={projectId}
      agentId={agent.id}
      baseRef={artifactParams.baseRef}
      headRef={artifactParams.headRef}
      includeUncommitted={artifactParams.includeUncommitted}
      // Re-snapshot artifacts on the manual refresh button (refreshKey) AND
      // when a commit is auto-detected (externalArtifactRefresh). Both only
      // ever increment, so their sum strictly increases on either trigger,
      // re-running ArtifactsPanel's effect to re-request - a cache hit when
      // the resolved commit SHA is unchanged, a regen when it moved. The
      // diff text itself updates silently via externalRefreshTrigger, so we
      // deliberately keep this out of the diff-loading effects (which would
      // flash a loading spinner and reset the user's selection).
      refreshKey={refreshKey + (externalArtifactRefresh ?? 0)}
      imageDiffMode={imageDiffMode}
      onImageDiffModeChange={setImageDiffMode}
      artifactScale={artifactScale}
      onArtifactScaleChange={setArtifactScale}
      artifactView={artifactView}
      onArtifactViewChange={setArtifactView}
      artifactHighlight={artifactHighlight}
      onArtifactHighlightChange={setArtifactHighlight}
      artifactSpans={artifactSpans}
      onArtifactSpanChange={setArtifactSpanOverride}
    />
  )
  const diffErrorBanner = diffError && hasExistingDiff && (
    <div className="mb-3 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400">
      Refresh failed: {diffError}
    </div>
  )
  // The diff body (file-list column + file diffs), shared by both layouts.
  const diffContentEl = !hasExistingDiff && loadingDiff ? (
    <div className="flex items-center justify-center py-8 text-gray-400 dark:text-gray-500">
      <LoaderCircle className="w-4 h-4 animate-spin mr-2" />
      <span className="text-sm">Loading diff...</span>
    </div>
  ) : !hasExistingDiff && diffError ? (
    <div className="px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400">
      {diffError}
    </div>
  ) : diff && diff.files.length === 0 ? (
    <div className={`flex items-center justify-center py-8 text-gray-400 dark:text-gray-500 text-sm transition-opacity ${loadingDiff ? 'opacity-40' : ''}`}>
      No changes
    </div>
  ) : diff ? (
    <div className={`flex min-h-0 transition-opacity duration-150 ${loadingDiff ? 'opacity-40 pointer-events-none' : ''}`}>
      {/* File list sidebar (hidden on mobile - the diff content takes the full
          width there; files are still all rendered below, or reachable via the
          prev/next pager in single-file mode - and hidden anywhere via the Files
          header's toggle). The file count + section title now live in the sticky
          Files header above, so the column has no cap header of its own; it docks
          just below that header (FILE_STICKY_TOP includes its height).
          Hidden via the toggle it stays mounted and its width + right margin
          animate to 0 (the gap-4 is folded into that margin so the whole thing
          slides away cleanly); the transition is dropped mid width-drag. */}
      <div
        ref={sidebarRef}
        className="hidden md:flex shrink-0 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-gray-800 self-start sticky z-20 flex-col shadow-sm"
        style={{
          width: filesListHidden ? 0 : sidebarWidth,
          marginRight: filesListHidden ? 0 : 16,
          borderWidth: filesListHidden ? 0 : undefined,
          top: FILE_STICKY_TOP,
          transition: isResizing ? undefined : 'width 240ms ease, margin-right 240ms ease',
        }}
      >
        <div data-file-list className="overflow-y-auto max-h-[calc(100vh-140px)]">{renderSidebar(diff.files)}</div>
        {/* Width drag handle: invisible strip, shared pill on hover (the
            unified resize affordance). Hidden while the column is collapsed. */}
        {!filesListHidden && (
          <div
            onMouseDown={startResizing}
            title="Drag to resize"
            className="group/resize absolute right-0 top-0 bottom-0 w-3 -mr-1 flex items-center justify-center cursor-col-resize z-20 touch-none"
          >
            <ResizeGrip orientation="vertical" />
          </div>
        )}
      </div>

      {/* Diff content */}
      <div className="flex-1 min-w-0">
        {singleFile ? (
          <>
            {/* Intentionally not sticky: the file header below now sticks at
                FILE_STICKY_TOP, so a sticky pager here would dock at the same
                Y and overlap it. The pager scrolls away; the file header stays. */}
            <div className="flex items-center gap-2 mb-3 z-20">
              <button
                onClick={() => goToOrderPos(singleOrderPos - 1)}
                disabled={singleOrderPos <= 0}
                className="flex items-center justify-center w-7 h-7 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors shadow-sm"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 text-xs text-gray-500 dark:text-gray-400 shadow-sm font-medium">
                {singleOrderPos + 1} / {diff.files.length}
              </div>
              <button
                onClick={() => goToOrderPos(singleOrderPos + 1)}
                disabled={singleOrderPos >= diff.files.length - 1}
                className="flex items-center justify-center w-7 h-7 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors shadow-sm"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <FileDiff
              key={diff.files[singleFileIdx]?.path}
              file={diff.files[singleFileIdx]!}
              sideBySide={sideBySide}
              wordHighlight={wordHighlight}
              isCollapsed={collapsedFiles.has(diff.files[singleFileIdx].path)}
              onToggleCollapse={toggleFileCollapse}
              onComment={handleComment}
              onAddToReview={handleAddToReview}
              onExpand={expandFileDiff}
              isHidden={hiddenFiles.has(diff.files[singleFileIdx].path)}
              // getShowCallback/getFileRef return render-stable per-path callbacks that
              // (deliberately) close over the DOM-node registry and userShownFiles refs -
              // both touched only in event handlers / at commit, never during render. The
              // refs rule follows that transitively and flags the call; it is a safe
              // false positive here. Same at the stacked-list map below.
              // eslint-disable-next-line react-hooks/refs
              onShow={getShowCallback(diff.files[singleFileIdx].path)}
              // eslint-disable-next-line react-hooks/refs
              fileRef={getFileRef(diff.files[singleFileIdx].path)}
              currentContext={fileContexts.get(diff.files[singleFileIdx].path) ?? 3}
              imageDiffMode={imageDiffMode}
              imageBefore={imageUrlsFor(diff.files[singleFileIdx]).before}
              imageAfter={imageUrlsFor(diff.files[singleFileIdx]).after}
              openInRepo={openInRepo}
            />
          </>
        ) : (
          // Render the stacked cards in the SAME order the sidebar lists them
          // (orderedFiles = tree depth-first / grouped / flat), not diff.files'
          // raw order - otherwise the tree/grouped sidebar and the diff column
          // disagree and clicking a file scrolls to a card in a different spot.
          // eslint-disable-next-line react-hooks/refs -- see the getShowCallback/getFileRef note above
          orderedFiles.map((f) => {
            const img = imageUrlsFor(f)
            return (
            <FileDiff key={f.path} file={f} sideBySide={sideBySide} wordHighlight={wordHighlight}
              isCollapsed={collapsedFiles.has(f.path)}
              onToggleCollapse={toggleFileCollapse}
              onComment={handleComment}
              onAddToReview={handleAddToReview}
              onExpand={expandFileDiff}
              isHidden={hiddenFiles.has(f.path)}
              onShow={getShowCallback(f.path)}
              fileRef={getFileRef(f.path)}
              currentContext={fileContexts.get(f.path) ?? 3}
              imageDiffMode={imageDiffMode}
              imageBefore={img.before}
              imageAfter={img.after}
              openInRepo={openInRepo}
            />
            )
          })
        )}
      </div>
    </div>
  ) : null

  // The "Files" section header - a peer to the Tests / Previews / Artifacts
  // headers (same icon + title + info + right-aligned controls), sitting above
  // the file-list column and diffs. Sticky like the others: it docks flush below
  // the Changes bar and publishes its height as --sticky-files-h (on the panel
  // root) so the file rows + each file's own sticky header dock just beneath it
  // (see FILE_STICKY_TOP). Only shown once a diff with files has loaded. Carries
  // the file-list show/hide toggle and the options cog (file-list grouping + diff
  // rendering) that used to live in the Changes-bar cog. Shown for any loaded
  // diff - including an empty one, where the "No changes" note sits beneath it.
  const filesHeaderEl = diff && (
    <div
      ref={filesHeaderRef}
      style={{ top: 'calc(var(--sticky-changes-h, 45px) - 16px)' }}
      // z-[22]: above the file cards' own sticky headers (z-20), which are later
      // in the DOM and would otherwise paint OVER this section header while
      // docking; below the Changes bar's z-[25].
      className="sticky z-[22] flex flex-wrap items-center gap-2 mb-2 min-h-[1.625rem] bg-gray-50 dark:bg-gray-900 -mx-1 px-1 py-1.5 border-b border-gray-200 dark:border-gray-800 shadow-sm"
    >
      <FilesIcon className="w-3.5 h-3.5 text-gray-500 dark:text-gray-400" />
      <h3 className="text-xs font-semibold tracking-wide text-gray-500 dark:text-gray-400">Files</h3>
      {/* Info trigger before the file count: the count rewidths as you switch
          refs (8 -> 34 -> 123), which would otherwise shift the `i` sideways out
          from under a stationary cursor. */}
      <InfoTooltip title="Files" width={460}>
        <p>Every file changed between the two selected refs (the <strong>vs</strong> base and the target on the Changes bar). The list on the left jumps to a file; the diffs render on the right.</p>
        <p>The cog holds this section's view options: the file-list grouping (<strong>tree</strong>, flat, or grouped by folder) and how the diffs render - <strong>side by side</strong> vs inline, <strong>ignore whitespace</strong>, and <strong>one file at a time</strong> (a pager instead of the full stack). Very large files start collapsed - expand them from their header.</p>
      </InfoTooltip>
      <span className="text-[11px] font-normal text-gray-400 dark:text-gray-500">{diff.files.length}</span>
      <div className="ml-auto flex items-center gap-1.5">
        {/* Show/hide the file-list column (hidden on mobile anyway, where the
            diffs take the full width - so the toggle only bites at md+). */}
        <Tooltip content={filesListHidden ? 'Show file list' : 'Hide file list'}>
          <button
            onClick={() => setFilesListHidden((v) => !v)}
            aria-label={filesListHidden ? 'Show file list' : 'Hide file list'}
            className="hidden md:flex items-center justify-center w-7 h-7 rounded-md border text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors cursor-pointer"
          >
            {filesListHidden ? <PanelLeftOpen className="w-3.5 h-3.5" /> : <PanelLeftClose className="w-3.5 h-3.5" />}
          </button>
        </Tooltip>
        {filesSettingsBtn}
      </div>
    </div>
  )

  const dragOverlay = isResizing && <div className="fixed inset-0 z-[100] cursor-col-resize" />
  const commentToast = sentToast && (
    <div className="fixed bottom-4 right-4 z-[500] flex items-center gap-2 px-3 py-2 bg-green-600 text-white text-xs font-semibold rounded-lg shadow-lg pointer-events-none">
      <Check className="w-3.5 h-3.5" />
      {sentToast}
    </div>
  )

  // ── Stacked layout (single-column page AND the split layout's inspector pane) ─
  return (
    // --sticky-changes-h (the measured Changes-toolbar height) is published here so
    // the artifacts filter bar and card headers below can dock flush beneath it even
    // when the toolbar wraps. See the ResizeObserver above.
    // In the inspector pane the mt-4 is dropped - the pane's own pt-4 already
    // spaces the bar off the pane top (and -top-4 cancels exactly that padding).
    <div ref={rootRef} className={inspector ? undefined : 'mt-4'} style={{ '--sticky-changes-h': `${changesBarH}px`, '--sticky-files-h': diff ? `${filesHeaderH}px` : '0px' } as CSSProperties}>
      {/* Section header */}
      {/* -top-4 cancels the scroll container's pt-4 (AgentDetail) so the stuck
          header docks flush under the top bar - no overlap (was -top-6) and no
          gap for the artifacts filter bar to peek through (was top-0).
          z-[25] keeps it above the diff rows and the sticky file-list panel
          (z-20) and below the mobile sidebar panel (z-40 in __root.tsx). */}
      {/* A pane TOOLBAR, deliberately subordinate to the global top bar: page
          background (opaque, so content scrolls under it while stuck) and a
          small section label rather than the top bar's white bg + title type.
          py-2.5 lands a single-line bar at the working pane toolbar's min-h-12,
          so the two collapse toggles flanking the divider line up. In the
          inspector pane it fills the pane's top edge-to-edge: -mx-3/-mx-6 fully
          cancels the scroll container's px-3/px-6, the inner px matches the
          working pane toolbar's px-3/px-4, and -mt-4 cancels the container's
          pt-4 so the bar sits flush at the top at rest too (not just when
          stuck). */}
      <div ref={changesBarRef} className={`flex items-start gap-2 sm:gap-3 mb-3 sticky -top-4 z-[25] bg-gray-50 dark:bg-gray-900 py-2.5 border-b border-gray-200 dark:border-gray-700 ${inspector ? '-mt-4 -mx-3 sm:-mx-6 px-3 sm:px-4' : '-mx-1.5 sm:-mx-3 px-1.5 sm:px-3'}`}>
        {/* Wide split: the collapse toggle flanks the divider at the bar's left
            edge, pinned to the first line (self-start under items-start) so it
            stays level with the working pane toolbar's toggle even when either
            side wraps. Narrow screen-stack (leadingInline) instead flows the
            back button INLINE as the first item of the top row (beside
            "Changes"), so the ref-selector row below gets the full width. */}
        {changesLeading && !leadingInline && <div className="shrink-0">{changesLeading}</div>}
        {/* Wrapping content group: everything but the refresh/settings actions,
            which stay pinned top-right (below). Wraps within its own flex-1 track
            so the actions never move off the corner when it goes multi-line. */}
        <div className="flex-1 min-w-0 flex items-center gap-3 flex-wrap">
          {changesLeading && leadingInline && <div className="shrink-0">{changesLeading}</div>}
          <h2 className="text-xs font-semibold text-gray-500 dark:text-gray-400">Changes</h2>
          {statsEl}

          {/* Comparison selector (base → head) kept as one wrap unit so the arrow
              never separates from its selectors - the whole "main → Latest commit"
              drops to the next line together when it can't fit beside the stats. */}
          <div className="flex items-center gap-3">
            <LeftSelector commits={commits} selected={leftSel} onChange={handleLeftChange} baseBranch={agent.base_branch} rightSel={rightSel} />
            <span className="text-gray-400 dark:text-gray-500 text-xs select-none"><ArrowRightLeft className='w-6 h-6' strokeWidth='1.5' /></span>
            <RightSelector commits={commits} selected={rightSel} onChange={setRightSel}
              left={leftSel} hasUncommitted={diff?.uncommitted_changes} />
          </div>

          {resetBtn}
          {warningButtons}
        </div>

        {/* Actions pinned to the top-right corner regardless of how many lines the
            content above wraps to (parent is items-start, this group is shrink-0). */}
        <div className="flex items-center gap-2 shrink-0">
          {/* "Submit review" - shown only once the user has queued at least one
              "Add to review" comment for this agent. */}
          <ReviewDraftPopover
            comments={reviewComments}
            staleIds={staleReviewIds}
            submitting={submittingReview}
            onSubmit={submitReview}
            onRemove={removeQueuedComment}
            onJump={handleJumpToComment}
          />
          {loadingSpinner}
          {refreshBtn}
        </div>
      </div>

      {/* Test verdicts (PLAN #68) for the selected versions - single-sided, so it
          tracks the "after" commit (latest by default) like the artifacts below,
          and sits just under the Changes header. Renders nothing when the project
          configures no [[tests]] runners. */}
      {testsPanelEl}

      {/* Live server previews ([[artifacts]] type = "server") for the selected
          "after" version - single-sided like the tests above. Renders nothing
          when the project configures no server scripts. */}
      {previewPanelEl}

      {/* Error banner on refresh failure */}
      {diffErrorBanner}

      {/* Visual artifacts (e.g. screenshots) for the selected versions */}
      {artifactsPanelEl}

      {/* Files section header (its cog holds the file-list + diff options) then
          the file-list column + diffs. */}
      {filesHeaderEl}
      {diffContentEl}
      {dragOverlay}
      {commentToast}
      {/* Mobile file-picker sheet (item 31). Portalled to document.body so its
          position:fixed is viewport-relative - the narrow screen-stack track has
          a transform, which would otherwise be its containing block. md:hidden so
          it can't linger if the viewport grows past the side-list breakpoint. */}
      {fileSheetOpen && diff && createPortal(
        <div className="md:hidden fixed inset-0 z-[60] flex flex-col justify-end" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setFileSheetOpen(false)} />
          <div className="relative flex flex-col max-h-[70vh] bg-white dark:bg-gray-800 rounded-t-2xl border-t border-gray-200 dark:border-gray-700 shadow-2xl animate-in slide-in-from-bottom-4 duration-200">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                Files <span className="text-gray-400 dark:text-gray-500 tabular-nums">{diff.files.length}</span>
              </h3>
              <button
                type="button"
                onClick={() => setFileSheetOpen(false)}
                aria-label="Close file list"
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto overflow-x-hidden py-1">
              {diff.files.map((f, i) => (
                <FileRow
                  key={f.path}
                  file={f}
                  isActive={singleFile && i === singleFileIdx}
                  onClick={() => { handleFileClick(f.path); setFileSheetOpen(false) }}
                />
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
