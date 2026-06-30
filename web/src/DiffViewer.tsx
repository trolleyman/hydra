import { useEffect, useRef, useState, useCallback, Fragment, useMemo, memo, type CSSProperties } from 'react'
import { highlightLines } from './lib/highlightCore'
import { highlightSides } from './lib/highlightClient'
import { api } from './stores/apiClient'
import { formatError, apiErrorBody } from './api/format_error'
import type { AgentResponse, CommitInfo, DiffFile, DiffHunk, DiffLine, DiffResponse } from './api'
import {
  Plus, Calendar, TriangleAlert,
  ChevronDown, ChevronUp, ChevronRight, ChevronLeft, Check, LoaderCircle, RefreshCw, RotateCcw,
  Settings, Copy, Folder, FolderOpen, X, GitMergeConflict, Bot, File,
  MoveRight, MessageSquarePlus, FolderSync,
  SquarePlus, SquareMinus, SquareArrowRight,
} from 'lucide-react'
import { DialogIconTile, DialogSectionLabel, DialogCancelButton, DialogConfirmButton } from './components/dialogPrimitives'
import { IconButton } from './components/IconButton'
import { getFileIcon } from './lib/fileIcons'
import { Tooltip } from './components/Tooltip'
import { ArtifactsPanel } from './components/ArtifactsPanel'
import { TestsPanel } from './components/TestsPanel'
import { ImageDiffView, IMAGE_DIFF_MODES, type ImageDiffMode } from './components/ArtifactImageDiff'
import { isImagePath, agentBlobUrl } from './lib/imageDiff'
import { useArtifactSpans } from './lib/artifactColumns'
import { useDialogStore } from './stores/dialogStore'
import { StorageKeys, readLocal, writeLocal } from './lib/storage'
import { loadAgentViewPrefs, patchAgentViewPrefs } from './lib/agentViewPrefs'

// ── Syntax highlighting helpers ───────────────────────────────────────────────

const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  go: 'go', rs: 'rust', py: 'python', rb: 'ruby', java: 'java',
  c: 'c', cpp: 'cpp', h: 'cpp', cs: 'csharp', php: 'php',
  css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  sh: 'bash', bash: 'bash', zsh: 'bash', md: 'markdown', sql: 'sql',
  kt: 'kotlin', swift: 'swift', dart: 'dart', r: 'r',
  dockerfile: 'dockerfile', makefile: 'makefile',
}

function getLanguage(filePath: string): string {
  const filename = filePath.split('/').pop() ?? filePath
  const lower = filename.toLowerCase()
  if (lower === 'dockerfile') return 'dockerfile'
  if (lower === 'makefile') return 'makefile'
  const ext = lower.split('.').pop() ?? ''
  return EXT_LANG_MAP[ext] ?? 'plaintext'
}

// ── Diff line building helpers ────────────────────────────────────────────────

interface SideBySideLine {
  oldLineNum: number | null
  oldType: 'context' | 'deletion' | 'empty'
  oldContent: string | null
  newLineNum: number | null
  newType: 'context' | 'addition' | 'empty'
  newContent: string | null
}

function buildSideBySide(hunkLines: DiffHunk['lines']): SideBySideLine[] {
  const result: SideBySideLine[] = []
  let i = 0
  while (i < hunkLines.length) {
    const l = hunkLines[i]
    if (l.type === 'context') {
      result.push({
        oldLineNum: l.old_line_num ?? null, oldType: 'context', oldContent: l.content,
        newLineNum: l.new_line_num ?? null, newType: 'context', newContent: l.content,
      })
      i++
    } else if (l.type === 'deletion') {
      const dels: typeof hunkLines = []
      const adds: typeof hunkLines = []
      while (i < hunkLines.length && hunkLines[i].type === 'deletion') dels.push(hunkLines[i++])
      while (i < hunkLines.length && hunkLines[i].type === 'addition') adds.push(hunkLines[i++])
      const maxLen = Math.max(dels.length, adds.length)
      for (let j = 0; j < maxLen; j++) {
        result.push({
          oldLineNum: dels[j]?.old_line_num ?? null,
          oldType: j < dels.length ? 'deletion' : 'empty',
          oldContent: dels[j]?.content ?? null,
          newLineNum: adds[j]?.new_line_num ?? null,
          newType: j < adds.length ? 'addition' : 'empty',
          newContent: adds[j]?.content ?? null,
        })
      }
    } else if (l.type === 'addition') {
      result.push({
        oldLineNum: null, oldType: 'empty', oldContent: null,
        newLineNum: l.new_line_num ?? null, newType: 'addition', newContent: l.content,
      })
      i++
    } else {
      i++
    }
  }
  return result
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(text).catch(() => { })
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Tooltip content="Copy path">
      <button
        onClick={handleCopy}
        className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 shrink-0 cursor-pointer transition-colors"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5 text-gray-400" />}
      </button>
    </Tooltip>
  )
}


function CommentRow({ onSubmit, onCancel }: { onSubmit: (text: string) => Promise<void>; onCancel: () => void }) {
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); handleSubmit() }
    else if (e.key === 'Escape') onCancel()
  }

  return (
    <div className="border-y border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/10 px-4 py-3">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full h-20 p-2 text-xs font-sans bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded focus:ring-1 focus:ring-blue-500 outline-none resize-none"
        placeholder="Write a comment… (Ctrl+Enter to submit)"
      />
      <div className="flex justify-end gap-2 mt-2">
        <button
          onClick={onCancel}
          className="px-2 py-1 text-[10px] font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          disabled={!text.trim() || sending}
          onClick={handleSubmit}
          className="px-2 py-1 text-[10px] font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded transition-colors cursor-pointer"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

// CommentButton overlays a line-number gutter cell and reveals a small "add
// comment" button centred over the gutter on hover. The button has a solid
// button-style background so the icon stays legible on top of code/line
// backgrounds, and its tooltip sits directly above the icon's centre.
function CommentButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip
      content="Add comment"
      side="top"
      className="absolute inset-0 z-10 items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
    >
      <button
        onClick={(e) => { e.stopPropagation(); onClick() }}
        className="flex items-center justify-center w-4 h-4 rounded bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 shadow-sm hover:bg-blue-50 dark:hover:bg-blue-900/40 cursor-pointer"
      >
        <MessageSquarePlus className="w-3 h-3 text-blue-500" />
      </button>
    </Tooltip>
  )
}

// Computes the number of lines hidden between two adjacent hunks.
function computeGap(prevHunk: DiffHunk, nextHunk: DiffHunk): number {
  let lastNewLine = 0
  let lastOldLine = 0
  for (const l of prevHunk.lines) {
    if (l.new_line_num != null) lastNewLine = l.new_line_num
    if (l.old_line_num != null) lastOldLine = l.old_line_num
  }
  const lastLine = lastNewLine > 0 ? lastNewLine : lastOldLine
  const nextStart = nextHunk.new_start > 0 ? nextHunk.new_start : nextHunk.old_start
  return Math.max(0, nextStart - lastLine - 1)
}

