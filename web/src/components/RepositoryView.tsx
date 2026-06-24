import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import hljs from 'highlight.js'
import { api } from '../stores/apiClient'
import { formatError } from '../api/format_error'
import { ApiError } from '../api'
import type { RepositoryFileResponse, RepositoryBranch } from '../api'
import { StorageKeys, readLocal, writeLocal } from '../lib/storage'
import {
  ChevronDown, ChevronRight, File as FileIcon, Folder, FolderOpen, FileText,
  GitBranch,
  LoaderCircle, Settings, FileQuestion, FileSymlink, CornerDownRight,
  Images, Camera, Copy, Check, X, ExternalLink,
} from 'lucide-react'
import { getFileIcon } from '../lib/fileIcons'
import { canCopyImages, copyImageToClipboard } from '../lib/clipboard'
import { BranchSelector } from './BranchSelector'
import { RepositoryArtifactsView } from './RepositoryArtifactsView'
import { Tooltip } from './Tooltip'

// ── File tree model ────────────────────────────────────────────────────────────

type TreeNode = {
  name: string
  path: string
  type: 'file' | 'dir'
  children: TreeNode[]
  // Marks the synthetic ".hydra/artifacts" folder ('dir') and each artifact
  // script under it ('script'), so TreeRow renders a distinct icon and the page
  // routes a click to the artifacts viewer instead of fetching a file.
  artifact?: 'dir' | 'script'
}

// ARTIFACTS_DIR is the virtual path of the dynamic artifacts folder, nested under
// the repo's real .hydra/ folder. A script "file" lives at ARTIFACTS_DIR/<name>.
// The real on-disk cache is .hydra/local/artifacts (gitignored), so this path
// never collides with a tracked file in practice — but injection guards anyway.
const ARTIFACTS_DIR = '.hydra/artifacts'

// artifactScriptOf returns the script name when a path points at a synthetic
// artifact "file" (ARTIFACTS_DIR/<name>), or null otherwise (incl. the folder).
function artifactScriptOf(path: string | null): string | null {
  if (!path) return null
  const prefix = ARTIFACTS_DIR + '/'
  return path.startsWith(prefix) ? path.slice(prefix.length) : null
}

// buildTree turns a flat list of repo-relative file paths into a nested,
// directories-first, alphabetically-sorted tree (GitHub/GitLab style).
function buildTree(files: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] }
  for (const file of files) {
    const parts = file.split('/')
    let node = root
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1
      const path = parts.slice(0, i + 1).join('/')
      let child = node.children.find((c) => c.name === part && c.type === (isFile ? 'file' : 'dir'))
      if (!child) {
        child = { name: part, path, type: isFile ? 'file' : 'dir', children: [] }
        node.children.push(child)
      }
      node = child
    })
  }
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    nodes.forEach((n) => sortNodes(n.children))
  }
  sortNodes(root.children)
  return root.children
}

// compactTree merges chains of single-child directories into one node, the way
// VS Code's "compact folders" (and the diff viewer's tree) does: one/two/three
// renders on a single row when `one` holds only `two` and `two` holds only
// `three`. A directory folds into its child only when that child is its sole
// entry and is itself a directory, so a folder holding a file (or >1 child)
// stops the chain. The merged node keeps the deepest folder's `path` (stable,
// unique → safe expand-state key) and joins the segment names for display.
function compactTree(nodes: TreeNode[]): TreeNode[] {
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

// ancestorsOf returns every directory path containing the given file path, so we
// can auto-expand the tree down to a deep-linked file even though folders start
// collapsed (PLAN.md #41c).
function ancestorsOf(filePath: string): string[] {
  const parts = filePath.split('/')
  const acc: string[] = []
  for (let i = 1; i < parts.length; i++) acc.push(parts.slice(0, i).join('/'))
  return acc
}

// ── Syntax highlighting + markdown ──────────────────────────────────────────────

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
  if (lower === 'go.mod' || lower === 'go.sum') return 'plaintext'
  const ext = lower.split('.').pop() ?? ''
  return EXT_LANG_MAP[ext] ?? 'plaintext'
}

