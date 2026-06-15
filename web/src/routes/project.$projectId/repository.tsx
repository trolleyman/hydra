import { createFileRoute, useParams } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js'
import { api } from '../../stores/apiClient'
import { formatError } from '../../api/format_error'
import type { RepositoryFileResponse } from '../../api'
import { ChevronDown, ChevronRight, File as FileIcon, Folder, FolderOpen, FileText, LoaderCircle } from 'lucide-react'

export const Route = createFileRoute('/project/$projectId/repository')({
  component: RepositoryPage,
})

// ── File tree model ────────────────────────────────────────────────────────────

type TreeNode = {
  name: string
  path: string
  type: 'file' | 'dir'
  children: TreeNode[]
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

// allDirPaths collects every directory path in the tree so we can expand them
// by default (the demo tree is small enough to show fully).
function allDirPaths(nodes: TreeNode[], acc: Set<string> = new Set()): Set<string> {
  for (const n of nodes) {
    if (n.type === 'dir') {
      acc.add(n.path)
      allDirPaths(n.children, acc)
    }
  }
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Minimal, self-contained markdown → HTML for README rendering. Input is HTML
// escaped first, so the output is safe to inject. It covers the common
// constructs (headings, fenced/inline code, lists, bold/italic, links) — enough
// for a GitHub-like README without pulling in a markdown dependency.
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
    // Fenced code block.
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      closeList()
      const lang = fence[1]
      const code: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++ }
      i++ // skip closing fence
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
    // Heading.
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
    // List item.
    const item = line.match(/^[-*]\s+(.*)$/)
    if (item) {
      if (!inList) { out.push('<ul class="list-disc pl-6 my-2 space-y-1">'); inList = true }
      out.push(`<li>${inline(item[1])}</li>`)
      i++
      continue
    }
    // Blank line.
    if (line.trim() === '') {
      closeList()
      i++
      continue
    }
    // Paragraph.
    closeList()
    out.push(`<p class="my-2 leading-relaxed">${inline(line)}</p>`)
    i++
  }
  closeList()
  return out.join('\n')
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// ── Tree rendering ──────────────────────────────────────────────────────────────

function TreeRow({
  node, depth, expanded, toggle, selectedPath, onSelect,
}: {
  node: TreeNode
  depth: number
  expanded: Set<string>
  toggle: (path: string) => void
  selectedPath: string | null
  onSelect: (path: string) => void
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
          {isOpen ? <FolderOpen className="w-4 h-4 shrink-0 text-blue-500" /> : <Folder className="w-4 h-4 shrink-0 text-blue-500" />}
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen && node.children.map((child) => (
          <TreeRow key={child.path} node={child} depth={depth + 1} expanded={expanded} toggle={toggle} selectedPath={selectedPath} onSelect={onSelect} />
        ))}
      </div>
    )
  }

  return (
    <button
      onClick={() => onSelect(node.path)}
      style={pad}
      className={`w-full flex items-center gap-1.5 pr-2 py-1 text-sm transition-colors cursor-pointer text-left ${
        isSelected
          ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium'
          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/60'
      }`}
    >
      <span className="w-3.5 shrink-0" />
      <FileIcon className="w-4 h-4 shrink-0 text-gray-400" />
      <span className="truncate">{node.name}</span>
    </button>
  )
}

// ── File content pane ───────────────────────────────────────────────────────────

