import { useEffect, useRef, useState, useCallback } from 'react'
import hljs from 'highlight.js'
import { api } from './stores/apiClient'
import type { AgentResponse, CommitInfo, DiffFile, DiffResponse } from './api'

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

/** Split highlight.js HTML output into per-line strings while preserving open spans. */
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
      // Close open spans at line boundary, reopen on next line.
      current += openSpans.map(() => '</span>').join('')
      lines.push(current)
      current = openSpans.join('')
      i++
    } else {
      // Escape any un-escaped & < > just in case (shouldn't happen from hljs output)
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

/** Highlight code and return per-line HTML strings. */
function highlightCode(code: string, language: string): string[] {
  try {
    const result = hljs.highlight(code, { language, ignoreIllegals: true })
    return splitHighlightedLines(result.value)
  } catch {
    // Fallback: escape and split
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

function buildSideBySide(hunkLines: DiffFile['hunks'][0]['lines']): SideBySideLine[] {
  // Group consecutive additions/deletions into pairs.
  const result: SideBySideLine[] = []
  let i = 0
  while (i < hunkLines.length) {
    const l = hunkLines[i]
    if (l.type === 'context') {
      result.push({
        oldLineNum: l.old_line_num ?? null,
        oldType: 'context', oldContent: l.content,
        newLineNum: l.new_line_num ?? null,
        newType: 'context', newContent: l.content,
      })
      i++
    } else if (l.type === 'deletion') {
      // Look ahead for matching additions.
      const dels: typeof hunkLines = []
      const adds: typeof hunkLines = []
      while (i < hunkLines.length && hunkLines[i].type === 'deletion') {
        dels.push(hunkLines[i++])
      }
      while (i < hunkLines.length && hunkLines[i].type === 'addition') {
        adds.push(hunkLines[i++])
      }
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
        newLineNum: l.new_line_num ?? null,
        newType: 'addition', newContent: l.content,
      })
      i++
    } else {
      i++
    }
  }
  return result
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function FileAddedIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
    </svg>
  )
}

function FileDeletedIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-red-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 12h16" />
    </svg>
  )
}

function FileModifiedIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-yellow-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" strokeWidth={2.5} />
    </svg>
  )
}

function FileRenamedIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7l10 10M17 7v10H7" />
    </svg>
  )
}

function ChangeTypeIcon({ type }: { type: string }) {
  switch (type) {
    case 'added':   return <FileAddedIcon />
    case 'deleted': return <FileDeletedIcon />
    case 'renamed': return <FileRenamedIcon />
    default:        return <FileModifiedIcon />
  }
}

// ── Diff Hunk rendering ───────────────────────────────────────────────────────

const UNIFIED_LINE_NUM_CLASS = 'select-none text-right pr-2 text-gray-400 dark:text-gray-600 text-xs font-mono w-10 shrink-0 border-r border-gray-200 dark:border-gray-700 leading-5'
const UNIFIED_CODE_CLASS = 'pl-2 font-mono text-xs leading-5 flex-1 whitespace-pre-wrap break-words overflow-hidden'