function isMarkdown(filePath: string): boolean {
  return /\.(md|markdown)$/i.test(filePath)
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i
function isImage(filePath: string): boolean {
  return IMAGE_EXT_RE.test(filePath)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// splitHighlightedLines splits highlight.js HTML output into an array of
// per-line HTML strings, re-opening any <span> left open across a newline so
// each line is independently valid HTML. Rendering each logical line as its own
// element is what lets line numbers stay aligned even when wrapping is on
// (PLAN.md #41a/#41d).
function splitHighlightedLines(html: string): string[] {
  const lines: string[] = []
  const stack: string[] = [] // currently-open tag strings
  let cur = ''
  for (const tok of html.split(/(<[^>]+>)/g)) {
    if (!tok) continue
    if (tok[0] === '<') {
      cur += tok
      if (tok[1] === '/') stack.pop()
      else if (tok[tok.length - 2] !== '/') stack.push(tok) // not self-closing
    } else {
      const parts = tok.split('\n')
      for (let p = 0; p < parts.length; p++) {
        cur += parts[p]
        if (p < parts.length - 1) {
          lines.push(cur + '</span>'.repeat(stack.length))
          cur = stack.join('')
        }
      }
    }
  }
  lines.push(cur)
  return lines
}

// Minimal, self-contained markdown → HTML for README rendering. Input is HTML
// escaped first, so the output is safe to inject.
function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  let inList = false
  const closeList = () => {
    if (inList) { out.push('</ul>'); inList = false }
  }
  const inline = (text: string): string => {
    let t = escapeHtml(text)
    t = t.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-[0.85em] font-mono">$1</code>')
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>')
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a class="text-blue-600 dark:text-blue-400 hover:underline" href="$2" target="_blank" rel="noreferrer">$1</a>')
    return t
  }

  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      closeList()
      const lang = fence[1]
      const code: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++ }
      i++
      const joined = code.join('\n')
      let html: string
      try {
        html = lang && hljs.getLanguage(lang)
          ? hljs.highlight(joined, { language: lang }).value
          : escapeHtml(joined)
      } catch {
        html = escapeHtml(joined)
      }
      out.push(`<pre class="my-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/60 overflow-x-auto text-sm"><code class="hljs font-mono">${html}</code></pre>`)
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = heading[1].length
      const sizes = ['text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm', 'text-sm']
      const border = level <= 2 ? ' pb-1 border-b border-gray-200 dark:border-gray-700' : ''
      out.push(`<h${level} class="${sizes[level - 1]} font-semibold mt-5 mb-2${border}">${inline(heading[2])}</h${level}>`)
      i++
      continue
    }
    const item = line.match(/^[-*]\s+(.*)$/)
    if (item) {
      if (!inList) { out.push('<ul class="list-disc pl-6 my-2 space-y-1">'); inList = true }
      out.push(`<li>${inline(item[1])}</li>`)
      i++
      continue
    }
    if (line.trim() === '') {
      closeList()
      i++
      continue
    }
    closeList()
    out.push(`<p class="my-2 leading-relaxed">${inline(line)}</p>`)
    i++
  }
  closeList()
  return out.join('\n')
}

// formatBytes renders a human size. Bytes are spelled out ("123 bytes") per
// PLAN.md #41j; larger sizes use KB/MB.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} ${n === 1 ? 'byte' : 'bytes'}`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// File icons (PLAN.md #41l) now live in ../lib/fileIcons (getFileIcon), shared
// with the diff viewer so both render files identically.

// ── File header actions (copy contents + raw) ─────────────────────────────────
// Mirrors GitHub's per-file "copy" and "raw" controls. Copy writes the file's
// text to the clipboard, or — for an image — the decoded image itself (when the
// browser's Clipboard API supports it). It's hidden for binaries, where there's
// nothing useful to copy. Raw opens the unrendered blob in a new tab via the
// same endpoint the image preview uses, so it works for any real file — text,
// image, or binary. Both buttons share the header button styling with
// SettingsPopup.

const HEADER_BTN_CLASS =
  'flex items-center justify-center h-7 rounded-md border transition-colors cursor-pointer text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'

