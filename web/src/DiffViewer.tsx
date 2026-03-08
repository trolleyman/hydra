import { useEffect, useRef, useState, useCallback } from 'react'
import hljs from 'highlight.js'
import { api } from './stores/apiClient'
import type { AgentResponse, CommitInfo, DiffFile, DiffResponse } from './api'
import {
  Plus, Calendar, TriangleAlert,
  ChevronDown, ChevronRight, ChevronLeft, Check, LoaderCircle, RefreshCw,
  Settings, Copy, Folder, FolderOpen, X, GitMerge, Bot,
  MoveRight,
} from 'lucide-react'

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

function splitHighlightedLines(html: string): string[] {
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

function highlightCode(code: string, language: string): string[] {
  try {
    const result = hljs.highlight(code, { language, ignoreIllegals: true })
    return splitHighlightedLines(result.value)
  } catch {
    return code.split('\n').map((l) =>
      l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    )
  }
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

function ChangeTypeIcon({ type }: { type: string }) {
  switch (type) {
    case 'added': return <Plus className="w-3.5 h-3.5 text-green-500 shrink-0" />
    case 'deleted': return <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0"><div className="w-2.5 h-0.5 bg-red-500 rounded-full" /></div>
    case 'renamed': return <GitMerge className="w-3.5 h-3.5 text-blue-500 shrink-0" />
    default: return <div className="w-3.5 h-3.5 rounded-full bg-yellow-500 shrink-0" />
  }
}

function buildSideBySide(hunkLines: DiffFile['hunks'][0]['lines']): SideBySideLine[] {
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
    <button
      onClick={handleCopy}
      className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 shrink-0 cursor-pointer transition-colors"
      title="Copy path"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5 text-gray-400" />}
    </button>
  )
}

function CommentButton({ onComment }: { onComment: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { if (open && ref.current) ref.current.focus() }, [open])

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-all cursor-pointer absolute left-0 -ml-3 z-20"
        title="Add comment"
      >
        <Plus className="w-3 h-3 text-blue-500" />
      </button>
    )
  }

  return (
    <div className="absolute left-10 right-10 z-30 mt-1 p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full h-20 p-2 text-xs font-sans bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded focus:ring-1 focus:ring-blue-500 outline-none resize-none"
        placeholder="Write a comment..."
      />
      <div className="flex justify-end gap-2 mt-2">
        <button
          onClick={() => { setOpen(false); setText('') }}
          className="px-2 py-1 text-[10px] font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          disabled={!text.trim() || sending}
          onClick={async () => {
            setSending(true)
            await onComment(text)
            setSending(false)
            setOpen(false)
            setText('')
          }}
          className="px-2 py-1 text-[10px] font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded transition-colors cursor-pointer"
        >
          {sending ? 'Sending...' : 'Send'}
        </button>
      </div>
    </div>
  )
}

function HunkHeader({ header, onExpandUp, onExpandBoth, onExpandDown }: {
  header: string; onExpandUp?: () => void; onExpandBoth?: () => void; onExpandDown?: () => void
}) {
  return (
    <div className="flex items-center bg-blue-50 dark:bg-blue-950/30 border-y border-blue-100 dark:border-blue-900/50 px-2 py-0.5 group/hunk">
      <div className="flex items-center gap-0.5 mr-2 opacity-0 group-hover/hunk:opacity-100 transition-opacity">
        <button onClick={onExpandUp} className="p-0.5 rounded hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-500 cursor-pointer" title="Expand up 5 lines">
          <ChevronDown className="w-3 h-3 rotate-180" />
        </button>
        <button onClick={onExpandBoth} className="p-0.5 rounded hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-500 cursor-pointer" title="Expand 5 lines">
          <div className="relative w-3 h-3 flex flex-col items-center justify-center">
            <ChevronDown className="w-2 h-2 rotate-180 absolute top-0" />
            <ChevronDown className="w-2 h-2 absolute bottom-0" />
          </div>
        </button>
        <button onClick={onExpandDown} className="p-0.5 rounded hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-500 cursor-pointer" title="Expand down 5 lines">
          <ChevronDown className="w-3 h-3" />
        </button>
      </div>
      <span className="font-mono text-xs text-blue-500 dark:text-blue-400">{header}</span>
    </div>
  )
}

// ── Diff Hunk rendering ───────────────────────────────────────────────────────

const UNIFIED_LINE_NUM_CLASS = 'select-none text-right pr-2 text-gray-400 dark:text-gray-600 text-xs font-mono w-10 shrink-0 border-r border-gray-200 dark:border-gray-700 leading-5'
const UNIFIED_CODE_CLASS = 'pl-2 font-mono text-xs leading-5 flex-1 whitespace-pre-wrap break-words overflow-hidden'