// trailingContext counts the unchanged context lines at the very end of a hunk,
// ignoring a trailing "no newline" marker. `git diff -U<n>` emits up to `n`
// context lines after the last change, so when a hunk shows fewer than the
// requested context it has run out of file — the hunk already reaches EOF and
// there is nothing left below to expand into.
function trailingContext(hunk: DiffHunk): number {
  let count = 0
  for (let i = hunk.lines.length - 1; i >= 0; i--) {
    const t = hunk.lines[i].type
    if (t === 'no_newline') continue
    if (t === 'context') { count++; continue }
    break
  }
  return count
}

// ── Diff Hunk rendering ───────────────────────────────────────────────────────

const UNIFIED_LINE_NUM_CLASS = 'select-none text-right pr-2 text-gray-400 dark:text-gray-600 text-xs font-mono w-10 shrink-0 border-r border-gray-200 dark:border-gray-700 leading-5'
const UNIFIED_CODE_CLASS = 'pl-1 font-mono text-xs leading-5 flex-1 whitespace-pre-wrap break-words overflow-hidden'

const UnifiedHunk = memo(function UnifiedHunk({ hunk, highlightedOld, highlightedNew, onComment, readOnly }: {
  hunk: DiffHunk
  highlightedOld: Map<number, string>
  highlightedNew: Map<number, string>
  onComment: (lineNum: number, isNew: boolean, text: string) => void
  readOnly?: boolean
}) {
  const [openCommentIdx, setOpenCommentIdx] = useState<number | null>(null)
  return (
    <div>
      {hunk.lines.map((line, idx) => {
        const isAdd = line.type === 'addition'
        const isDel = line.type === 'deletion'
        const isNoNewline = line.type === 'no_newline'
        const highlighted = isAdd
          ? (line.new_line_num != null ? highlightedNew.get(line.new_line_num) : undefined)
          : (line.old_line_num != null ? highlightedOld.get(line.old_line_num) : undefined)
        const bgClass = isAdd ? 'bg-green-50 dark:bg-green-500/15' : isDel ? 'bg-red-50 dark:bg-red-500/15' : ''
        return (
          <Fragment key={idx}>
            <div className={`flex items-stretch hover:brightness-95 dark:hover:brightness-110 relative group ${bgClass}`}>
              <div className="relative flex shrink-0 select-none">
                <span className={UNIFIED_LINE_NUM_CLASS}>{line.old_line_num ?? ''}</span>
                <span className={UNIFIED_LINE_NUM_CLASS}>{line.new_line_num ?? ''}</span>
                {!isNoNewline && !readOnly && (
                  <CommentButton onClick={() => setOpenCommentIdx(openCommentIdx === idx ? null : idx)} />
                )}
              </div>
              <span className={`select-none font-mono text-xs leading-5 w-4 text-center shrink-0 ${isAdd ? 'text-green-600 dark:text-green-400' : isDel ? 'text-red-600 dark:text-red-400' : 'text-gray-300 dark:text-gray-700'
                }`}>
                {isAdd ? '+' : isDel ? '-' : isNoNewline ? '\\' : ' '}
              </span>
              {isNoNewline ? (
                <span className={`${UNIFIED_CODE_CLASS} text-gray-400 dark:text-gray-500 italic`}>{line.content}</span>
              ) : highlighted ? (
                <span className={UNIFIED_CODE_CLASS} dangerouslySetInnerHTML={{ __html: highlighted }} />
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
                onCancel={() => setOpenCommentIdx(null)}
              />
            )}
          </Fragment>
        )
      })}
    </div>
  )
})

const SBS_LINE_NUM = 'select-none text-right text-gray-400 dark:text-gray-600 text-xs font-mono w-8 shrink-0 pr-1 leading-5'
const SBS_CODE = 'pl-1 font-mono text-xs leading-5 flex-1 whitespace-pre-wrap break-words overflow-hidden min-w-0'