// useCopyFlash drives the transient Copy → Check/X feedback shared by the copy
// buttons: call flash(ok) after an attempt and read state/err to pick the icon.
function useCopyFlash() {
  const [state, setState] = useState<'idle' | 'ok' | 'err'>('idle')
  const flash = (ok: boolean) => {
    setState(ok ? 'ok' : 'err')
    setTimeout(() => setState('idle'), 1500)
  }
  return { state, flash }
}

function FileActions({ file, projectId, refStr }: { file: RepositoryFileResponse; projectId: string; refStr: string }) {
  const { state, flash } = useCopyFlash()

  // An unresolved symlink has no underlying blob, so neither action applies.
  if (file.symlink && !file.target_path) return null
  const contentPath = file.target_path ?? file.path
  const rawUrl = `/repository/projects/${encodeURIComponent(projectId)}/blob?path=${encodeURIComponent(contentPath)}&ref=${encodeURIComponent(refStr)}`

  const isImg = isImage(contentPath)
  // Copy applies to text (file.content) or an image the browser can put on the
  // clipboard; binaries have neither, so the button is hidden for them.
  const canCopy = file.content != null || (isImg && canCopyImages())

  const handleCopy = async () => {
    try {
      if (file.content != null) await navigator.clipboard.writeText(file.content)
      else if (isImg) await copyImageToClipboard(rawUrl)
      else return
      flash(true)
    } catch {
      flash(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {canCopy && (
        <Tooltip content={state === 'ok' ? 'Copied!' : state === 'err' ? 'Copy failed' : isImg ? 'Copy image' : 'Copy file contents'}>
          <button onClick={handleCopy} className={`${HEADER_BTN_CLASS} w-7`}>
            {state === 'ok' ? <Check className="w-3.5 h-3.5 text-green-500" />
              : state === 'err' ? <X className="w-3.5 h-3.5 text-red-500" />
                : <Copy className="w-3.5 h-3.5" />}
          </button>
        </Tooltip>
      )}
      <Tooltip content="View raw file">
        <a href={rawUrl} target="_blank" rel="noreferrer" className={`${HEADER_BTN_CLASS} gap-1 px-2 text-xs font-medium`}>
          Raw
          <ExternalLink className="w-3 h-3" />
        </a>
      </Tooltip>
    </div>
  )
}

// ── Settings popup (PLAN.md #41e) ─────────────────────────────────────────────
// Mirrors the diff viewer's settings popup styling so the two feel consistent.

type RepoSettings = { wrap: boolean; showIcons: boolean }

function SettingsPopup({ settings, onChange }: { settings: RepoSettings; onChange: (s: RepoSettings) => void }) {
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

  const options: { key: keyof RepoSettings; label: string }[] = [
    { key: 'wrap', label: 'Wrap lines' },
    { key: 'showIcons', label: 'Show file icons' },
  ]

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        title="View settings"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center justify-center w-7 h-7 rounded-md border transition-colors cursor-pointer ${open
          ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
          : 'text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
          }`}
      >
        <Settings className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 p-3">
          <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Options</p>
          <div className="flex flex-col gap-0.5">
            {options.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings[key]}
                  onChange={(e) => onChange({ ...settings, [key]: e.target.checked })}
                  className="w-3 h-3 accent-blue-500"
                />
                <span className="text-xs text-gray-700 dark:text-gray-300">{label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tree rendering ──────────────────────────────────────────────────────────────

function TreeRow({
  node, depth, expanded, toggle, selectedPath, onSelect, showIcons,
}: {
  node: TreeNode
  depth: number
  expanded: Set<string>
  toggle: (path: string) => void
  selectedPath: string | null
  onSelect: (path: string) => void
  showIcons: boolean
}) {
  const isOpen = expanded.has(node.path)
  const isSelected = node.type === 'file' && node.path === selectedPath
  const pad = { paddingLeft: `${depth * 12 + 8}px` }

  if (node.type === 'dir') {
    return (
      <div>
        <button
          onClick={() => toggle(node.path)}
          style={pad}
          className="w-full flex items-center gap-1.5 pr-2 py-1 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer text-left"
        >
          {isOpen ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-gray-400" />}
          {showIcons && (node.artifact === 'dir'
            ? <Images className="w-4 h-4 shrink-0 text-pink-500" />
            : isOpen ? <FolderOpen className="w-4 h-4 shrink-0 text-blue-500" /> : <Folder className="w-4 h-4 shrink-0 text-blue-500" />)}
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen && node.children.map((child) => (
          <TreeRow key={child.path} node={child} depth={depth + 1} expanded={expanded} toggle={toggle} selectedPath={selectedPath} onSelect={onSelect} showIcons={showIcons} />
        ))}
      </div>
    )
  }

  const { Icon, className } = node.artifact === 'script'
    ? { Icon: Camera, className: 'text-pink-500' }
    : getFileIcon(node.name)
  return (
    <button
      onClick={() => onSelect(node.path)}
      style={pad}
      className={`w-full flex items-center gap-1.5 pr-2 py-1 text-sm transition-colors cursor-pointer text-left ${isSelected
        ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium'
        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/60'
        }`}
    >
      <span className="w-3.5 shrink-0" />
      {showIcons
        ? <Icon className={`w-4 h-4 shrink-0 ${className}`} />
        : <FileIcon className="w-4 h-4 shrink-0 text-gray-400" />}
      <span className="truncate">{node.name}</span>
    </button>
  )
}

// ── File content pane ───────────────────────────────────────────────────────────

function CodeView({ content, lang, wrap }: { content: string; lang: string; wrap: boolean }) {
  const lines = useMemo(() => {
    let highlighted: string
    try {
      highlighted = lang !== 'plaintext' && hljs.getLanguage(lang)
        ? hljs.highlight(content, { language: lang }).value
        : escapeHtml(content)
    } catch {
      highlighted = escapeHtml(content)
    }
    const split = splitHighlightedLines(highlighted)
    // Drop the trailing empty line produced by a final newline, so the gutter
    // count matches the file's real line count.
    if (split.length > 1 && split[split.length - 1] === '' && content.endsWith('\n')) split.pop()
    return split
  }, [content, lang])

  const gutterWidth = `${Math.max(2, String(lines.length).length)}ch`

  return (
    <div className={`text-xs font-mono leading-snug pt-2 ${wrap ? 'w-full' : 'w-max min-w-full'}`}>
      {lines.map((html, i) => (
        <div key={i} className="flex hover:bg-gray-50 dark:hover:bg-gray-800/40">
          <span
            style={{ width: `calc(${gutterWidth} + 1.5rem)` }}
            className="sticky left-0 z-10 shrink-0 select-none text-right pr-3 pl-2 text-gray-400 dark:text-gray-600 bg-white dark:bg-gray-900 border-r border-gray-100 dark:border-gray-800"
          >
            {i + 1}
          </span>
          <code
            className={`hljs hljs-line bg-transparent flex-1 ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}
            dangerouslySetInnerHTML={{ __html: html || ' ' }}
          />
        </div>
      ))}
    </div>
  )
}