function UnifiedHunk({ hunk, highlightedOld, highlightedNew, onComment, expanders }: {
  hunk: DiffFile['hunks'][0]
  highlightedOld: Map<number, string>
  highlightedNew: Map<number, string>
  onComment: (lineNum: number, isNew: boolean, text: string) => void
  expanders: { up: () => void; both: () => void; down: () => void }
}) {
  return (
    <div>
      <HunkHeader header={hunk.header} onExpandUp={expanders.up} onExpandBoth={expanders.both} onExpandDown={expanders.down} />
      {hunk.lines.map((line, idx) => {
        const isAdd = line.type === 'addition'
        const isDel = line.type === 'deletion'
        const isNoNewline = line.type === 'no_newline'
        const highlighted = isAdd
          ? (line.new_line_num != null ? highlightedNew.get(line.new_line_num) : undefined)
          : (line.old_line_num != null ? highlightedOld.get(line.old_line_num) : undefined)
        const bgClass = isAdd ? 'bg-green-50 dark:bg-green-950/30' : isDel ? 'bg-red-50 dark:bg-red-950/30' : ''
        return (
          <div key={idx} className={`flex items-stretch hover:brightness-95 dark:hover:brightness-110 relative group ${bgClass}`}>
            <span className={UNIFIED_LINE_NUM_CLASS}>{line.old_line_num ?? ''}</span>
            <span className={UNIFIED_LINE_NUM_CLASS}>{line.new_line_num ?? ''}</span>
            <span className={`select-none font-mono text-xs leading-5 w-4 text-center shrink-0 ${isAdd ? 'text-green-600 dark:text-green-400' : isDel ? 'text-red-600 dark:text-red-400' : 'text-gray-300 dark:text-gray-700'
              }`}>
              {isAdd ? '+' : isDel ? '-' : isNoNewline ? '\\' : ' '}
            </span>
            {!isNoNewline && (
              <CommentButton onComment={(text) => onComment(isAdd ? line.new_line_num! : line.old_line_num!, isAdd || line.type === 'context', text)} />
            )}
            {isNoNewline ? (
              <span className={`${UNIFIED_CODE_CLASS} text-gray-400 dark:text-gray-500 italic`}>{line.content}</span>
            ) : highlighted ? (
              <span className={UNIFIED_CODE_CLASS} dangerouslySetInnerHTML={{ __html: highlighted }} />
            ) : (
              <span className={UNIFIED_CODE_CLASS}>{line.content}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

const SBS_LINE_NUM = 'select-none text-right text-gray-400 dark:text-gray-600 text-xs font-mono w-8 shrink-0 pr-1 leading-5'
const SBS_CODE = 'pl-1 font-mono text-xs leading-5 flex-1 whitespace-pre-wrap break-words overflow-hidden min-w-0'

function SideBySideHunk({ hunk, highlightedOld, highlightedNew, onComment, expanders }: {
  hunk: DiffFile['hunks'][0]
  highlightedOld: Map<number, string>
  highlightedNew: Map<number, string>
  onComment: (lineNum: number, isNew: boolean, text: string) => void
  expanders: { up: () => void; both: () => void; down: () => void }
}) {
  const sbsLines = buildSideBySide(hunk.lines)
  return (
    <div>
      <HunkHeader header={hunk.header} onExpandUp={expanders.up} onExpandBoth={expanders.both} onExpandDown={expanders.down} />
      {sbsLines.map((line, idx) => {
        const oldHighlighted = line.oldLineNum != null ? highlightedOld.get(line.oldLineNum) : undefined
        const newHighlighted = line.newLineNum != null ? highlightedNew.get(line.newLineNum) : undefined
        const oldBg = line.oldType === 'deletion' ? 'bg-red-50 dark:bg-red-950/30' : line.oldType === 'empty' ? 'bg-gray-50 dark:bg-gray-900/50' : ''
        const newBg = line.newType === 'addition' ? 'bg-green-50 dark:bg-green-950/30' : line.newType === 'empty' ? 'bg-gray-50 dark:bg-gray-900/50' : ''
        return (
          <div key={idx} className="flex items-stretch divide-x divide-gray-200 dark:divide-gray-700">
            <div className={`flex items-start flex-1 min-w-0 group relative ${oldBg}`}>
              <span className={SBS_LINE_NUM}>{line.oldLineNum ?? ''}</span>
              <span className={`select-none font-mono text-xs w-3 shrink-0 text-center leading-5 ${line.oldType === 'deletion' ? 'text-red-500' : 'text-gray-300 dark:text-gray-700'}`}>
                {line.oldType === 'deletion' ? '-' : line.oldType === 'empty' ? '' : ' '}
              </span>
              {line.oldLineNum != null && <CommentButton onComment={(text) => onComment(line.oldLineNum!, false, text)} />}
              {line.oldContent != null && oldHighlighted
                ? <span className={SBS_CODE} dangerouslySetInnerHTML={{ __html: oldHighlighted }} />
                : <span className={SBS_CODE}>{line.oldContent ?? ''}</span>
              }
            </div>
            <div className={`flex items-start flex-1 min-w-0 group relative ${newBg}`}>
              <span className={SBS_LINE_NUM}>{line.newLineNum ?? ''}</span>
              <span className={`select-none font-mono text-xs w-3 shrink-0 text-center leading-5 ${line.newType === 'addition' ? 'text-green-500' : 'text-gray-300 dark:text-gray-700'}`}>
                {line.newType === 'addition' ? '+' : line.newType === 'empty' ? '' : ' '}
              </span>
              {line.newLineNum != null && <CommentButton onComment={(text) => onComment(line.newLineNum!, true, text)} />}
              {line.newContent != null && newHighlighted
                ? <span className={SBS_CODE} dangerouslySetInnerHTML={{ __html: newHighlighted }} />
                : <span className={SBS_CODE}>{line.newContent ?? ''}</span>
              }
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── File diff card ────────────────────────────────────────────────────────────

function FileDiff({ file, sideBySide, fileRef, onComment, isCollapsed, onToggleCollapse, onExpand, stickyTop = 52 }: {
  file: DiffFile
  sideBySide: boolean
  fileRef?: (el: HTMLDivElement | null) => void
  onComment: (path: string, lineNum: number, isNew: boolean, text: string) => void
  isCollapsed: boolean
  onToggleCollapse: () => void
  onExpand: (path: string, context: number) => void
  stickyTop?: number
}) {
  const [context, setContext] = useState(3)
  const lang = getLanguage(file.path)
  const { highlightedOld, highlightedNew } = (() => {
    if (file.binary || !file.hunks) return { highlightedOld: new Map<number, string>(), highlightedNew: new Map<number, string>() }
    const oldLines: Array<{ lineNum: number; content: string }> = []
    const newLines: Array<{ lineNum: number; content: string }> = []
    for (const hunk of file.hunks) {
      for (const l of hunk.lines) {
        if ((l.type === 'context' || l.type === 'deletion') && l.old_line_num != null)
          oldLines.push({ lineNum: l.old_line_num, content: l.content })
        if ((l.type === 'context' || l.type === 'addition') && l.new_line_num != null)
          newLines.push({ lineNum: l.new_line_num, content: l.content })
      }
    }
    const highlight = (lines: typeof oldLines): Map<number, string> => {
      if (lines.length === 0) return new Map()
      const highlighted = highlightCode(lines.map((l) => l.content).join('\n'), lang)
      const map = new Map<number, string>()
      lines.forEach((l, i) => { if (highlighted[i] !== undefined) map.set(l.lineNum, highlighted[i]) })
      return map
    }
    return { highlightedOld: highlight(oldLines), highlightedNew: highlight(newLines) }
  })()

  const handleExpand = (delta: number) => {
    const next = context + delta
    setContext(next)
    onExpand(file.path, next)
  }

  const displayPath = file.change_type === 'renamed' && file.old_path
    ? `${file.old_path} → ${file.path}` : file.path

  return (
    <div ref={fileRef} className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden mb-4 bg-white dark:bg-gray-900 shadow-sm">
      <div
        className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 sticky z-20"
        style={{ top: stickyTop }}
      >
        <button
          onClick={onToggleCollapse}
          className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 cursor-pointer transition-colors"
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
        </button>
        <ChangeTypeIcon type={file.change_type} />
        <span
          className="font-mono text-xs text-gray-700 dark:text-gray-300 flex-1 min-w-0 truncate cursor-pointer hover:underline"
          title={displayPath}
          onClick={onToggleCollapse}
        >
          {displayPath}
        </span>
        <CopyButton text={file.path} />
        {!file.binary && (
          <div className="flex items-center gap-1.5 shrink-0 ml-1">
            {file.additions > 0 && <span className="text-xs text-green-600 dark:text-green-400 font-medium">+{file.additions}</span>}
            {file.deletions > 0 && <span className="text-xs text-red-600 dark:text-red-400 font-medium">−{file.deletions}</span>}
          </div>
        )}
      </div>
      {!isCollapsed && (
        <>
          {file.binary ? (
            <div className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500 italic">Binary file changed</div>
          ) : !file.hunks || file.hunks.length === 0 ? (
            <div className="px-4 py-8 flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 italic">
              <div className="text-sm mb-2">No changes loaded</div>
              <button
                onClick={() => onExpand(file.path, 3)}
                className="px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md hover:bg-blue-100 dark:hover:bg-blue-900/40 cursor-pointer transition-colors"
              >
                Load diff
              </button>
            </div>
          ) : (
            <div className="overflow-hidden">
              {file.hunks.map((hunk, idx) =>
                sideBySide
                  ? <SideBySideHunk key={idx} hunk={hunk} highlightedOld={highlightedOld} highlightedNew={highlightedNew}
                    onComment={(ln, isNew, txt) => onComment(file.path, ln, isNew, txt)}
                    expanders={{ up: () => handleExpand(5), both: () => handleExpand(5), down: () => handleExpand(5) }} />
                  : <UnifiedHunk key={idx} hunk={hunk} highlightedOld={highlightedOld} highlightedNew={highlightedNew}
                    onComment={(ln, isNew, txt) => onComment(file.path, ln, isNew, txt)}
                    expanders={{ up: () => handleExpand(5), both: () => handleExpand(5), down: () => handleExpand(5) }} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Commit selector types & helpers ───────────────────────────────────────────

type LeftSel = { type: 'base' } | { type: 'commit'; sha: string }
type RightSel = { type: 'uncommitted' } | { type: 'latest' } | { type: 'commit'; sha: string }

function commitIdx(sha: string, commits: CommitInfo[]): number {
  return commits.findIndex((c) => c.sha === sha)
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

function Tooltip({ content, children, side = 'bottom' }: {
  content: React.ReactNode
  children: React.ReactNode
  side?: 'bottom' | 'right' | 'top' | 'left'
}) {
  const [visible, setVisible] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const show = useCallback(() => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      if (side === 'right') {
        setPos({ top: rect.top, left: rect.right + 8 })
      } else if (side === 'left') {
        setPos({ top: rect.top, left: rect.left - 8 })
      } else if (side === 'top') {
        setPos({ top: rect.top - 8, left: rect.left })
      } else {
        setPos({ top: rect.bottom + 6, left: rect.left })
      }
    }
    setVisible(true)
  }, [side])

  return (
    <div ref={ref} className="relative inline-flex w-full" onMouseEnter={show} onMouseLeave={() => setVisible(false)}>
      {children}
      {visible && pos && (
        <div
          className="fixed z-[200] bg-gray-900 dark:bg-gray-700 text-white text-xs rounded-lg px-3 py-2 shadow-xl max-w-sm pointer-events-none"
          style={{
            top: pos.top,
            left: pos.left,
            transform: side === 'left' ? 'translateX(-100%)' : side === 'top' ? 'translateY(-100%)' : undefined
          }}
        >
          {content}
        </div>
      )}
    </div>
  )
}

function CommitTooltipContent({ commit }: { commit: CommitInfo }) {
  return (
    <div className="font-mono space-y-0.5 min-w-[260px]">
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

function LeftSelector({ commits, selected, onChange, baseBranch }: {
  commits: CommitInfo[]
  selected: LeftSel
  onChange: (v: LeftSel) => void
  baseBranch: string
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
    : formatShortLabel(commits.find((c) => c.sha === selected.sha), selected.sha)

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
          <div className="py-1 border-b border-gray-100 dark:border-gray-700">
            <button
              onClick={() => { onChange({ type: 'base' }); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer ${selected.type === 'base' ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                }`}
            >
              <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              <span className="font-medium text-gray-800 dark:text-gray-200">{baseBranch}</span>
              <span className="text-gray-400 dark:text-gray-500 ml-auto text-[10px]">branch point</span>
              {selected.type === 'base' && <Check className="w-3 h-3 text-blue-500 shrink-0" />}
            </button>
          </div>
          {commits.length > 0 && (
            <div className="max-h-64 overflow-y-auto py-1">
              <p className="px-3 py-1 text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide font-medium">
                Commits ({commits.length})
              </p>
              {commits.map((c) => (
                <Tooltip key={c.sha} side="right" content={<CommitTooltipContent commit={c} />}>
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
                </Tooltip>
              ))}
            </div>
          )}
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
    const li = commitIdx(left.sha, commits)
    return li === -1 || idx < li
  })

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
              onClick={() => { onChange({ type: 'latest' }); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer ${selected.type === 'latest' ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                }`}
            >
              <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              <span className="font-medium text-gray-800 dark:text-gray-200">Latest commit</span>
              <span className="text-gray-400 dark:text-gray-500 ml-auto text-[10px]">HEAD</span>
              {selected.type === 'latest' && <Check className="w-3 h-3 text-blue-500 shrink-0" />}
            </button>
          </div>
          {validCommits.length > 0 && (
            <div className="max-h-64 overflow-y-auto py-1">
              <p className="px-3 py-1 text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide font-medium">
                Commits ({validCommits.length})
              </p>
              {validCommits.map((c) => (
                <Tooltip key={c.sha} side="right" content={<CommitTooltipContent commit={c} />}>
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
                </Tooltip>
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
    <Tooltip content={
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
  const [sent, setSent] = useState(false)

  if (!diff?.merge_conflict) return null

  const conflictFiles = diff.conflict_files ?? []
  const count = conflictFiles.length || '?'
  const worktreePath = agent.worktree_path ?? '<worktree-path>'
  const baseBranch = agent.base_branch

  const handleFixWithAgent = async () => {
    setSending(true)
    try {
      await api.default.sendAgentInput(agent.id, { text: `Fix the merge conflicts with branch ${baseBranch}` }, projectId ?? undefined)
      setSent(true)
      setTimeout(() => { setSent(false); setOpen(false) }, 2000)
    } catch {
      // silently ignore
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <Tooltip content={
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
          <GitMerge className="w-3.5 h-3.5 shrink-0" />
          <span>{count} conflict{count !== 1 ? 's' : ''}</span>
        </button>
      </Tooltip>

      {open && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />

          {/* Panel */}
          <div className="relative bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl w-full max-w-lg">
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <GitMerge className="w-4 h-4 text-red-500 shrink-0" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex-1">
                Merge Conflict — {count} file{count !== 1 ? 's' : ''} conflict with <span className="font-mono text-red-600 dark:text-red-400">{baseBranch}</span>
              </h3>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Conflicting files */}
            {conflictFiles.length > 0 && (
              <div className="px-4 pt-3 pb-1">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">Conflicting files</p>
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg overflow-hidden divide-y divide-gray-100 dark:divide-gray-700/50 max-h-32 overflow-y-auto">
                  {conflictFiles.map((f) => (
                    <div key={f} className="px-3 py-1.5 font-mono text-xs text-gray-700 dark:text-gray-300">{f}</div>
                  ))}
                </div>
              </div>
            )}

            {/* Resolution instructions */}
            <div className="px-4 py-3">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Resolving locally</p>
              <div className="bg-gray-900 dark:bg-gray-950 rounded-lg p-3 space-y-1.5 text-xs font-mono">
                <p className="text-gray-400"># Navigate to the agent's worktree</p>
                <p className="text-green-400">cd {worktreePath}</p>
                <p className="text-gray-400 mt-2"># Merge the base branch (triggers conflict markers)</p>
                <p className="text-green-400">git merge {baseBranch}</p>
                <p className="text-gray-400 mt-2"># Edit conflicting files, then stage and commit</p>
                <p className="text-green-400">git add {'<resolved-files>'}</p>
                <p className="text-green-400">git commit</p>
              </div>
              <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-2">
                The worktree at <span className="font-mono">{worktreePath}</span> is isolated — changes only affect this agent's branch.
              </p>
            </div>

            {/* Footer */}
            <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setOpen(false)}
                className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer"
              >
                Dismiss
              </button>
              <button
                onClick={handleFixWithAgent}
                disabled={sending || sent}
                className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 transition-colors cursor-pointer ml-auto"
              >
                {sent ? (
                  <><Check className="w-3.5 h-3.5" /> Sent to agent</>
                ) : sending ? (
                  <><LoaderCircle className="w-3.5 h-3.5 animate-spin" /> Sending…</>
                ) : (
                  <><Bot className="w-3.5 h-3.5" /> Fix with agent</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── File tree helpers ─────────────────────────────────────────────────────────

type FileView = 'tree' | 'flat' | 'grouped'

interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children: TreeNode[]
  file?: DiffFile
}

function buildFileTree(files: DiffFile[]): TreeNode[] {
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

function getGroupedFiles(files: DiffFile[]): [string, DiffFile[]][] {
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

function FileRow({ file, isActive, onClick, indent = 0 }: {
  file: DiffFile; isActive: boolean; onClick: () => void; indent?: number
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-1.5 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors group cursor-pointer ${isActive ? 'bg-blue-50 dark:bg-blue-900/20' : ''
        }`}
      style={{ paddingLeft: `${10 + indent}px`, paddingRight: '10px' }}
    >
      <ChangeTypeIcon type={file.change_type} />
      <span className="font-mono text-[10px] text-gray-700 dark:text-gray-300 truncate flex-1 min-w-0" title={file.path}>
        {file.path.split('/').pop()}
      </span>
      <div className="flex items-center gap-1 shrink-0">
        {file.additions > 0 && <span className="text-[10px] text-green-600 dark:text-green-400">+{file.additions}</span>}
        {file.deletions > 0 && <span className="text-[10px] text-red-600 dark:text-red-400">−{file.deletions}</span>}
      </div>
    </button>
  )
}

function TreeNodeView({ node, depth, collapsedFolders, toggleFolder, onFileClick, activeFilePath }: {
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
  ignoreWhitespace, onIgnoreWhitespaceChange, singleFile, onSingleFileChange }: {
    fileView: FileView; onFileViewChange: (v: FileView) => void
    sideBySide: boolean; onSideBySideChange: (v: boolean) => void
    ignoreWhitespace: boolean; onIgnoreWhitespaceChange: (v: boolean) => void
    singleFile: boolean; onSingleFileChange: (v: boolean) => void
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
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center justify-center w-7 h-7 rounded-md border transition-colors cursor-pointer ${open ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
          : 'text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
          }`}
        title="Diff settings"
      >
        <Settings className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-52 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 p-3">
          <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">File list</p>
          <div className="flex flex-col gap-0.5 mb-3">
            {viewOptions.map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input type="radio" name="hydra-file-view" checked={fileView === opt.value}
                  onChange={() => onFileViewChange(opt.value)} className="w-3 h-3 accent-blue-500" />
                <span className="text-xs text-gray-700 dark:text-gray-300">{opt.label}</span>
              </label>
            ))}
          </div>
          <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Options</p>
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
        </div>
      )}
    </div>
  )
}

// ── Main DiffViewer component ─────────────────────────────────────────────────

export function DiffViewer({ agent, projectId }: { agent: AgentResponse; projectId: string | null }) {
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [leftSel, setLeftSel] = useState<LeftSel>({ type: 'base' })
  const [rightSel, setRightSel] = useState<RightSel>({ type: 'latest' })
  const [diff, setDiff] = useState<DiffResponse | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const [sideBySide, setSideBySide] = useState(() => {
    try { return localStorage.getItem('hydra-diff-side-by-side') === 'true' } catch { return false }
  })
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(() => {
    try { return localStorage.getItem('hydra-diff-ignore-whitespace') === 'true' } catch { return false }
  })
  const [singleFile, setSingleFile] = useState(() => {
    try { return localStorage.getItem('hydra-diff-single-file') === 'true' } catch { return false }
  })
  const [fileView, setFileView] = useState<FileView>(() => {
    try {
      const stored = localStorage.getItem('hydra-diff-file-view')
      if (stored === 'tree' || stored === 'flat' || stored === 'grouped') return stored
    } catch { }
    return 'tree'
  })
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = localStorage.getItem('hydra-diff-sidebar-width')
      if (stored) return parseInt(stored, 10)
    } catch { }
    return 220
  })

  const [singleFileIdx, setSingleFileIdx] = useState(0)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  useEffect(() => { try { localStorage.setItem('hydra-diff-side-by-side', String(sideBySide)) } catch { } }, [sideBySide])
  useEffect(() => { try { localStorage.setItem('hydra-diff-ignore-whitespace', String(ignoreWhitespace)) } catch { } }, [ignoreWhitespace])
  useEffect(() => { try { localStorage.setItem('hydra-diff-single-file', String(singleFile)) } catch { } }, [singleFile])
  useEffect(() => { try { localStorage.setItem('hydra-diff-file-view', fileView) } catch { } }, [fileView])
  useEffect(() => { try { localStorage.setItem('hydra-diff-sidebar-width', String(sidebarWidth)) } catch { } }, [sidebarWidth])

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
    api.default.getAgentCommits(agent.id, projectId ?? undefined)
      .then(setCommits).catch(() => setCommits([]))
  }, [agent.id, agent.branch_name, projectId, refreshKey])

  const fetchFileDiff = useCallback(async (path: string, context: number = 3) => {
    if (!agent.branch_name) return

    const params: { baseRef?: string; headRef?: string; ignoreWhitespace?: boolean; includeUncommitted?: boolean } = {}
    if (ignoreWhitespace) params.ignoreWhitespace = true
    if (leftSel.type === 'commit') params.baseRef = leftSel.sha
    if (rightSel.type === 'uncommitted') params.includeUncommitted = true
    else if (rightSel.type === 'commit') params.headRef = rightSel.sha

    try {
      const fileDiff = await api.default.getAgentDiff(agent.id, projectId ?? undefined,
        params.baseRef, params.headRef, params.ignoreWhitespace, params.includeUncommitted, path, context)

      setDiff((prev) => {
        if (!prev) return prev
        const nextFiles = prev.files.map((f) => {
          if (f.path === path) {
            return { ...f, hunks: fileDiff.files[0]?.hunks ?? [] }
          }
          return f
        })
        return { ...prev, files: nextFiles }
      })
    } catch (e) {
      console.error('Failed to fetch file diff:', e)
    }
  }, [agent.id, projectId, leftSel, rightSel, ignoreWhitespace])

  useEffect(() => {
    if (!agent.branch_name) return
    let cancelled = false
    setLoadingDiff(true)
    setDiffError(null)

    const params: { baseRef?: string; headRef?: string; includeUncommitted?: boolean } = {}
    if (leftSel.type === 'commit') params.baseRef = leftSel.sha
    if (rightSel.type === 'uncommitted') params.includeUncommitted = true
    else if (rightSel.type === 'commit') params.headRef = rightSel.sha

    // First, just get the file list (performant)
    api.default.getAgentDiffFiles(agent.id, projectId ?? undefined,
      params.baseRef, params.headRef, params.includeUncommitted)
      .then((d) => {
        if (!cancelled) {
          setDiff(d)
          setLoadingDiff(false)
          // If only a few files, load them all immediately
          if (d.files.length > 0 && d.files.length <= 5) {
            d.files.forEach((f) => fetchFileDiff(f.path))
          }
        }
      })
      .catch((e) => { if (!cancelled) { setDiffError(String(e)); setLoadingDiff(false) } })

    return () => { cancelled = true }
  }, [agent.id, agent.branch_name, projectId, leftSel, rightSel, refreshKey, fetchFileDiff])

  const handleLeftChange = useCallback((newLeft: LeftSel) => {
    setLeftSel(newLeft)
  }, [])

  useEffect(() => {
    if (leftSel.type !== 'commit' || rightSel.type !== 'commit') return
    const li = commitIdx(leftSel.sha, commits)
    const ri = commitIdx(rightSel.sha, commits)
    if (li !== -1 && ri !== -1 && li <= ri) setRightSel({ type: 'latest' })
  }, [leftSel, rightSel, commits])

  const scrollToFile = useCallback((path: string) => {
    fileRefs.current.get(path)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const handleFileClick = useCallback((path: string) => {
    if (singleFile && diff) {
      const idx = diff.files.findIndex((f) => f.path === path)
      if (idx >= 0) {
        setSingleFileIdx(idx)
        if (!diff.files[idx].hunks || diff.files[idx].hunks.length === 0) {
          fetchFileDiff(path)
        }
      }
    } else {
      if (collapsedFiles.has(path)) {
        toggleFileCollapse(path)
      }
      const idx = diff?.files.findIndex(f => f.path === path)
      if (idx !== undefined && idx >= 0 && (!diff?.files[idx].hunks || diff.files[idx].hunks.length === 0)) {
        fetchFileDiff(path)
      }
      setTimeout(() => scrollToFile(path), 50)
    }
  }, [singleFile, diff, scrollToFile, fetchFileDiff, collapsedFiles, toggleFileCollapse])

  const handleSingleFileChange = useCallback((v: boolean) => {
    setSingleFile(v); setSingleFileIdx(0)
    if (v && diff && diff.files[0] && (!diff.files[0].hunks || diff.files[0].hunks.length === 0)) {
      fetchFileDiff(diff.files[0].path)
    }
  }, [diff, fetchFileDiff])

  const handleJumpToUncommittedActual = useCallback(() => {
    setLeftSel({ type: 'base' })
    setRightSel({ type: 'uncommitted' })
  }, [])

  const handleComment = useCallback(async (path: string, lineNum: number, isNew: boolean, text: string) => {
    const side = isNew ? 'new' : 'old'
    const msg = `Comment on ${path} line ${lineNum} (${side}):\n${text}`
    try {
      await api.default.sendAgentInput(agent.id, { text: msg }, projectId ?? undefined)
    } catch (e) {
      console.error('Failed to send comment:', e)
    }
  }, [agent.id, projectId])

  const [isResizing, setIsResizing] = useState(false)
  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  useEffect(() => {
    if (!isResizing) return
    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = e.clientX - 16 // Adjust for container padding
      if (newWidth > 100 && newWidth < 600) setSidebarWidth(newWidth)
    }
    const handleMouseUp = () => setIsResizing(false)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  const totalAdditions = diff?.files.reduce((s, f) => s + f.additions, 0) ?? 0
  const totalDeletions = diff?.files.reduce((s, f) => s + f.deletions, 0) ?? 0
  const activeFilePath = singleFile && diff ? (diff.files[singleFileIdx]?.path ?? null) : null
  const hasExistingDiff = diff !== null

  const renderSidebar = (files: DiffFile[]) => {
    if (fileView === 'tree') {
      const tree = buildFileTree(files)
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
    <div className="mt-4">
      {/* Section header */}
      <div className="flex items-center gap-3 mb-4 flex-wrap sticky top-0 z-30 bg-gray-50 dark:bg-gray-900 py-2 border-b border-gray-200 dark:border-gray-800 shadow-sm -mx-1 px-1">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Changes</h2>
        {diff && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-green-600 dark:text-green-400 font-medium">+{totalAdditions}</span>
            <span className="text-xs text-red-600 dark:text-red-400 font-medium">−{totalDeletions}</span>
            <span className="text-xs text-gray-400 dark:text-gray-500">in {diff.files.length} file{diff.files.length !== 1 ? 's' : ''}</span>
          </div>
        )}

        <LeftSelector commits={commits} selected={leftSel} onChange={handleLeftChange} baseBranch={agent.base_branch} />
        <span className="text-gray-400 dark:text-gray-500 text-xs select-none"><MoveRight className='w-6 h-6' strokeWidth='1.5' /></span>
        <RightSelector commits={commits} selected={rightSel} onChange={setRightSel}
          left={leftSel} hasUncommitted={diff?.uncommitted_changes} />

        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          disabled={loadingDiff}
          className="flex items-center justify-center w-7 h-7 rounded-md text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 transition-colors cursor-pointer"
          title="Refresh diff"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>

        {/* Uncommitted changes warning button */}
        <UncommittedButton diff={diff} onJumpToUncommitted={handleJumpToUncommittedActual} />

        {/* Merge conflict button */}
        <MergeConflictButton diff={diff} agent={agent} projectId={projectId} />

        <div className="flex items-center gap-2 ml-auto flex-wrap">
          {loadingDiff && hasExistingDiff && (
            <LoaderCircle className="w-3.5 h-3.5 animate-spin text-gray-400 dark:text-gray-500 shrink-0" />
          )}

          <SettingsPopup
            fileView={fileView} onFileViewChange={setFileView}
            sideBySide={sideBySide} onSideBySideChange={setSideBySide}
            ignoreWhitespace={ignoreWhitespace} onIgnoreWhitespaceChange={setIgnoreWhitespace}
            singleFile={singleFile} onSingleFileChange={handleSingleFileChange}
          />
        </div>
      </div>

      {/* Error banner on refresh failure */}
      {diffError && hasExistingDiff && (
        <div className="mb-3 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400">
          Refresh failed: {diffError}
        </div>
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
          {/* File list sidebar */}
          <div
            className="shrink-0 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-gray-800 self-start sticky top-[45px] z-20 flex flex-col shadow-sm"
            style={{ width: sidebarWidth }}
          >
            <div className="px-2.5 py-2 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex items-center justify-between">
              <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide truncate">
                Files ({diff.files.length})
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
                <div className="flex items-center gap-2 mb-3 sticky top-[45px] z-20">
                  <button
                    onClick={() => {
                      const nextIdx = Math.max(0, singleFileIdx - 1)
                      setSingleFileIdx(nextIdx)
                      if (!diff.files[nextIdx].hunks) fetchFileDiff(diff.files[nextIdx].path)
                    }}
                    disabled={singleFileIdx === 0}
                    className="flex items-center justify-center w-7 h-7 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors shadow-sm"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 text-xs text-gray-500 dark:text-gray-400 shadow-sm font-medium">
                    {singleFileIdx + 1} / {diff.files.length}
                  </div>
                  <button
                    onClick={() => {
                      const nextIdx = Math.min(diff.files.length - 1, singleFileIdx + 1)
                      setSingleFileIdx(nextIdx)
                      if (!diff.files[nextIdx].hunks) fetchFileDiff(diff.files[nextIdx].path)
                    }}
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
                  onToggleCollapse={() => toggleFileCollapse(diff.files[singleFileIdx].path)}
                  onComment={handleComment}
                  onExpand={fetchFileDiff}
                  stickyTop={73}
                  fileRef={(el) => {
                    const f = diff.files[singleFileIdx]
                    if (!f) return
                    if (el) fileRefs.current.set(f.path, el)
                    else fileRefs.current.delete(f.path)
                  }}
                />
              </>
            ) : (
              diff.files.map((f) => (
                <FileDiff key={f.path} file={f} sideBySide={sideBySide}
                  isCollapsed={collapsedFiles.has(f.path)}
                  onToggleCollapse={() => toggleFileCollapse(f.path)}
                  onComment={handleComment}
                  onExpand={fetchFileDiff}
                  stickyTop={45}
                  fileRef={(el) => {
                    if (el) fileRefs.current.set(f.path, el)
                    else fileRefs.current.delete(f.path)
                  }}
                />
              ))
            )}
          </div>
        </div>
      ) : null}
      {isResizing && <div className="fixed inset-0 z-[100] cursor-col-resize" />}
    </div>
  )
}