const SideBySideHunk = memo(function SideBySideHunk({ hunk, highlightedOld, highlightedNew, onComment, readOnly }: {
  hunk: DiffHunk
  highlightedOld: Map<number, string>
  highlightedNew: Map<number, string>
  onComment: (lineNum: number, isNew: boolean, text: string) => void
  readOnly?: boolean
}) {
  const [openCommentIdx, setOpenCommentIdx] = useState<number | null>(null)
  const sbsLines = buildSideBySide(hunk.lines)
  return (
    <div>
      {sbsLines.map((line, idx) => {
        const oldHighlighted = line.oldLineNum != null ? highlightedOld.get(line.oldLineNum) : undefined
        const newHighlighted = line.newLineNum != null ? highlightedNew.get(line.newLineNum) : undefined
        const oldBg = line.oldType === 'deletion' ? 'bg-red-50 dark:bg-red-500/15' : line.oldType === 'empty' ? 'bg-gray-50 dark:bg-gray-900/50' : ''
        const newBg = line.newType === 'addition' ? 'bg-green-50 dark:bg-green-500/15' : line.newType === 'empty' ? 'bg-gray-50 dark:bg-gray-900/50' : ''
        return (
          <Fragment key={idx}>
            <div className="flex items-stretch divide-x divide-gray-200 dark:divide-gray-700">
              <div className={`flex items-start flex-1 min-w-0 group relative ${oldBg}`}>
                <div className="relative flex shrink-0 select-none">
                  <span className={SBS_LINE_NUM}>{line.oldLineNum ?? ''}</span>
                  {line.oldLineNum != null && !readOnly && (
                    <CommentButton onClick={() => setOpenCommentIdx(openCommentIdx === idx ? null : idx)} />
                  )}
                </div>
                <span className={`select-none font-mono text-xs w-3 shrink-0 text-center leading-5 ${line.oldType === 'deletion' ? 'text-red-500' : 'text-gray-300 dark:text-gray-700'}`}>
                  {line.oldType === 'deletion' ? '-' : line.oldType === 'empty' ? '' : ' '}
                </span>
                {line.oldContent != null && oldHighlighted
                  ? <span className={SBS_CODE} dangerouslySetInnerHTML={{ __html: oldHighlighted }} />
                  : <span className={SBS_CODE}>{line.oldContent ?? ''}</span>
                }
              </div>
              <div className={`flex items-start flex-1 min-w-0 group relative ${newBg}`}>
                <div className="relative flex shrink-0 select-none">
                  <span className={SBS_LINE_NUM}>{line.newLineNum ?? ''}</span>
                  {line.newLineNum != null && !readOnly && (
                    <CommentButton onClick={() => setOpenCommentIdx(openCommentIdx === idx ? null : idx)} />
                  )}
                </div>
                <span className={`select-none font-mono text-xs w-3 shrink-0 text-center leading-5 ${line.newType === 'addition' ? 'text-green-500' : 'text-gray-300 dark:text-gray-700'}`}>
                  {line.newType === 'addition' ? '+' : line.newType === 'empty' ? '' : ' '}
                </span>
                {line.newContent != null && newHighlighted
                  ? <span className={SBS_CODE} dangerouslySetInnerHTML={{ __html: newHighlighted }} />
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

const EXPANDER_ROW = 'flex items-center bg-blue-50 dark:bg-blue-950/30 border-y border-blue-100 dark:border-blue-900/50 px-2 py-0.5'
const EXPANDER_BTN = 'p-0.5 rounded hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-500 cursor-pointer'

// Default surrounding-context lines shown around each change (mirrors the git
// `-U3` the diff is first fetched with), and how many extra lines each ⌄/⌃
// expander reveals per click.
const CTX = 3
const EXPAND_STEP = 20
// An unchanged run that would hide this few lines behind an expander isn't worth
// collapsing — a "··· 1 line ···" toggle saves no vertical space and just adds a
// click — so show those lines inline instead.
const MIN_COLLAPSE_GAP = 1
// Files whose full content exceeds this many lines keep the lightweight `-U3`
// view + network expansion rather than rendering the whole file client-side.
// The server applies the same cap when deciding which files to expand in the
// full_context response (max_full_lines); this is the matching client guard.
const FULL_MAX_LINES = 6000

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
// (so multi-line constructs — block comments, template strings — highlight
// correctly) and returns per-line-number → HTML maps for the old and new sides.
// Used only for the small-file fast path; larger files go through the worker.
function buildHighlightMaps(lines: DiffLine[], lang: string) {
  const { oldLines, newLines } = extractSides(lines)
  const highlight = (ls: SideLine[]): Map<number, string> =>
    mapFromHtml(ls, ls.length ? highlightLines(ls.map((l) => l.content).join('\n'), lang) : null)
  return { highlightedOld: highlight(oldLines), highlightedNew: highlight(newLines) }
}

const isChangeLine = (l: DiffLine) => l.type === 'addition' || l.type === 'deletion'

// isContiguous verifies the line-number sequence has no gaps, i.e. these lines
// really are the *entire* file (`git diff -U<huge>`) and not several hunks with
// hidden lines between them. Only then is client-side reveal correct.
function isContiguous(lines: DiffLine[]): boolean {
  let prevOld: number | null = null
  let prevNew: number | null = null
  for (const l of lines) {
    if (l.old_line_num != null) {
      if (prevOld != null && l.old_line_num !== prevOld + 1) return false
      prevOld = l.old_line_num
    }
    if (l.new_line_num != null) {
      if (prevNew != null && l.new_line_num !== prevNew + 1) return false
      prevNew = l.new_line_num
    }
  }
  return true
}

// How many context lines a region currently shows at its top (adjacent to the
// preceding change) and bottom (adjacent to the following change). Absent ⇒
// region uses its default.
type RevealMap = Map<string, { top?: number; bot?: number }>

interface RenderSeg {
  kind: 'lines' | 'gap' | 'topedge' | 'botedge'
  key: string
  lines?: DiffLine[]
  regionId?: string
  hidden?: number
  top?: number     // resolved context lines shown at the region's top
  bot?: number     // resolved context lines shown at the region's bottom
  length?: number  // total lines in the region
}

const regionKey = (l: DiffLine) => `${l.old_line_num ?? 'x'}:${l.new_line_num ?? 'x'}`

// buildSegments turns a fully-fetched file (every line as a diff line) plus the
// user's per-region reveal state into a flat list of render segments: runs of
// visible lines interleaved with collapsed-region expanders. Each unchanged run
// between (or around) changes shows `CTX` lines next to the change by default
// and collapses the rest behind an expander; expanders that would hide nothing
// (short gaps, the file's true top/bottom once fully revealed) are omitted, so
// e.g. a 1-line gap simply renders the line and the top expander vanishes at
// line 1 / the bottom expander at EOF.
function buildSegments(fullLines: DiffLine[], reveal: RevealMap): RenderSeg[] {
  const n = fullLines.length
  const runs: { change: boolean; s: number; e: number }[] = []
  let i = 0
  while (i < n) {
    const change = isChangeLine(fullLines[i])
    let e = i + 1
    while (e < n && isChangeLine(fullLines[e]) === change) e++
    runs.push({ change, s: i, e })
    i = e
  }

  const segs: RenderSeg[] = []
  runs.forEach((run, ri) => {
    if (run.change) {
      segs.push({ kind: 'lines', key: `b${run.s}`, lines: fullLines.slice(run.s, run.e) })
      return
    }
    const L = run.e - run.s
    const isLead = ri === 0
    const isTrail = ri === runs.length - 1
    const id = regionKey(fullLines[run.s])
    const ov = reveal.get(id)
    const top = Math.min(L, ov?.top ?? (isLead ? 0 : CTX))
    const bot = Math.min(L - top, ov?.bot ?? (isTrail ? 0 : CTX))
    const hidden = L - top - bot
    if (hidden <= MIN_COLLAPSE_GAP) {
      segs.push({ kind: 'lines', key: `c${run.s}`, lines: fullLines.slice(run.s, run.e) })
      return
    }
    if (top > 0) segs.push({ kind: 'lines', key: `ct${run.s}`, lines: fullLines.slice(run.s, run.s + top) })
    segs.push({
      kind: isLead ? 'topedge' : isTrail ? 'botedge' : 'gap',
      key: `g${run.s}`, regionId: id, hidden, top, bot, length: L,
    })
    if (bot > 0) segs.push({ kind: 'lines', key: `cb${run.s}`, lines: fullLines.slice(run.e - bot, run.e) })
  })
  return segs
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
// Mirrors STICKY_CARD_TOP's approach.
export const FILE_STICKY_TOP = 'calc(var(--sticky-changes-h, 45px) - 16px)'

export const FileDiff = memo(function FileDiff({ file, sideBySide, fileRef, onComment, isCollapsed, onToggleCollapse, onExpand, isHidden, onShow, currentContext, readOnly, headless, imageDiffMode, imageBefore, imageAfter }: {
  file: DiffFile
  sideBySide: boolean
  fileRef?: (el: HTMLDivElement | null) => void
  onComment: (path: string, lineNum: number, isNew: boolean, text: string) => void
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
  // When true, the line-level "add comment" affordances are hidden — used by the
  // repository diff view, which has no agent to send comments to.
  readOnly?: boolean
  // When true, the per-file card chrome (border + collapsible header) is dropped
  // and the diff body is rendered bare and always-expanded — used by the
  // repository diff's one-file-at-a-time view, whose surrounding header already
  // carries the filename, change type, line counts and copy/raw actions.
  headless?: boolean
}) {
  const lang = getLanguage(file.path)

  const [reveal, setReveal] = useState<RevealMap>(new Map())

  // Signature of the visible hunks. A background refresh hands us new file
  // objects even when nothing changed, so keying derived work on identity would
  // recompute on every refresh. The string signature is stable across no-op
  // refreshes, so we only recompute when content truly changes.
  const hunksSig = useMemo(() => JSON.stringify(file.hunks), [file.hunks])

  // Whole-file content for the reveal/collapse model. The server returns each
  // eligible file's entire content in the main diff response (full_context) and
  // marks it `expanded`, so we derive the line list straight from the hunks —
  // no per-file round-trip. Files the server left at windowed context (too
  // large) aren't marked expanded and fall through to the `-U3` hunks + network
  // expand below. The size/contiguity checks are a defensive guard so a
  // malformed response can't drive the reveal model with non-whole-file lines.
  const fullLines = useMemo<DiffLine[] | null>(() => {
    if (file.binary || isHidden || isCollapsed || !file.expanded) return null
    const lines = file.hunks ? file.hunks.flatMap((h) => h.lines) : []
    if (lines.length === 0 || lines.length > FULL_MAX_LINES || !isContiguous(lines)) return null
    return lines
    // hunksSig stands in for file.hunks identity (stable across no-op refreshes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hunksSig, file.binary, file.expanded, isHidden, isCollapsed])

  // Lines to highlight: the whole file when expanded (so multi-line constructs
  // stay correct), else the visible `-U3` hunks. Null when nothing is rendered
  // (binary/collapsed/hidden) — highlighting an unseen body would be wasted work.
  const highlightSource = useMemo<DiffLine[] | null>(() => {
    if (file.binary || isCollapsed || isHidden) return null
    const lines = fullLines ?? (file.hunks ? file.hunks.flatMap((h) => h.lines) : [])
    return lines.length ? lines : null
    // hunksSig (not file.hunks identity) so an unchanged file isn't recomputed
    // when an unrelated file changes and the whole diff object is replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullLines, hunksSig, file.binary, isCollapsed, isHidden])

  // Small files highlight inline (no flash, no worker round-trip). Larger files
  // would block the main thread if every one highlighted during the same render,
  // so they paint as plain text and colourise from the Web Worker pool — the
  // hljs work runs fully off the UI thread. Whole-file input keeps the
  // highlighting correct regardless of which path runs.
  const syncHighlight = useMemo(
    () => (highlightSource && highlightSource.length <= HL_SYNC_MAX ? buildHighlightMaps(highlightSource, lang) : null),
    [highlightSource, lang],
  )
  const [asyncHighlight, setAsyncHighlight] = useState(EMPTY_HIGHLIGHT)
  useEffect(() => {
    if (!highlightSource || highlightSource.length <= HL_SYNC_MAX) return
    // Repaint as plain text while the worker highlights the new content.
    setAsyncHighlight(EMPTY_HIGHLIGHT)
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

  // A file with whole-file content but no additions/deletions (e.g. a pure
  // rename) has nothing to collapse — render its lines plainly rather than
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

  const renderLines = (lines: DiffLine[], key: string) => (
    sideBySide
      ? <SideBySideHunk key={key} hunk={synthHunk(lines)} highlightedOld={highlightedOld} highlightedNew={highlightedNew}
        onComment={(ln, isNew, txt) => onComment(file.path, ln, isNew, txt)} readOnly={readOnly} />
      : <UnifiedHunk key={key} hunk={synthHunk(lines)} highlightedOld={highlightedOld} highlightedNew={highlightedNew}
        onComment={(ln, isNew, txt) => onComment(file.path, ln, isNew, txt)} readOnly={readOnly} />
  )

  return (
    <div ref={fileRef} className={headless ? '' : 'border border-gray-200 dark:border-gray-700 rounded-lg mb-4 bg-white dark:bg-gray-900 shadow-sm'}>
      {!headless && (
      // Sticky header: pins flush below the Changes toolbar (FILE_STICKY_TOP, the
      // same Y as the file-list sidebar) while the file's diff scrolls under it,
      // releasing when the card ends. The root drops its overflow-hidden (which
      // would trap this sticky header inside the card); the header carries its own
      // overflow-hidden + rounded-t-lg instead, plus rounded-b-lg while collapsed.
      <div
        style={{ top: FILE_STICKY_TOP }}
        className={`flex items-center gap-2 px-3 py-1.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 sticky z-20 overflow-hidden rounded-t-lg ${isCollapsed ? 'rounded-b-lg' : ''} cursor-pointer`}
        onClick={() => onToggleCollapse(file.path)}
      >
        <button
          onClick={() => onToggleCollapse(file.path)}
          className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 cursor-pointer transition-colors"
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
        </button>
        {(() => { const { Icon, className } = getFileIcon(file.path.split('/').pop() ?? file.path); return <Icon className={`w-3.5 h-3.5 shrink-0 ${className}`} /> })()}
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="font-mono text-xs min-w-0 truncate cursor-pointer hover:underline">
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
        {!file.binary && (
          <div className="flex items-center gap-1.5 shrink-0 ml-1">
            {file.additions > 0 && <span className="text-xs text-green-600 dark:text-green-400 font-medium">+{file.additions}</span>}
            {file.deletions > 0 && <span className="text-xs text-red-600 dark:text-red-400 font-medium">-{file.deletions}</span>}
          </div>
        )}
      </div>
      )}
      {(headless || !isCollapsed) && (
        // rounded-b-lg + overflow-hidden replaces the clipping the root used to do
        // (its overflow-hidden was dropped so the header can be sticky), keeping the
        // edge-to-edge diff content's bottom corners clipped to the card's radius.
        <div className={headless ? '' : 'overflow-hidden rounded-b-lg'}>
          {file.binary && isImagePath(file.path) ? (
            // In-tree image: reuse the artifacts panel's before/after differ.
            <div className="p-3">
              <ImageDiffView left={imageBefore} right={imageAfter} mode={imageDiffMode ?? 'ab'} name={file.path} />
            </div>
          ) : file.binary ? (
            <div className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500 italic">Binary file changed</div>
          ) : isHidden ? (
            <div className="px-4 py-8 flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 italic">
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
              : <div className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500 italic">No changes</div>
          ) : !file.hunks || file.hunks.length === 0 ? (
            <div className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500 italic">No changes</div>
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
                        onComment={(ln, isNew, txt) => onComment(file.path, ln, isNew, txt)} readOnly={readOnly} />
                      : <UnifiedHunk hunk={hunk} highlightedOld={highlightedOld} highlightedNew={highlightedNew}
                        onComment={(ln, isNew, txt) => onComment(file.path, ln, isNew, txt)} readOnly={readOnly} />
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

function formatShortLabel(commit: CommitInfo | null | undefined, sha: string): string {
  if (!commit) return sha.slice(0, 7)
  const msg = commit.message.slice(0, 24)
  return `${commit.short_sha} ${msg}${commit.message.length > 24 ? '…' : ''}`
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
let activeHide: (() => void) | null = null

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

  const cancelHide = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }, [])

  const hideNow = useCallback(() => {
    cancelHide()
    setVisible(false)
    if (activeHide === hideNow) activeHide = null
  }, [cancelHide])

  const show = useCallback(() => {
    cancelHide()
    // Dismiss any other tooltip before we claim the active slot.
    if (activeHide && activeHide !== hideNow) activeHide()
    activeHide = hideNow
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
  }, [side, cancelHide, hideNow])

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

function LeftSelector({ commits, selected, onChange, baseBranch, rightSel }: {
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
}

// ── Right commit selector ─────────────────────────────────────────────────────

function RightSelector({ commits, selected, onChange, left, hasUncommitted }: {
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
}

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

  // Escape closes the panel, matching the backdrop click and close button.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!diff?.merge_conflict) return null

  const conflictFiles = diff.conflict_files ?? []
  const n = conflictFiles.length
  const count = n || '?'
  const plural = n !== 1
  const worktreePath = agent.worktree_path ?? '<worktree-path>'
  const baseBranch = agent.base_branch

  const handleFixWithAgent = async () => {
    setSending(true)
    try {
      await api.default.sendAgentInput(projectId ?? '', agent.id, { text: `Fix the merge conflicts with branch ${baseBranch}` })
      setOpen(false)
    } catch {
      // silently ignore
    } finally {
      setSending(false)
    }
  }

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

            {/* Panel — mirrors the merge/kill RichConfirmPanel: icon tile + stacked
                title/description, uppercase section labels, shared footer buttons. */}
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
                    <span className="font-mono font-semibold text-red-600 dark:text-red-400">{baseBranch}</span> — resolve{' '}
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
                          <span className="font-mono text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{f}</span>
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
                    The worktree at <span className="font-mono">{worktreePath}</span> is isolated — changes only affect this agent's branch.
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
                  {sending ? 'Sending…' : 'Fix with agent'}
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
  // alive. `session_status` is "running" for the whole life of the PTY session —
  // including while the agent sits idle waiting for input — so gating on it
  // showed the "work in progress" warning even for a waiting/finished agent.
  // The activity status (running|waiting|finished|…) reflects what it's doing.
  const running = agent.agent_status?.status === 'running'
  const hasUncommitted = diff?.uncommitted_changes ?? false

  const handleClick = () => {
    // A running session is the headline caution (merging shifts files under
    // active work); it takes precedence over the uncommitted-changes note, the
    // way the merge dialog prioritises its parent-running warning.
    const note = running
      ? 'An agent session is running — merging now may collide with work in progress.'
      : hasUncommitted
        ? "This branch has uncommitted changes — the merge may fail or conflict until they're committed."
        : undefined

    useDialogStore.getState().show({
      // The updateBase panel builds its body from `details` (branch pills +
      // behind count); `message` is unused for this variant but kept non-empty
      // for the store contract.
      title: 'Update from base',
      message: `Update from ${baseBranch}`,
      type: note ? 'warning' : 'confirm',
      variant: 'updateBase',
      details: { fromBranch: baseBranch ?? '—', toBranch: agent.branch_name ?? '—', behind, note },
      onConfirm: async () => {
        setUpdating(true)
        try {
          await api.default.updateAgentFromBase(projectId ?? '', agent.id)
          onUpdated()
        } catch (err) {
          const body = apiErrorBody(err)
          if (body?.error === 'uncommitted_changes') {
            // The worktree has uncommitted changes the incoming base would overwrite
            // — not a content conflict. Name the files and ask the user to commit/stash.
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

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children: TreeNode[]
  file?: DiffFile
}

export function buildFileTree(files: DiffFile[]): TreeNode[] {
  const root: TreeNode[] = []
  for (const file of files) {
    const parts = file.path.split('/')
    let current = root
    for (let i = 0; i < parts.length - 1; i++) {
      let node = current.find((n) => n.type === 'dir' && n.name === parts[i])
      if (!node) {
        node = { name: parts[i], path: parts.slice(0, i + 1).join('/'), type: 'dir', children: [] }
        current.push(node)
      }
      current = node.children
    }
    current.push({ name: parts[parts.length - 1], path: file.path, type: 'file', children: [], file })
  }
  return root
}

// compactTree merges chains of single-child directories into one node, the way
// VS Code's "compact folders" does: one/two/three renders on a single row when
// `one` contains only `two` and `two` contains only `three`. This trims the
// horizontal indent that deeply nested trees would otherwise waste.
//
// A directory is folded into its child only when that child is its *sole* entry
// and is itself a directory — so a folder holding a file (or more than one
// child) stops the chain. The merged node keeps the deepest folder's `path`
// (stable, unique → safe as a collapse-state / React key) and joins the segment
// names for display.
export function compactTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.type !== 'dir') return node
    let current = node
    const names = [node.name]
    while (current.children.length === 1 && current.children[0].type === 'dir') {
      current = current.children[0]
      names.push(current.name)
    }
    return { ...current, name: names.join('/'), children: compactTree(current.children) }
  })
}

export function getGroupedFiles(files: DiffFile[]): [string, DiffFile[]][] {
  const map = new Map<string, DiffFile[]>()
  for (const file of files) {
    const parts = file.path.split('/')
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
    if (!map.has(folder)) map.set(folder, [])
    map.get(folder)!.push(file)
  }
  return Array.from(map.entries())
}

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
        <span className="font-mono text-[10px] truncate flex-1 min-w-0 text-gray-700 dark:text-gray-300">
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
          <span className="font-mono text-[10px] text-gray-600 dark:text-gray-400 flex-1 min-w-0 truncate">{node.name}</span>
          <ChevronDown className={`w-3 h-3 text-gray-400 shrink-0 transition-transform ${isOpen ? '' : '-rotate-90'}`} />
        </button>
        {isOpen && node.children.map((child) => (
          <TreeNodeView key={child.path} node={child} depth={depth + 1}
            collapsedFolders={collapsedFolders} toggleFolder={toggleFolder}
            onFileClick={onFileClick} activeFilePath={activeFilePath} />
        ))}
      </div>
    )
  }
  return (
    <FileRow file={node.file!} isActive={node.file!.path === activeFilePath}
      onClick={() => onFileClick(node.file!.path)} indent={indent} />
  )
}

// ── Settings popup ────────────────────────────────────────────────────────────

function SettingsPopup({ fileView, onFileViewChange, sideBySide, onSideBySideChange,
  ignoreWhitespace, onIgnoreWhitespaceChange, singleFile, onSingleFileChange,
  imageDiffMode, onImageDiffModeChange, artifactScale, onArtifactScaleChange }: {
    fileView: FileView; onFileViewChange: (v: FileView) => void
    sideBySide: boolean; onSideBySideChange: (v: boolean) => void
    ignoreWhitespace: boolean; onIgnoreWhitespaceChange: (v: boolean) => void
    singleFile: boolean; onSingleFileChange: (v: boolean) => void
    imageDiffMode: ImageDiffMode; onImageDiffModeChange: (v: ImageDiffMode) => void
    artifactScale: number; onArtifactScaleChange: (v: number) => void
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

  const viewOptions: { value: FileView; label: string }[] = [
    { value: 'tree', label: 'Tree' },
    { value: 'flat', label: 'Flat list' },
    { value: 'grouped', label: 'Grouped by folder' },
  ]

  return (
    <div ref={ref} className="relative">
      <Tooltip content="Settings">
        <button
          onClick={() => setOpen((o) => !o)}
          className={`flex items-center justify-center w-7 h-7 rounded-md border transition-colors cursor-pointer ${open ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
            : 'text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
            }`}
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </Tooltip>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-52 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 p-3">
          <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 tracking-wide mb-2">File List</p>
          <div className="flex flex-col gap-0.5 mb-3">
            {viewOptions.map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input type="radio" name="hydra-file-view" checked={fileView === opt.value}
                  onChange={() => onFileViewChange(opt.value)} className="w-3 h-3 accent-blue-500" />
                <span className="text-xs text-gray-700 dark:text-gray-300">{opt.label}</span>
              </label>
            ))}
          </div>
          <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 tracking-wide mb-2">Options</p>
          <div className="flex flex-col gap-0.5">
            {[
              { checked: sideBySide, onChange: onSideBySideChange, label: 'Side by side' },
              { checked: ignoreWhitespace, onChange: onIgnoreWhitespaceChange, label: 'Ignore whitespace' },
              { checked: singleFile, onChange: onSingleFileChange, label: 'One file at a time' },
            ].map(({ checked, onChange, label }) => (
              <label key={label} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
                  className="w-3 h-3 accent-blue-500" />
                <span className="text-xs text-gray-700 dark:text-gray-300">{label}</span>
              </label>
            ))}
          </div>
          <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 tracking-wide mt-3 mb-2">Artifact Diff</p>
          <div className="flex flex-col gap-0.5">
            {IMAGE_DIFF_MODES.map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input type="radio" name="hydra-image-diff-mode" checked={imageDiffMode === opt.value}
                  onChange={() => onImageDiffModeChange(opt.value)} className="w-3 h-3 accent-blue-500" />
                <span className="text-xs text-gray-700 dark:text-gray-300">{opt.label}</span>
              </label>
            ))}
          </div>
          {/* The artifact grid sizes each tile automatically by aspect ratio (a
              wide desktop shot spans more columns than a tall phone shot); this
              slider scales every tile up or down from there, drag a tile (or its
              edge) to override one, double-click the edge to auto-size. */}
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 tracking-wide shrink-0">Size</span>
            <input
              type="range" min={0.5} max={2} step={0.25} value={artifactScale}
              onChange={(e) => onArtifactScaleChange(Number(e.target.value))}
              className="flex-1 accent-blue-500 cursor-pointer"
              title="Scale every artifact tile up or down"
            />
            <span className="text-[10px] tabular-nums text-gray-400 dark:text-gray-500 w-8 text-right shrink-0">{Math.round(artifactScale * 100)}%</span>
          </div>
          <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1 leading-snug">Tiles auto-size by shape — drag a tile to resize it.</p>
        </div>
      )}
    </div>
  )
}

// ── Main DiffViewer component ─────────────────────────────────────────────────

export function DiffViewer({ agent, projectId, externalRefreshTrigger, externalArtifactRefresh }: { agent: AgentResponse; projectId: string | null; externalRefreshTrigger?: number; externalArtifactRefresh?: number }) {
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [leftSel, setLeftSel] = useState<LeftSel>({ type: 'base' })
  const [rightSel, setRightSel] = useState<RightSel>({ type: 'latest' })
  const [diff, setDiff] = useState<DiffResponse | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const [sideBySide, setSideBySide] = useState(() => readLocal(StorageKeys.diffSideBySide) === 'true')
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(() => readLocal(StorageKeys.diffIgnoreWhitespace) === 'true')
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
  // tile so they all flip / highlight together (keyboard B / H — see ArtifactsPanel).
  const [artifactView, setArtifactView] = useState<'before' | 'after'>(() => (readLocal(StorageKeys.diffArtifactView) === 'before' ? 'before' : 'after'))
  const [artifactHighlight, setArtifactHighlight] = useState<boolean>(() => readLocal(StorageKeys.diffArtifactHighlight) === 'true')
  // Artifact masonry layout — per-tile span overrides (dragging a tile's edge);
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
  useEffect(() => { writeLocal(StorageKeys.diffSingleFile, String(singleFile)) }, [singleFile])
  useEffect(() => { writeLocal(StorageKeys.diffFileView, fileView) }, [fileView])
  useEffect(() => { writeLocal(StorageKeys.diffSidebarWidth, String(sidebarWidth)) }, [sidebarWidth])
  useEffect(() => { writeLocal(StorageKeys.diffImageMode, imageDiffMode) }, [imageDiffMode])
  useEffect(() => { writeLocal(StorageKeys.diffArtifactScale, String(artifactScale)) }, [artifactScale])
  useEffect(() => { writeLocal(StorageKeys.diffArtifactView, artifactView) }, [artifactView])
  useEffect(() => { writeLocal(StorageKeys.diffArtifactHighlight, String(artifactHighlight)) }, [artifactHighlight])

  // DiffViewer is remounted on every agent switch (the route keys the whole
  // AgentDetail subtree by project+agent), so the collapsed-file set and the
  // commit selectors initialise fresh from this agent's prefs above — no
  // hand-reset on an agent-id change is needed.
  useEffect(() => {
    patchAgentViewPrefs(projectId, agent.id, { collapsedFiles: [...collapsedFiles] })
  }, [projectId, agent.id, collapsedFiles])

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

      // Select by path rather than [0] — the backend may return more than the
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
  }, [agent.id, projectId, leftSel, rightSel, ignoreWhitespace])

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
      const sig = JSON.stringify(f)
      nextSig.set(f.path, sig)
      if (prevSig.get(f.path) === sig) {
        // Identical content — reuse the existing object so its FileDiff (memo)
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
  // side reads the head ref, or — when the right side is the worktree
  // (head_ref === "", i.e. an uncommitted/untracked change) — the worktree file
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
  // it wraps to multiple rows on narrow widths — so measure it and publish it as a
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
  // silent fetch is still in flight has to be serviced once that fetch finishes —
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

      // Refresh commits list silently — but only push it into state when it actually
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

      // Fetch full diff silently — preserves open comments since we diff against previous state.
      const diffP = api.default.getAgentDiff(projectId ?? '', agent.id,
        params.baseRef, params.headRef, params.ignoreWhitespace, params.includeUncommitted, undefined, 3, true, HIDDEN_FILE_THRESHOLD, FULL_MAX_LINES)
        .then((d) => {
          // Defer applying while the user is selecting text — otherwise the re-render
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
        // A newer trigger arrived while we were fetching — service it now.
        if (latestTriggerRef.current !== servicing) run()
      })
    }
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalRefreshTrigger])

  const handleLeftChange = useCallback((newLeft: LeftSel) => {
    setLeftSel(newLeft)
  }, [])

  useEffect(() => {
    // left='latest' and right='latest' is invalid — switch right to uncommitted
    if (leftSel.type === 'latest' && rightSel.type === 'latest') {
      setRightSel({ type: 'uncommitted' }); return
    }
    if (leftSel.type !== 'commit' || rightSel.type !== 'commit') return
    const li = commitIdx(leftSel.sha, commits)
    const ri = commitIdx(rightSel.sha, commits)
    if (li !== -1 && ri !== -1 && li <= ri) setRightSel({ type: 'latest' })
  }, [leftSel, rightSel, commits])

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
  // would be a fresh function identity on every render, breaking FileDiff's memo() —
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
    fileRefs.current.get(path)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const handleFileClick = useCallback((path: string) => {
    if (singleFile && diff) {
      const idx = diff.files.findIndex((f) => f.path === path)
      if (idx >= 0) setSingleFileIdx(idx)
    } else {
      if (collapsedFiles.has(path)) toggleFileCollapse(path)
      setTimeout(() => scrollToFile(path), 50)
    }
  }, [singleFile, diff, scrollToFile, collapsedFiles, toggleFileCollapse])

  const handleSingleFileChange = useCallback((v: boolean) => {
    setSingleFile(v); setSingleFileIdx(0)
  }, [])

  const handleJumpToUncommittedActual = useCallback(() => {
    setLeftSel({ type: 'latest' })
    setRightSel({ type: 'uncommitted' })
  }, [])

  const [commentSent, setCommentSent] = useState(false)

  // Latest-value refs so handleComment (passed to every FileDiff) keeps a stable
  // identity across silent refreshes. Depending on diff/commits/sel directly would
  // give it a new identity on each refresh and re-render every FileDiff, defeating
  // their memo() — the main cost behind the agent-view jank.
  const diffRef = useRef(diff)
  diffRef.current = diff
  const leftSelRef = useRef(leftSel)
  leftSelRef.current = leftSel
  const rightSelRef = useRef(rightSel)
  rightSelRef.current = rightSel

  const handleComment = useCallback(async (path: string, lineNum: number, isNew: boolean, text: string) => {
    const leftSel = leftSelRef.current
    const rightSel = rightSelRef.current
    const commits = commitsRef.current
    const diff = diffRef.current
    const fromLabel = leftSel.type === 'base'
      ? agent.base_branch
      : leftSel.type === 'latest'
        ? (commits[0]?.short_sha ? `HEAD (${commits[0].short_sha})` : 'HEAD')
        : (commits.find(c => c.sha === leftSel.sha)?.short_sha ?? leftSel.sha.slice(0, 8))
    const toLabel = rightSel.type === 'latest' ? 'latest commit'
      : rightSel.type === 'uncommitted' ? 'uncommitted changes'
        : (commits.find(c => c.sha === rightSel.sha)?.short_sha ?? rightSel.sha.slice(0, 8))

    // Find hunk containing this line and build surrounding context
    const file = diff?.files.find(f => f.path === path)
    const hunk = file?.hunks?.find(h =>
      h.lines.some(l => isNew ? l.new_line_num === lineNum : l.old_line_num === lineNum)
    )

    let msg = `Comment on \`${path}\` line ${lineNum} (marked with \`>\`) (diff: ${fromLabel} -> ${toLabel})\n`
    if (hunk) {
      const targetIdx = hunk.lines.findIndex(l => isNew ? l.new_line_num === lineNum : l.old_line_num === lineNum)
      if (targetIdx >= 0) {
        const start = Math.max(0, targetIdx - 3)
        const end = Math.min(hunk.lines.length, targetIdx + 4)
        const ctxLines = hunk.lines.slice(start, end)
        msg += `\n\`\`\`diff\n# ${path}\n${hunk.header}\n`
        msg += ctxLines.map((l, i) => {
          const typeChar = l.type === 'addition' ? '+' : l.type === 'deletion' ? '-' : ' '
          // The commented line keeps its +/-/space marker but uses '>' instead of
          // '|' so the agent can see both the line's kind and which line we mean.
          if (start + i === targetIdx) return typeChar + '>' + l.content
          return typeChar + '|' + l.content
        }).join('\n')
        msg += `\n\`\`\`\n`
      }
    }
    msg += `\nComment:\n${text}`

    try {
      await api.default.sendAgentInput(projectId ?? '', agent.id, { text: msg })
      setCommentSent(true)
      setTimeout(() => setCommentSent(false), 3000)
    } catch (e) {
      console.error('Failed to send comment:', e)
    }
  }, [agent.id, agent.base_branch, projectId])

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

  return (
    // --sticky-changes-h (the measured Changes-toolbar height) is published here so
    // the artifacts filter bar and card headers below can dock flush beneath it even
    // when the toolbar wraps. See the ResizeObserver above.
    <div ref={rootRef} className="mt-4" style={{ '--sticky-changes-h': `${changesBarH}px` } as CSSProperties}>
      {/* Section header */}
      {/* -top-4 cancels the scroll container's pt-4 (AgentDetail) so the stuck
          header docks flush under the top bar — no overlap (was -top-6) and no
          gap for the artifacts filter bar to peek through (was top-0).
          z-[25] keeps it above the diff rows and the sticky file-list panel
          (z-20) while staying *below* the sidebar overlay backdrop (z-30 in
          __root.tsx) — at equal z-index the later-DOM bar would paint over the
          scrim and stay bright when the off-canvas sidebar is open on
          tablet/phone. */}
      <div ref={changesBarRef} className="flex items-center gap-3 mb-6 flex-wrap sticky -top-4 z-[25] bg-gray-50 dark:bg-gray-900 py-2 border-b border-gray-200 dark:border-gray-800 shadow-sm -mx-1.5 sm:-mx-3 px-1.5 sm:px-3">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Changes</h2>
        {diff && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-green-600 dark:text-green-400 font-medium">+{totalAdditions}</span>
            <span className="text-xs text-red-600 dark:text-red-400 font-medium">-{totalDeletions}</span>
            <span className="text-xs text-gray-400 dark:text-gray-500">in {diff.files.length} file{diff.files.length !== 1 ? 's' : ''}</span>
          </div>
        )}

        <LeftSelector commits={commits} selected={leftSel} onChange={handleLeftChange} baseBranch={agent.base_branch} rightSel={rightSel} />
        <span className="text-gray-400 dark:text-gray-500 text-xs select-none"><MoveRight className='w-6 h-6' strokeWidth='1.5' /></span>
        <RightSelector commits={commits} selected={rightSel} onChange={setRightSel}
          left={leftSel} hasUncommitted={diff?.uncommitted_changes} />

        {!(leftSel.type === 'base' && rightSel.type === 'latest') && (
          <Tooltip content="Reset to base → latest">
            <button
              onClick={() => { setLeftSel({ type: 'base' }); setRightSel({ type: 'latest' }) }}
              className="flex items-center justify-center w-7 h-7 rounded-md text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </Tooltip>
        )}

        {/* Uncommitted changes warning button */}
        <UncommittedButton diff={diff} onJumpToUncommitted={handleJumpToUncommittedActual} />

        {/* Merge conflict button */}
        <MergeConflictButton diff={diff} agent={agent} projectId={projectId} />

        {/* Branch out-of-date (behind base) warning + update button */}
        <BehindBaseButton diff={diff} agent={agent} projectId={projectId} onUpdated={() => setRefreshKey((k) => k + 1)} />

        <div className="flex items-center gap-2 ml-auto shrink-0">
          {loadingDiff && hasExistingDiff && (
            <LoaderCircle className="w-3.5 h-3.5 animate-spin text-gray-400 dark:text-gray-500 shrink-0" />
          )}

          <Tooltip content="Refresh">
            <button
              onClick={() => setRefreshKey((k) => k + 1)}
              disabled={loadingDiff}
              className="flex items-center justify-center w-7 h-7 rounded-md text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </Tooltip>

          <SettingsPopup
            fileView={fileView} onFileViewChange={setFileView}
            sideBySide={sideBySide} onSideBySideChange={setSideBySide}
            ignoreWhitespace={ignoreWhitespace} onIgnoreWhitespaceChange={setIgnoreWhitespace}
            singleFile={singleFile} onSingleFileChange={handleSingleFileChange}
            imageDiffMode={imageDiffMode} onImageDiffModeChange={setImageDiffMode}
            artifactScale={artifactScale} onArtifactScaleChange={setArtifactScale}
          />
        </div>
      </div>

      {/* Test verdicts (PLAN #68) for the selected versions — single-sided, so it
          tracks the "after" commit (latest by default) like the artifacts below,
          and sits just under the Changes header. Renders nothing when the project
          configures no [[tests]] runners. */}
      {agent.branch_name && projectId && (
        <TestsPanel
          projectId={projectId}
          agentId={agent.id}
          headRef={artifactParams.headRef}
          includeUncommitted={artifactParams.includeUncommitted}
          refreshKey={refreshKey + (externalArtifactRefresh ?? 0)}
        />
      )}

      {/* Error banner on refresh failure */}
      {diffError && hasExistingDiff && (
        <div className="mb-3 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400">
          Refresh failed: {diffError}
        </div>
      )}

      {/* Visual artifacts (e.g. screenshots) for the selected versions */}
      {agent.branch_name && (
        <ArtifactsPanel
          projectId={projectId}
          agentId={agent.id}
          baseRef={artifactParams.baseRef}
          headRef={artifactParams.headRef}
          includeUncommitted={artifactParams.includeUncommitted}
          // Re-snapshot artifacts on the manual refresh button (refreshKey) AND
          // when a commit is auto-detected (externalArtifactRefresh). Both only
          // ever increment, so their sum strictly increases on either trigger,
          // re-running ArtifactsPanel's effect to re-request — a cache hit when
          // the resolved commit SHA is unchanged, a regen when it moved. The
          // diff text itself updates silently via externalRefreshTrigger, so we
          // deliberately keep this out of the diff-loading effects (which would
          // flash a loading spinner and reset the user's selection).
          refreshKey={refreshKey + (externalArtifactRefresh ?? 0)}
          imageDiffMode={imageDiffMode}
          artifactScale={artifactScale}
          artifactView={artifactView}
          onArtifactViewChange={setArtifactView}
          artifactHighlight={artifactHighlight}
          onArtifactHighlightChange={setArtifactHighlight}
          artifactSpans={artifactSpans}
          onArtifactSpanChange={setArtifactSpanOverride}
        />
      )}

      {/* Content */}
      {!hasExistingDiff && loadingDiff ? (
        <div className="flex items-center justify-center py-8 text-gray-400 dark:text-gray-500">
          <LoaderCircle className="w-4 h-4 animate-spin mr-2" />
          <span className="text-sm">Loading diff…</span>
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
        <div className={`flex gap-4 min-h-0 transition-opacity duration-150 ${loadingDiff ? 'opacity-40 pointer-events-none' : ''}`}>
          {/* File list sidebar (hidden on mobile — the diff content takes the full
              width there; files are still all rendered below, or reachable via the
              prev/next pager in single-file mode) */}
          <div
            ref={sidebarRef}
            className="hidden md:flex shrink-0 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-gray-800 self-start sticky z-20 flex-col shadow-sm"
            style={{ width: sidebarWidth, top: FILE_STICKY_TOP }}
          >
            <div className="px-2.5 py-2 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex items-center justify-between">
              <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 truncate">
                Files · {diff.files.length}
              </span>
            </div>
            <div className="overflow-y-auto max-h-[calc(100vh-140px)]">{renderSidebar(diff.files)}</div>
            {/* Resize handle */}
            <div
              onMouseDown={startResizing}
              className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-500/30 transition-colors z-20"
            />
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
                    onClick={() => setSingleFileIdx(Math.max(0, singleFileIdx - 1))}
                    disabled={singleFileIdx === 0}
                    className="flex items-center justify-center w-7 h-7 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors shadow-sm"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 text-xs text-gray-500 dark:text-gray-400 shadow-sm font-medium">
                    {singleFileIdx + 1} / {diff.files.length}
                  </div>
                  <button
                    onClick={() => setSingleFileIdx(Math.min(diff.files.length - 1, singleFileIdx + 1))}
                    disabled={singleFileIdx === diff.files.length - 1}
                    className="flex items-center justify-center w-7 h-7 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors shadow-sm"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
                <FileDiff
                  key={diff.files[singleFileIdx]?.path}
                  file={diff.files[singleFileIdx]!}
                  sideBySide={sideBySide}
                  isCollapsed={collapsedFiles.has(diff.files[singleFileIdx].path)}
                  onToggleCollapse={toggleFileCollapse}
                  onComment={handleComment}
                  onExpand={expandFileDiff}
                  isHidden={hiddenFiles.has(diff.files[singleFileIdx].path)}
                  onShow={getShowCallback(diff.files[singleFileIdx].path)}
                  fileRef={getFileRef(diff.files[singleFileIdx].path)}
                  currentContext={fileContexts.get(diff.files[singleFileIdx].path) ?? 3}
                  imageDiffMode={imageDiffMode}
                  imageBefore={imageUrlsFor(diff.files[singleFileIdx]).before}
                  imageAfter={imageUrlsFor(diff.files[singleFileIdx]).after}
                />
              </>
            ) : (
              diff.files.map((f) => {
                const img = imageUrlsFor(f)
                return (
                <FileDiff key={f.path} file={f} sideBySide={sideBySide}
                  isCollapsed={collapsedFiles.has(f.path)}
                  onToggleCollapse={toggleFileCollapse}
                  onComment={handleComment}
                  onExpand={expandFileDiff}
                  isHidden={hiddenFiles.has(f.path)}
                  onShow={getShowCallback(f.path)}
                  fileRef={getFileRef(f.path)}
                  currentContext={fileContexts.get(f.path) ?? 3}
                  imageDiffMode={imageDiffMode}
                  imageBefore={img.before}
                  imageAfter={img.after}
                />
                )
              })
            )}
          </div>
        </div>
      ) : null}
      {isResizing && <div className="fixed inset-0 z-[100] cursor-col-resize" />}
      {commentSent && (
        <div className="fixed bottom-4 right-4 z-[500] flex items-center gap-2 px-3 py-2 bg-green-600 text-white text-xs font-semibold rounded-lg shadow-lg pointer-events-none">
          <Check className="w-3.5 h-3.5" />
          Comment sent to agent
        </div>
      )}
    </div>
  )
}