function FileContent({
  file, wrap, projectId, refStr,
}: {
  file: RepositoryFileResponse
  wrap: boolean
  projectId: string
  refStr: string
}) {
  // For symlinks, render the file we resolved to (target_path) — its extension
  // decides syntax highlighting / markdown / image handling, and the raw blob is
  // fetched from there. A symlink with no target_path couldn't be resolved.
  if (file.symlink && !file.target_path) {
    return (
      <div className="min-h-full flex flex-col items-center justify-center gap-3 text-center px-6 text-gray-400 dark:text-gray-500">
        <FileSymlink className="w-10 h-10" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-gray-600 dark:text-gray-300">Unresolved symbolic link</p>
          {file.symlink_target && (
            <p className="text-xs font-mono break-all">→ {file.symlink_target}</p>
          )}
          <p className="text-xs">The target doesn’t exist at this ref, points outside the repository, or is a directory.</p>
        </div>
      </div>
    )
  }
  const contentPath = file.target_path ?? file.path

  if (isImage(contentPath)) {
    const url = `/repository/projects/${encodeURIComponent(projectId)}/blob?path=${encodeURIComponent(contentPath)}&ref=${encodeURIComponent(refStr)}`
    return (
      <div className="min-h-full flex flex-col items-center justify-center gap-3 p-6 bg-gray-50 dark:bg-gray-800/40">
        <img
          src={url}
          alt={contentPath}
          className="max-w-full object-contain border border-gray-200 dark:border-gray-700 rounded shadow-sm"
          style={{ backgroundImage: 'repeating-conic-gradient(#e5e7eb 0% 25%, #f9fafb 0% 50%)', backgroundSize: '16px 16px' }}
        />
        <span className="text-xs text-gray-400 dark:text-gray-500">{formatBytes(file.size)}</span>
      </div>
    )
  }

  if (file.binary || file.content == null) {
    return (
      <div className="min-h-full flex items-center justify-center text-sm text-gray-400 dark:text-gray-500">
        Binary file ({formatBytes(file.size)}) — preview not available
      </div>
    )
  }

  if (isMarkdown(contentPath)) {
    return (
      <div
        className="max-w-3xl mx-auto px-8 py-6 text-gray-800 dark:text-gray-200"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(file.content) }}
      />
    )
  }

  return (
    <>
      <CodeView content={file.content} lang={getLanguage(contentPath)} wrap={wrap} />
      {file.truncated && (
        <div className="px-4 py-2 text-xs text-amber-600 dark:text-amber-400 border-t border-gray-200 dark:border-gray-700">
          File truncated — showing the first part only.
        </div>
      )}
    </>
  )
}