function UnifiedHunk({
  hunk,
  highlightedOld,
  highlightedNew,
}: {
  hunk: DiffFile['hunks'][0]
  highlightedOld: Map<number, string>
  highlightedNew: Map<number, string>
}) {
  return (
    <div>
      {/* Hunk header */}
      <div className="flex items-center bg-blue-50 dark:bg-blue-950/30 border-y border-blue-100 dark:border-blue-900/50 px-2 py-0.5">
        <span className="font-mono text-xs text-blue-500 dark:text-blue-400">{hunk.header}</span>
      </div>
      {/* Lines */}
      {hunk.lines.map((line, idx) => {
        const isAdd = line.type === 'addition'
        const isDel = line.type === 'deletion'
        const isNoNewline = line.type === 'no_newline'
        const highlighted = isAdd
          ? (line.new_line_num != null ? highlightedNew.get(line.new_line_num) : undefined)
          : (line.old_line_num != null ? highlightedOld.get(line.old_line_num) : undefined)

        const bgClass = isAdd
          ? 'bg-green-50 dark:bg-green-950/30'
          : isDel
          ? 'bg-red-50 dark:bg-red-950/30'
          : ''

        return (
          <div
            key={idx}
            className={`flex items-stretch hover:brightness-95 dark:hover:brightness-110 ${bgClass}`}
          >
            {/* Old line number */}
            <span className={UNIFIED_LINE_NUM_CLASS}>
              {line.old_line_num ?? ''}
            </span>
            {/* New line number */}
            <span className={UNIFIED_LINE_NUM_CLASS}>
              {line.new_line_num ?? ''}
            </span>
            {/* Diff prefix */}
            <span className={`select-none font-mono text-xs leading-5 w-4 text-center shrink-0 ${
              isAdd ? 'text-green-600 dark:text-green-400' :
              isDel ? 'text-red-600 dark:text-red-400' : 'text-gray-300 dark:text-gray-700'
            }`}>
              {isAdd ? '+' : isDel ? '-' : isNoNewline ? '\\' : ' '}
            </span>
            {/* Code content */}
            {isNoNewline ? (
              <span className={`${UNIFIED_CODE_CLASS} text-gray-400 dark:text-gray-500 italic`}>
                {line.content}
              </span>
            ) : highlighted ? (
              <span
                className={UNIFIED_CODE_CLASS}
                dangerouslySetInnerHTML={{ __html: highlighted }}
              />
            ) : (
              <span className={UNIFIED_CODE_CLASS}>
                {line.content}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

const SBS_LINE_NUM = 'select-none text-right text-gray-400 dark:text-gray-600 text-xs font-mono w-8 shrink-0 pr-1 leading-5'
const SBS_CODE = 'pl-1 font-mono text-xs leading-5 flex-1 whitespace-pre-wrap break-words overflow-hidden min-w-0'

function SideBySideHunk({
  hunk,
  highlightedOld,
  highlightedNew,
}: {
  hunk: DiffFile['hunks'][0]
  highlightedOld: Map<number, string>
  highlightedNew: Map<number, string>
}) {
  const sbsLines = buildSideBySide(hunk.lines)

  return (
    <div>
      {/* Hunk header */}
      <div className="flex items-center bg-blue-50 dark:bg-blue-950/30 border-y border-blue-100 dark:border-blue-900/50 px-2 py-0.5">
        <span className="font-mono text-xs text-blue-500 dark:text-blue-400">{hunk.header}</span>
      </div>
      {/* Lines */}
      {sbsLines.map((line, idx) => {
        const oldHighlighted = line.oldLineNum != null ? highlightedOld.get(line.oldLineNum) : undefined
        const newHighlighted = line.newLineNum != null ? highlightedNew.get(line.newLineNum) : undefined

        const oldBg = line.oldType === 'deletion'
          ? 'bg-red-50 dark:bg-red-950/30'
          : line.oldType === 'empty'
          ? 'bg-gray-50 dark:bg-gray-900/50'
          : ''
        const newBg = line.newType === 'addition'
          ? 'bg-green-50 dark:bg-green-950/30'
          : line.newType === 'empty'
          ? 'bg-gray-50 dark:bg-gray-900/50'
          : ''

        return (
          <div key={idx} className="flex items-stretch divide-x divide-gray-200 dark:divide-gray-700">
            {/* Old side */}
            <div className={`flex items-start flex-1 min-w-0 ${oldBg}`}>
              <span className={SBS_LINE_NUM}>{line.oldLineNum ?? ''}</span>
              <span className={`select-none font-mono text-xs w-3 shrink-0 text-center leading-5 ${
                line.oldType === 'deletion' ? 'text-red-500' : 'text-gray-300 dark:text-gray-700'
              }`}>
                {line.oldType === 'deletion' ? '-' : line.oldType === 'empty' ? '' : ' '}
              </span>
              {line.oldContent != null && oldHighlighted ? (
                <span className={SBS_CODE} dangerouslySetInnerHTML={{ __html: oldHighlighted }} />
              ) : (
                <span className={SBS_CODE}>{line.oldContent ?? ''}</span>
              )}
            </div>
            {/* New side */}
            <div className={`flex items-start flex-1 min-w-0 ${newBg}`}>
              <span className={SBS_LINE_NUM}>{line.newLineNum ?? ''}</span>
              <span className={`select-none font-mono text-xs w-3 shrink-0 text-center leading-5 ${
                line.newType === 'addition' ? 'text-green-500' : 'text-gray-300 dark:text-gray-700'
              }`}>
                {line.newType === 'addition' ? '+' : line.newType === 'empty' ? '' : ' '}
              </span>
              {line.newContent != null && newHighlighted ? (
                <span className={SBS_CODE} dangerouslySetInnerHTML={{ __html: newHighlighted }} />
              ) : (
                <span className={SBS_CODE}>{line.newContent ?? ''}</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}


// ── File diff card ────────────────────────────────────────────────────────────

function FileDiff({
  file,
  sideBySide,
  fileRef,
}: {
  file: DiffFile
  sideBySide: boolean
  fileRef?: (el: HTMLDivElement | null) => void
}) {
  const lang = getLanguage(file.path)

  // Reconstruct old/new code blocks and highlight them.
  const { highlightedOld, highlightedNew } = (() => {
    if (file.binary) return { highlightedOld: new Map<number, string>(), highlightedNew: new Map<number, string>() }

    // Collect old lines (context + deletions) and new lines (context + additions).
    const oldLines: Array<{ lineNum: number; content: string }> = []
    const newLines: Array<{ lineNum: number; content: string }> = []

    for (const hunk of file.hunks) {
      for (const l of hunk.lines) {
        if ((l.type === 'context' || l.type === 'deletion') && l.old_line_num != null) {
          oldLines.push({ lineNum: l.old_line_num, content: l.content })
        }
        if ((l.type === 'context' || l.type === 'addition') && l.new_line_num != null) {
          newLines.push({ lineNum: l.new_line_num, content: l.content })
        }
      }
    }

    const highlight = (lines: typeof oldLines): Map<number, string> => {
      if (lines.length === 0) return new Map()
      const code = lines.map((l) => l.content).join('\n')
      const highlighted = highlightCode(code, lang)
      const map = new Map<number, string>()
      lines.forEach((l, i) => {
        if (highlighted[i] !== undefined) map.set(l.lineNum, highlighted[i])
      })
      return map
    }

    return {
      highlightedOld: highlight(oldLines),
      highlightedNew: highlight(newLines),
    }
  })()

  const displayPath = file.change_type === 'renamed' && file.old_path
    ? `${file.old_path} → ${file.path}`
    : file.path

  return (
    <div ref={fileRef} className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden mb-4">
      {/* File header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <ChangeTypeIcon type={file.change_type} />
        <span className="font-mono text-xs text-gray-700 dark:text-gray-300 flex-1 min-w-0 truncate" title={displayPath}>
          {displayPath}
        </span>
        {!file.binary && (
          <div className="flex items-center gap-1.5 shrink-0">
            {file.additions > 0 && (
              <span className="text-xs text-green-600 dark:text-green-400 font-medium">+{file.additions}</span>
            )}
            {file.deletions > 0 && (
              <span className="text-xs text-red-600 dark:text-red-400 font-medium">−{file.deletions}</span>
            )}
          </div>
        )}
      </div>

      {/* Diff content */}
      {file.binary ? (
        <div className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500 italic">
          Binary file changed
        </div>
      ) : file.hunks.length === 0 ? (
        <div className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500 italic">
          No changes
        </div>
      ) : (
        <div className="overflow-hidden">
          {file.hunks.map((hunk, idx) =>
            sideBySide ? (
              <SideBySideHunk
                key={idx}
                hunk={hunk}
                highlightedOld={highlightedOld}
                highlightedNew={highlightedNew}
              />
            ) : (
              <UnifiedHunk
                key={idx}
                hunk={hunk}
                highlightedOld={highlightedOld}
                highlightedNew={highlightedNew}
              />
            )
          )}
        </div>
      )}
    </div>
  )
}

// ── Commit info card ──────────────────────────────────────────────────────────

function CommitCard({ commit }: { commit: CommitInfo }) {
  const date = new Date(commit.timestamp)
  const dateStr = date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded-lg">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{commit.message}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="font-mono text-xs text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">
              {commit.short_sha}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">{commit.author_name}</span>
            <span className="text-xs text-gray-400 dark:text-gray-500" title={commit.timestamp}>
              {dateStr} {timeStr}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Commit selector dropdown ──────────────────────────────────────────────────

type ViewSelection = { type: 'full' } | { type: 'uncommitted' } | { type: 'commit'; sha: string }

function CommitSelector({
  commits,
  selected,
  onChange,
}: {
  commits: CommitInfo[]
  selected: ViewSelection
  onChange: (v: ViewSelection) => void
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

  const label = selected.type === 'full'
    ? 'Full diff'
    : selected.type === 'uncommitted'
      ? 'Uncommitted'
      : commits.find((c) => c.sha === selected.sha)
        ? `${commits.find((c) => c.sha === selected.sha)!.short_sha} ${commits.find((c) => c.sha === selected.sha)!.message.slice(0, 28)}${commits.find((c) => c.sha === selected.sha)!.message.length > 28 ? '…' : ''}`
        : selected.sha.slice(0, 7)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
      >
        <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <span className="max-w-[180px] truncate">{label}</span>
        <svg className="w-3 h-3 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 overflow-hidden">
          {/* Main diff options */}
          <div className="py-1 border-b border-gray-100 dark:border-gray-700">
            <button
              onClick={() => { onChange({ type: 'full' }); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
                selected.type === 'full' ? 'bg-blue-50 dark:bg-blue-900/20' : ''
              }`}
            >
              <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span className="font-medium text-gray-800 dark:text-gray-200">Full diff</span>
              <span className="text-gray-400 dark:text-gray-500 ml-auto">base → current</span>
              {selected.type === 'full' && (
                <svg className="w-3 h-3 text-blue-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              )}
            </button>
            <button
              onClick={() => { onChange({ type: 'uncommitted' }); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
                selected.type === 'uncommitted' ? 'bg-blue-50 dark:bg-blue-900/20' : ''
              }`}
            >
              <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              <span className="font-medium text-gray-800 dark:text-gray-200">Include uncommitted</span>
              <span className="text-gray-400 dark:text-gray-500 ml-auto">base → worktree</span>
              {selected.type === 'uncommitted' && (
                <svg className="w-3 h-3 text-blue-500 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              )}
            </button>
          </div>

          {/* Individual commits */}
          {commits.length > 0 && (
            <div className="max-h-64 overflow-y-auto py-1">
              <p className="px-3 py-1 text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide font-medium">
                Commits ({commits.length})
              </p>
              {commits.map((c) => (
                <button
                  key={c.sha}
                  onClick={() => { onChange({ type: 'commit', sha: c.sha }); setOpen(false) }}
                  className={`w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
                    selected.type === 'commit' && selected.sha === c.sha ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                  }`}
                >
                  <span className="font-mono text-[10px] text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded shrink-0 mt-0.5">
                    {c.short_sha}
                  </span>
                  <span className="text-xs text-gray-700 dark:text-gray-300 leading-tight truncate">{c.message}</span>
                  {selected.type === 'commit' && selected.sha === c.sha && (
                    <svg className="w-3 h-3 text-blue-500 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Toggle button ─────────────────────────────────────────────────────────────

function Toggle({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium border transition-colors cursor-pointer ${
        active
          ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
          : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
      }`}
    >
      {label}
    </button>
  )
}

// ── Main DiffViewer component ─────────────────────────────────────────────────

export function DiffViewer({
  agent,
  projectId,
}: {
  agent: AgentResponse
  projectId: string | null
}) {
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [selectedView, setSelectedView] = useState<ViewSelection>({ type: 'full' })
  const [diff, setDiff] = useState<DiffResponse | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [sideBySide, setSideBySide] = useState(false)
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Fetch commits list whenever the agent changes.
  useEffect(() => {
    if (!agent.branch_name) return
    api.default
      .getAgentCommits(agent.id, projectId ?? undefined)
      .then(setCommits)
      .catch(() => setCommits([]))
  }, [agent.id, agent.branch_name, projectId])

  // Fetch diff when selection or options change.
  useEffect(() => {
    if (!agent.branch_name) return

    let cancelled = false
    setLoadingDiff(true)
    setDiffError(null)

    const params: { baseRef?: string; headRef?: string; ignoreWhitespace?: boolean; includeUncommitted?: boolean } = {
      ignoreWhitespace: ignoreWhitespace || undefined,
    }

    if (selectedView.type === 'commit') {
      // Show a single commit: diff parent^..sha
      params.baseRef = `${selectedView.sha}^`
      params.headRef = selectedView.sha
    } else if (selectedView.type === 'uncommitted') {
      params.includeUncommitted = true
    }
    // For 'full', omit base/head refs — backend uses triple-dot merge-base diff.

    api.default
      .getAgentDiff(
        agent.id,
        projectId ?? undefined,
        params.baseRef,
        params.headRef,
        params.ignoreWhitespace,
        params.includeUncommitted,
      )
      .then((d) => {
        if (!cancelled) { setDiff(d); setLoadingDiff(false) }
      })
      .catch((e) => {
        if (!cancelled) { setDiffError(String(e)); setLoadingDiff(false) }
      })

    return () => { cancelled = true }
  }, [agent.id, agent.branch_name, projectId, selectedView, ignoreWhitespace])

  const scrollToFile = useCallback((path: string) => {
    const el = fileRefs.current.get(path)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const selectedCommit = selectedView.type === 'commit'
    ? commits.find((c) => c.sha === selectedView.sha) ?? null
    : null

  const totalAdditions = diff?.files.reduce((s, f) => s + f.additions, 0) ?? 0
  const totalDeletions = diff?.files.reduce((s, f) => s + f.deletions, 0) ?? 0

  // If the agent doesn't have a branch, don't show the viewer.
  if (!agent.branch_name) return null

  return (
    <div className="mt-4">
      {/* Section header */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Changes</h2>
        {diff && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-green-600 dark:text-green-400 font-medium">+{totalAdditions}</span>
            <span className="text-xs text-red-600 dark:text-red-400 font-medium">−{totalDeletions}</span>
            <span className="text-xs text-gray-400 dark:text-gray-500">in {diff.files.length} file{diff.files.length !== 1 ? 's' : ''}</span>
          </div>
        )}
        <div className="flex items-center gap-2 ml-auto flex-wrap">
          <CommitSelector commits={commits} selected={selectedView} onChange={setSelectedView} />
          <Toggle label="Side-by-side" active={sideBySide} onClick={() => setSideBySide((v) => !v)} />
          <Toggle label="Ignore whitespace" active={ignoreWhitespace} onClick={() => setIgnoreWhitespace((v) => !v)} />
        </div>
      </div>

      {/* Commit details (when a specific commit is selected) */}
      {selectedCommit && <CommitCard commit={selectedCommit} />}

      {/* Content */}
      {loadingDiff ? (
        <div className="flex items-center justify-center py-8 text-gray-400 dark:text-gray-500">
          <svg className="w-4 h-4 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span className="text-sm">Loading diff…</span>
        </div>
      ) : diffError ? (
        <div className="px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-600 dark:text-red-400">
          {diffError}
        </div>
      ) : diff && diff.files.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-gray-400 dark:text-gray-500 text-sm">
          No changes
        </div>
      ) : diff ? (
        <div className="flex gap-3 min-h-0">
          {/* File list sidebar */}
          <div className="w-52 shrink-0 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-white dark:bg-gray-800 self-start sticky top-0">
            <div className="px-2.5 py-2 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
              <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Changed files ({diff.files.length})
              </span>
            </div>
            <div className="overflow-y-auto max-h-80">
              {diff.files.map((f) => (
                <button
                  key={f.path}
                  onClick={() => scrollToFile(f.path)}
                  className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors group"
                >
                  <ChangeTypeIcon type={f.change_type} />
                  <span className="font-mono text-[10px] text-gray-700 dark:text-gray-300 truncate flex-1 min-w-0" title={f.path}>
                    {f.path.split('/').pop()}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    {f.additions > 0 && (
                      <span className="text-[10px] text-green-600 dark:text-green-400">+{f.additions}</span>
                    )}
                    {f.deletions > 0 && (
                      <span className="text-[10px] text-red-600 dark:text-red-400">−{f.deletions}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Diff content */}
          <div className="flex-1 min-w-0">
            {diff.files.map((f) => (
              <FileDiff
                key={f.path}
                file={f}
                sideBySide={sideBySide}
                fileRef={(el) => {
                  if (el) fileRefs.current.set(f.path, el)
                  else fileRefs.current.delete(f.path)
                }}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