function FileContent({ file }: { file: RepositoryFileResponse }) {
  const html = useMemo(() => {
    if (file.binary || file.content == null) return null
    if (isMarkdown(file.path)) return { kind: 'markdown' as const, value: renderMarkdown(file.content) }
    const lang = getLanguage(file.path)
    try {
      const value = lang !== 'plaintext' && hljs.getLanguage(lang)
        ? hljs.highlight(file.content, { language: lang }).value
        : escapeHtml(file.content)
      return { kind: 'code' as const, value }
    } catch {
      return { kind: 'code' as const, value: escapeHtml(file.content) }
    }
  }, [file])

  if (file.binary) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-400 dark:text-gray-500">
        Binary file ({formatBytes(file.size)}) — preview not available
      </div>
    )
  }

  if (html?.kind === 'markdown') {
    return (
      <div className="flex-1 overflow-auto">
        <div
          className="max-w-3xl mx-auto px-8 py-6 text-gray-800 dark:text-gray-200"
          dangerouslySetInnerHTML={{ __html: html.value }}
        />
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto">
      <pre className="text-sm leading-relaxed p-4 font-mono"><code className="hljs bg-transparent" dangerouslySetInnerHTML={{ __html: html?.value ?? '' }} /></pre>
      {file.truncated && (
        <div className="px-4 py-2 text-xs text-amber-600 dark:text-amber-400 border-t border-gray-200 dark:border-gray-700">
          File truncated — showing the first part only.
        </div>
      )}
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────────

function RepositoryPage() {
  const { projectId } = useParams({ from: '/project/$projectId/repository' })
  const [files, setFiles] = useState<string[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [file, setFile] = useState<RepositoryFileResponse | null>(null)
  const [treeLoading, setTreeLoading] = useState(true)
  const [fileLoading, setFileLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Remembers whether we've applied the server's suggested default file yet, so
  // the user's later selections aren't overridden by a tree refresh.
  const appliedDefault = useRef(false)

  const tree = useMemo(() => buildTree(files), [files])

  // Load the repository tree for the project.
  useEffect(() => {
    let cancelled = false
    appliedDefault.current = false
    setTreeLoading(true)
    setError(null)
    setSelectedPath(null)
    setFile(null)
    api.default.getRepositoryTree(projectId)
      .then((resp) => {
        if (cancelled) return
        setFiles(resp.files)
        setExpanded(allDirPaths(buildTree(resp.files)))
        if (!appliedDefault.current && resp.default_path) {
          appliedDefault.current = true
          setSelectedPath(resp.default_path)
        }
      })
      .catch((err) => { if (!cancelled) setError(formatError(err)) })
      .finally(() => { if (!cancelled) setTreeLoading(false) })
    return () => { cancelled = true }
  }, [projectId])

  // Load the selected file's content.
  useEffect(() => {
    if (!selectedPath) { setFile(null); return }
    let cancelled = false
    setFileLoading(true)
    api.default.getRepositoryFile(projectId, selectedPath)
      .then((resp) => { if (!cancelled) setFile(resp) })
      .catch((err) => { if (!cancelled) { setFile(null); setError(formatError(err)) } })
      .finally(() => { if (!cancelled) setFileLoading(false) })
    return () => { cancelled = true }
  }, [projectId, selectedPath])

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="flex-1 flex min-w-0 bg-white dark:bg-gray-900">
      {/* File / folder picker */}
      <div className="w-64 shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col bg-gray-50 dark:bg-gray-800/40">
        <div className="px-3 py-2.5 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
          <FileText className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Files</span>
          <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">{files.length}</span>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {treeLoading ? (
            <div className="flex items-center justify-center py-8 text-gray-400">
              <LoaderCircle className="w-4 h-4 animate-spin" />
            </div>
          ) : tree.length === 0 ? (
            <div className="px-3 py-4 text-xs text-gray-400 dark:text-gray-500 text-center">No tracked files</div>
          ) : (
            tree.map((node) => (
              <TreeRow key={node.path} node={node} depth={0} expanded={expanded} toggle={toggle} selectedPath={selectedPath} onSelect={setSelectedPath} />
            ))
          )}
        </div>
      </div>

      {/* Picked file / folder */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2 shrink-0">
          {selectedPath ? (
            <>
              <FileIcon className="w-4 h-4 text-gray-400 shrink-0" />
              <span className="text-sm font-mono text-gray-700 dark:text-gray-300 truncate">{selectedPath}</span>
              {file && !file.binary && (
                <span className="ml-auto text-xs text-gray-400 dark:text-gray-500 shrink-0">{formatBytes(file.size)}</span>
              )}
            </>
          ) : (
            <span className="text-sm text-gray-400 dark:text-gray-500">Repository</span>
          )}
        </div>

        {error ? (
          <div className="flex-1 flex items-center justify-center text-sm text-red-500 px-4 text-center">{error}</div>
        ) : !selectedPath ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-gray-500">
            <FileText className="w-8 h-8" />
            <span className="text-sm">Select a file to view its contents</span>
          </div>
        ) : fileLoading && !file ? (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <LoaderCircle className="w-5 h-5 animate-spin" />
          </div>
        ) : file ? (
          <FileContent file={file} />
        ) : null}
      </div>
    </div>
  )
}