// ── File-not-found state ──────────────────────────────────────────────────────

// FileNotFound is shown when the requested path doesn't exist at the selected
// ref (a 404 from getRepositoryFile) — e.g. a stale deep link, or a file that
// only exists on another branch. A dedicated state reads more clearly than a raw
// error string.
function FileNotFound({ path, refStr }: { path: string; refStr: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
      <FileQuestion className="w-12 h-12 text-gray-300 dark:text-gray-600" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">File not found</p>
        <p className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">{path}</p>
        <p className="text-xs text-gray-400 dark:text-gray-500">
          This file doesn’t exist at <span className="font-mono">{refStr}</span>.
        </p>
      </div>
    </div>
  )
}

// ── Settings persistence ──────────────────────────────────────────────────────

function loadBool(key: string, def: boolean): boolean {
  const v = readLocal(key)
  if (v === 'true') return true
  if (v === 'false') return false
  return def
}

// ── Splat <-> {ref, path} ─────────────────────────────────────────────────────

// parseSplat turns the URL splat (the part after /repository/) into a ref + file
// path. Branch names can contain slashes (e.g. hydra/my-task), so the known
// branch list is used to find the longest branch-name prefix; anything else
// treats the first segment as the ref (a commit SHA or single-segment branch).
function parseSplat(splat: string, branches: RepositoryBranch[] | null): { ref: string | null; path: string | null } {
  const segs = (splat || '').split('/').filter(Boolean)
  if (segs.length === 0) return { ref: null, path: null }
  const names = (branches ?? []).map((b) => b.name)
  for (let i = segs.length; i >= 1; i--) {
    const cand = segs.slice(0, i).join('/')
    if (names.includes(cand)) return { ref: cand, path: segs.slice(i).join('/') || null }
  }
  return { ref: segs[0], path: segs.slice(1).join('/') || null }
}

// ── Page ────────────────────────────────────────────────────────────────────────

export function RepositoryView({ projectId, splat }: { projectId: string; splat: string }) {
  const navigate = useNavigate()

  const [branches, setBranches] = useState<RepositoryBranch[] | null>(null)
  const [currentBranch, setCurrentBranch] = useState('')

  const [files, setFiles] = useState<string[]>([])
  const [defaultPath, setDefaultPath] = useState<string | null>(null)
  // Names of [[artifacts]] scripts configured at the current ref; drives the
  // dynamic ".hydra/artifacts" folder. null while loading, [] when none.
  const [artifactScripts, setArtifactScripts] = useState<string[] | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError] = useState<string | null>(null)

  const [file, setFile] = useState<RepositoryFileResponse | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  // Settings (PLAN.md #41d wrap-on-by-default, #41e popup, #41l icons).
  const [settings, setSettings] = useState<RepoSettings>(() => ({
    wrap: loadBool(StorageKeys.repoWrap, true),
    showIcons: loadBool(StorageKeys.repoIcons, true),
  }))
  useEffect(() => { writeLocal(StorageKeys.repoWrap, String(settings.wrap)) }, [settings.wrap])
  useEffect(() => { writeLocal(StorageKeys.repoIcons, String(settings.showIcons)) }, [settings.showIcons])

  // Resizable sidebar (PLAN.md #41i).
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const n = parseInt(readLocal(StorageKeys.repoSidebarWidth) ?? '', 10)
    return Number.isFinite(n) && n >= 160 && n <= 640 ? n : 256
  })
  useEffect(() => { writeLocal(StorageKeys.repoSidebarWidth, String(sidebarWidth)) }, [sidebarWidth])
  const [isResizing, setIsResizing] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const startResizing = useCallback((e: React.MouseEvent) => { e.preventDefault(); setIsResizing(true) }, [])
  useEffect(() => {
    if (!isResizing) return
    const onMove = (e: MouseEvent) => {
      const left = sidebarRef.current?.getBoundingClientRect().left ?? 0
      setSidebarWidth(Math.min(640, Math.max(160, e.clientX - left)))
    }
    const onUp = () => setIsResizing(false)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [isResizing])

  const parsed = useMemo(() => parseSplat(splat, branches), [splat, branches])
  const tree = useMemo(() => compactTree(buildTree(files)), [files])

  // Inject the synthetic ".hydra/artifacts" folder (with one "file" per configured
  // script) into the real tree, under the existing .hydra/ folder. Built after
  // compaction so it isn't merged, and skipped if a real tracked file already lives
  // at .hydra/artifacts/* (collision safety) or no scripts are configured.
  const displayTree = useMemo(() => {
    if (!artifactScripts || artifactScripts.length === 0) return tree
    if (files.some((f) => f === ARTIFACTS_DIR || f.startsWith(ARTIFACTS_DIR + '/'))) return tree
    const scriptNodes: TreeNode[] = artifactScripts.map((name) => ({
      name, path: `${ARTIFACTS_DIR}/${name}`, type: 'file', children: [], artifact: 'script',
    }))
    const artifactsDir: TreeNode = { name: 'artifacts', path: ARTIFACTS_DIR, type: 'dir', children: scriptNodes, artifact: 'dir' }
    let injected = false
    const next = tree.map((node) => {
      if (node.type === 'dir' && node.name === '.hydra') {
        injected = true
        return { ...node, children: [artifactsDir, ...node.children] } // dirs-first
      }
      return node
    })
    // No real .hydra folder in the tree — synthesize one holding just artifacts.
    return injected ? next : [{ name: '.hydra', path: '.hydra', type: 'dir' as const, children: [artifactsDir] }, ...tree]
  }, [tree, artifactScripts, files])

  // The script name when the URL points at a synthetic artifact "file", else null.
  const artifactScript = artifactScriptOf(parsed.path)

  // queryRef: the ref to actually fetch from. null/"" → server default (HEAD).
  // Selecting the current branch explicitly (e.g. /repository/main/README.md)
  // resolves to the same tree/blob as the bare /repository URL, so collapse both
  // to `undefined`. That keeps the tree-fetch key stable across the bare→branch
  // transition, so the directory list isn't refetched (and the expand state
  // isn't reset) just for moving from /repository to a file on the same branch.
  const queryRef = parsed.ref && parsed.ref !== currentBranch ? parsed.ref : undefined
  // The ref string for blob URLs / display, resolved to something concrete.
  const refStr = parsed.ref || currentBranch || 'HEAD'
  // activeRef is what the branch selector shows as selected.
  const activeRef = parsed.ref ?? (currentBranch || 'HEAD')
  const isKnownBranch = !!branches?.some((b) => b.name === activeRef)

  // The path to display: the URL path, or the repo's default (README) on the
  // bare /repository URL.
  const viewPath = parsed.path ?? defaultPath

  // Wait for branches before resolving a non-empty splat (so a multi-segment
  // branch ref isn't briefly mis-parsed and fetched at the wrong ref).
  const ready = !splat || branches !== null

  // Load branches once per project.
  useEffect(() => {
    let cancelled = false
    setBranches(null)
    api.default.getRepositoryBranches(projectId)
      .then((r) => { if (!cancelled) { setBranches(r.branches); setCurrentBranch(r.current) } })
      .catch(() => { if (!cancelled) { setBranches([]); setCurrentBranch('') } })
    return () => { cancelled = true }
  }, [projectId])

  // Load the tree for the resolved ref.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    setTreeLoading(true)
    setTreeError(null)
    api.default.getRepositoryTree(projectId, queryRef)
      .then((resp) => {
        if (cancelled) return
        setFiles(resp.files)
        setDefaultPath(resp.default_path ?? null)
        // Collapse all folders by default (PLAN.md #41c); auto-expand only the
        // ancestors of the file shown by the URL so a deep link is visible.
        const next = new Set<string>()
        const target = parsed.path
        if (target) ancestorsOf(target).forEach((p) => next.add(p))
        setExpanded(next)
      })
      .catch((err) => { if (!cancelled) setTreeError(formatError(err)) })
      .finally(() => { if (!cancelled) setTreeLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, queryRef, ready])

  // Load the artifact-script list for the resolved ref (cheap — config only, no
  // generation). Drives the dynamic ".hydra/artifacts" folder; [] hides it.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    setArtifactScripts(null)
    api.default.getRepositoryArtifacts(projectId, queryRef)
      .then((r) => { if (!cancelled) setArtifactScripts(r.scripts.map((s) => s.name)) })
      .catch(() => { if (!cancelled) setArtifactScripts([]) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, queryRef, ready])

  // Load the file content for the displayed path. Synthetic artifact paths are not
  // real files — they render the artifacts viewer instead — so skip the fetch.
  useEffect(() => {
    if (!ready || !viewPath || artifactScriptOf(viewPath)) { setFile(null); return }
    let cancelled = false
    // Clear the previously-shown file so the pane shows a loading icon instead
    // of the stale file while the new one is fetched.
    setFile(null)
    setFileLoading(true)
    setError(null)
    setNotFound(false)
    api.default.getRepositoryFile(projectId, viewPath, queryRef)
      .then((resp) => { if (!cancelled) setFile(resp) })
      .catch((err) => {
        if (cancelled) return
        setFile(null)
        // A missing path gets its own "File not found" page; other failures fall
        // back to the inline error message.
        if (err instanceof ApiError && err.status === 404) setNotFound(true)
        else setError(formatError(err))
      })
      .finally(() => { if (!cancelled) setFileLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, queryRef, viewPath, ready])

  // Reset the content scroll position whenever the displayed file changes
  // (PLAN.md #41g).
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [viewPath, file])

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // Navigate (history push) to a ref + path; empty path goes to the ref root.
  const goTo = (ref: string, path: string | null) => {
    const sp = path ? `${ref}/${path}` : ref
    navigate({ to: '/project/$projectId/repository/$', params: { projectId, _splat: sp } })
  }
  const selectFile = (path: string) => goTo(refStr, path)
  const selectBranch = (name: string) => goTo(name, parsed.path)

  return (
    <div className="flex-1 flex min-w-0 bg-white dark:bg-gray-900">
      {/* File / folder picker */}
      <div
        ref={sidebarRef}
        style={{ width: sidebarWidth }}
        className="relative shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col bg-gray-50 dark:bg-gray-800/40"
      >
        <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
          {branches !== null ? (
            <BranchSelector
              branches={branches}
              activeRef={activeRef}
              isKnownBranch={isKnownBranch}
              onSelect={selectBranch}
            />
          ) : (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-400">
              <GitBranch className="w-3.5 h-3.5" /> …
            </div>
          )}
          <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">{files.length}</span>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {treeLoading ? (
            <div className="flex items-center justify-center py-8 text-gray-400">
              <LoaderCircle className="w-4 h-4 animate-spin" />
            </div>
          ) : treeError ? (
            <div className="px-3 py-4 text-xs text-red-500 text-center">{treeError}</div>
          ) : displayTree.length === 0 ? (
            <div className="px-3 py-4 text-xs text-gray-400 dark:text-gray-500 text-center">No tracked files</div>
          ) : (
            displayTree.map((node) => (
              <TreeRow key={node.path} node={node} depth={0} expanded={expanded} toggle={toggle} selectedPath={viewPath} onSelect={selectFile} showIcons={settings.showIcons} />
            ))
          )}
        </div>

        {/* Resize handle (PLAN.md #41i) */}
        <div
          onMouseDown={startResizing}
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-500/30 transition-colors z-20"
        />
      </div>

      {/* Picked file */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2 shrink-0">
          {viewPath ? (
            <>
              {artifactScript
                ? <Camera className={`w-4 h-4 shrink-0 ${settings.showIcons ? 'text-pink-500' : 'text-gray-400'}`} />
                : file?.symlink
                  ? <FileSymlink className={`w-4 h-4 shrink-0 ${settings.showIcons ? 'text-teal-500' : 'text-gray-400'}`} />
                  : (() => { const { Icon, className } = getFileIcon(viewPath.split('/').pop() ?? viewPath); return <Icon className={`w-4 h-4 shrink-0 ${settings.showIcons ? className : 'text-gray-400'}`} /> })()}
              <span className="text-sm font-mono text-gray-700 dark:text-gray-300 truncate">{viewPath}</span>
              {file?.symlink && file.symlink_target && (
                <span className="flex items-center gap-1 text-xs font-mono text-gray-400 dark:text-gray-500 truncate shrink min-w-0" title={`Symlink → ${file.symlink_target}`}>
                  <CornerDownRight className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{file.symlink_target}</span>
                </span>
              )}
              {fileLoading && <LoaderCircle className="w-3.5 h-3.5 shrink-0 animate-spin text-gray-400" />}
              {file && (
                <span className="ml-auto text-xs text-gray-400 dark:text-gray-500 shrink-0">{formatBytes(file.size)}</span>
              )}
              {file && !artifactScript && (
                <FileActions file={file} projectId={projectId} refStr={refStr} />
              )}
              <div className={file ? '' : 'ml-auto'}>
                <SettingsPopup settings={settings} onChange={setSettings} />
              </div>
            </>
          ) : (
            <>
              <span className="text-sm text-gray-400 dark:text-gray-500">Repository</span>
              <div className="ml-auto"><SettingsPopup settings={settings} onChange={setSettings} /></div>
            </>
          )}
        </div>

        <div ref={contentRef} className="flex-1 flex flex-col min-h-0 overflow-auto">
          {artifactScript ? (
            <RepositoryArtifactsView
              key={`${refStr}:${artifactScript}`}
              projectId={projectId}
              refQuery={queryRef}
              scriptName={artifactScript}
            />
          ) : notFound && viewPath ? (
            <FileNotFound path={viewPath} refStr={refStr} />
          ) : error ? (
            <div className="flex-1 flex items-center justify-center text-sm text-red-500 px-4 text-center">{error}</div>
          ) : !viewPath ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-gray-500">
              <FileText className="w-8 h-8" />
              <span className="text-sm">Select a file to view its contents</span>
            </div>
          ) : fileLoading && !file ? (
            <div className="flex-1 flex items-center justify-center text-gray-400">
              <LoaderCircle className="w-5 h-5 animate-spin" />
            </div>
          ) : file ? (
            <FileContent file={file} wrap={settings.wrap} projectId={projectId} refStr={refStr} />
          ) : null}
        </div>
      </div>

      {isResizing && <div className="fixed inset-0 z-[100] cursor-col-resize" />}
    </div>
  )
}
