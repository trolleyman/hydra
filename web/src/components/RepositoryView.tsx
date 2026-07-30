import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react'
import { useNavigate, useLocation, useSearch, Link, linkOptions, type LinkProps } from '@tanstack/react-router'
import { Markdown } from '../lib/MarkdownRenderer'
import { formatBytes } from '../lib/formatBytes'
import { getLanguage } from '../lib/language'
import { fetchBranches, peekBranches } from '../lib/branchCache'
import { api } from '../stores/apiClient'
import { formatError } from '../api/format_error'
import { ApiError } from '../api'
import type { RepositoryFileResponse, RepositoryBranch, DiffResponse } from '../api'
import { StorageKeys, readLocal, writeLocal } from '../lib/storage'
import {
  ChevronRight, ChevronLeft, File as FileIcon, Folder, FolderOpen, FileText,
  GitCompareArrows, ArrowRightLeft, Menu,
  LoaderCircle, Settings2, FileQuestion, FileSymlink, CornerDownRight,
  Images, Camera, ExternalLink,
} from 'lucide-react'
import { getFileIcon } from '../lib/fileIcons'
import { canCopyImages, copyImageToClipboard } from '../lib/clipboard'
import { copyWithToast, showCopyToast } from '../lib/copyToast'
import { useCopyFlash } from '../lib/useCopyFlash'
import { CopyStateIcon } from './CopyStateIcon'
import { CollapseSlide } from './CollapseSlide'
import { BranchSelector } from './BranchSelector'
import { RepositoryArtifactsView } from './RepositoryArtifactsView'
import { CodePane } from './CodePane'
import { Tooltip } from './Tooltip'
import {
  FileDiff, FileRow, ChangeTypeIcon, TreeNodeView, type FileView,
  type DiffSide,
} from '../DiffViewer'
import { buildFileTree, compactTree as compactDiffTree, getGroupedFiles } from '../lib/fileTree'
import { scrollCardToTop } from '../lib/diffScroll'
import { PROMOTED_MAX_CHANGES, PROMOTED_MAX_LINES } from '../lib/diffBody'
import { type ImageDiffMode } from './ArtifactImageDiff'
import { IMAGE_DIFF_MODES } from './artifactDiffContext'
import { repoBlobUrl } from '../lib/imageDiff'
import { buildRepoSplat, parseRepoSplat, splatNeedsBranchList } from '../lib/repoSplat'
import {
  parseLineRange, formatLineHash, type LineRange,
  parseDiffLineRange, formatDiffLineHash,
} from '../lib/lineRange'
import type { RepositorySearch } from '../routes/project.$projectId/repository.$'

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
// never collides with a tracked file in practice - but injection guards anyway.
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
// collapsed.
function ancestorsOf(filePath: string): string[] {
  const parts = filePath.split('/')
  const acc: string[] = []
  for (let i = 1; i < parts.length; i++) acc.push(parts.slice(0, i).join('/'))
  return acc
}

// ── Syntax highlighting + markdown ──────────────────────────────────────────────

function isMarkdown(filePath: string): boolean {
  return /\.(md|markdown)$/i.test(filePath)
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i
function isImage(filePath: string): boolean {
  return IMAGE_EXT_RE.test(filePath)
}


// formatBytes now lives in ../lib/formatBytes, shared with the artifact
// download tiles.

// File icons now live in ../lib/fileIcons (getFileIcon), shared
// with the diff viewer so both render files identically.

// ── File header actions (copy contents + raw) ─────────────────────────────────
// Mirrors GitHub's per-file "copy" and "raw" controls. Copy writes the file's
// text to the clipboard, or - for an image - the decoded image itself (when the
// browser's Clipboard API supports it). It's hidden for binaries, where there's
// nothing useful to copy. Raw opens the unrendered blob in a new tab via the
// same endpoint the image preview uses, so it works for any real file - text,
// image, or binary. Both buttons share the header button styling with
// SettingsPopup.

const HEADER_BTN_CLASS =
  'flex items-center justify-center h-7 rounded-md border transition-colors cursor-pointer text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'

// Full-width row styling for the small-screen overflow menu (copy / raw rows).
const MENU_ROW_CLASS =
  'w-full flex items-center gap-2.5 px-2.5 py-2 text-sm text-left text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors cursor-pointer rounded-md'

// useFileActions centralises the copy/raw behaviour so the inline header buttons
// (FileActions) and the small-screen overflow menu (FileActionMenuRows) share one
// implementation. `available` is false for an unresolved symlink (no blob).
function useFileActions(file: RepositoryFileResponse, projectId: string, refStr: string) {
  const { state, flash } = useCopyFlash()
  const available = !(file.symlink && !file.target_path)
  const contentPath = file.target_path ?? file.path
  const rawUrl = `/api/projects/${encodeURIComponent(projectId)}/repository/blob?path=${encodeURIComponent(contentPath)}&ref=${encodeURIComponent(refStr)}`
  const isImg = isImage(contentPath)
  // Copy applies to text (file.content) or an image the browser can put on the
  // clipboard; binaries have neither, so it's hidden for them.
  const canCopy = file.content != null || (isImg && canCopyImages())
  const copyLabel = state === 'ok' ? 'Copied!' : state === 'err' ? 'Copy failed' : isImg ? 'Copy image' : 'Copy file contents'
  const handleCopy = async () => {
    try {
      // copyText handles insecure LAN origins (undefined navigator.clipboard);
      // it reports success as a boolean rather than throwing, so honour it.
      // Both paths raise the standard copy toast: the button's icon flash is
      // easy to miss (the pointer has usually already moved on), and for an
      // image there is no preview of what landed on the clipboard at all.
      // The preview is the file's PATH, not the first lines of its content: with
      // a whole file on the clipboard, what you want confirmed is which file it
      // came from - and for an image there is no text preview to show at all.
      let ok: boolean
      if (file.content != null) {
        ok = await copyWithToast(file.content, { what: 'file contents', preview: contentPath })
      } else if (isImg) {
        await copyImageToClipboard(rawUrl)
        ok = true
        showCopyToast(true, contentPath, { what: 'image' })
      } else return
      flash(ok)
    } catch {
      // An image copy is the only path that throws here (copyText reports false
      // instead), so this is where its failure toast has to come from.
      if (file.content == null) showCopyToast(false, contentPath, { what: 'image' })
      flash(false)
    }
  }
  return { available, state, canCopy, copyLabel, rawUrl, handleCopy }
}

function FileActions({ file, projectId, refStr }: { file: RepositoryFileResponse; projectId: string; refStr: string }) {
  const { available, state, canCopy, copyLabel, rawUrl, handleCopy } = useFileActions(file, projectId, refStr)
  if (!available) return null
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {canCopy && (
        <Tooltip content={copyLabel}>
          <button onClick={handleCopy} className={`${HEADER_BTN_CLASS} w-7`}>
            <CopyStateIcon state={state} />
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

// FileActionMenuRows renders the same copy/raw actions as full-width rows for the
// small-screen overflow menu; onAction closes the menu after a tap.
function FileActionMenuRows({ file, projectId, refStr, onAction }: { file: RepositoryFileResponse; projectId: string; refStr: string; onAction: () => void }) {
  const { available, state, canCopy, copyLabel, rawUrl, handleCopy } = useFileActions(file, projectId, refStr)
  if (!available) return null
  return (
    <>
      {canCopy && (
        <button onClick={() => { handleCopy(); onAction() }} className={MENU_ROW_CLASS}>
          <CopyStateIcon state={state} size="w-4 h-4" idleColor="text-gray-400" />
          {copyLabel}
        </button>
      )}
      <a href={rawUrl} target="_blank" rel="noreferrer" onClick={onAction} className={MENU_ROW_CLASS}>
        <ExternalLink className="w-4 h-4 text-gray-400" />
        View raw file
      </a>
    </>
  )
}

// ── Settings popup ─────────────────────────────────────────────
// Mirrors the diff viewer's settings popup styling so the two feel consistent.

type RepoSettings = { wrap: boolean; showIcons: boolean }

// RepoSettingsFields renders the file-view toggles, shared by the desktop popup
// (SettingsPopup) and the small-screen overflow menu.
function RepoSettingsFields({ settings, onChange }: { settings: RepoSettings; onChange: (s: RepoSettings) => void }) {
  const options: { key: keyof RepoSettings; label: string }[] = [
    { key: 'wrap', label: 'Wrap lines' },
    { key: 'showIcons', label: 'Show file icons' },
  ]
  return (
    <>
      <p className="text-2xs font-semibold text-gray-500 dark:text-gray-400 mb-2">Options</p>
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
    </>
  )
}

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

  return (
    <div ref={ref} className="relative shrink-0">
      <Tooltip content="View settings">
        <button
          aria-label="View settings"
          onClick={() => setOpen((o) => !o)}
          className={`flex items-center justify-center w-7 h-7 rounded-md border transition-colors cursor-pointer ${open
            ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
            : 'text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
            }`}
        >
          <Settings2 className="w-3.5 h-3.5" />
        </button>
      </Tooltip>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 p-3">
          <RepoSettingsFields settings={settings} onChange={onChange} />
        </div>
      )}
    </div>
  )
}

// ── Diff settings popup (branch-compare view) ─────────────────────────────────
// A trimmed cousin of SettingsPopup for the diff view's two toggles, mirroring
// the diff viewer's own options so the two feel consistent.

type DiffSettings = { fileView: FileView; singleFile: boolean; sideBySide: boolean; wordHighlight: boolean; ignoreWhitespace: boolean; imageDiffMode: ImageDiffMode }

// DiffSettingsFields renders the branch-compare view's file-list / diff / image
// options, shared by the desktop popup (DiffSettingsPopup) and the overflow menu.
function DiffSettingsFields({ settings, onChange }: { settings: DiffSettings; onChange: (s: DiffSettings) => void }) {
  type BoolKey = 'singleFile' | 'sideBySide' | 'wordHighlight' | 'ignoreWhitespace'
  const options: { key: BoolKey; label: string }[] = [
    { key: 'singleFile', label: 'One file at a time' },
    { key: 'sideBySide', label: 'Side by side' },
    { key: 'wordHighlight', label: 'Highlight changed words' },
    { key: 'ignoreWhitespace', label: 'Ignore whitespace' },
  ]
  const viewOptions: { value: FileView; label: string }[] = [
    { value: 'tree', label: 'Tree' },
    { value: 'flat', label: 'Flat list' },
    { value: 'grouped', label: 'Grouped by folder' },
  ]
  return (
    <>
      <p className="text-2xs font-semibold text-gray-500 dark:text-gray-400 mb-2">File list</p>
      <div className="flex flex-col gap-0.5 mb-3">
        {viewOptions.map((opt) => (
          <label key={opt.value} className="flex items-center gap-2 py-0.5 cursor-pointer">
            <input
              type="radio"
              name="hydra-repo-diff-file-view"
              checked={settings.fileView === opt.value}
              onChange={() => onChange({ ...settings, fileView: opt.value })}
              className="w-3 h-3 accent-blue-500"
            />
            <span className="text-xs text-gray-700 dark:text-gray-300">{opt.label}</span>
          </label>
        ))}
      </div>
      <p className="text-2xs font-semibold text-gray-500 dark:text-gray-400 mb-2">Diff options</p>
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
      {/* Image diff mode - applies to in-tree images in the diff, mirroring the
          agent diff viewer's settings (shared storage key). */}
      <p className="text-2xs font-semibold text-gray-500 dark:text-gray-400 mt-3 mb-2">Image diff</p>
      <div className="flex flex-col gap-0.5">
        {IMAGE_DIFF_MODES.map((opt) => (
          <label key={opt.value} className="flex items-center gap-2 py-0.5 cursor-pointer">
            <input
              type="radio"
              name="hydra-repo-image-diff-mode"
              checked={settings.imageDiffMode === opt.value}
              onChange={() => onChange({ ...settings, imageDiffMode: opt.value })}
              className="w-3 h-3 accent-blue-500"
            />
            <span className="text-xs text-gray-700 dark:text-gray-300">{opt.label}</span>
          </label>
        ))}
      </div>
    </>
  )
}

function DiffSettingsPopup({ settings, onChange }: { settings: DiffSettings; onChange: (s: DiffSettings) => void }) {
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

  return (
    <div ref={ref} className="relative shrink-0">
      <Tooltip content="Diff settings">
        <button
          aria-label="Diff settings"
          onClick={() => setOpen((o) => !o)}
          className={`flex items-center justify-center w-7 h-7 rounded-md border transition-colors cursor-pointer ${open
            ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
            : 'text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
            }`}
        >
          <Settings2 className="w-3.5 h-3.5" />
        </button>
      </Tooltip>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 p-3">
          <DiffSettingsFields settings={settings} onChange={onChange} />
        </div>
      )}
    </div>
  )
}

// HeaderOverflowMenu is the small-screen hamburger that gathers the file header's
// actions (copy / raw) and view settings into one dropdown, keeping the header
// uncluttered on phones. It's rendered md:hidden - the desktop header shows the
// same controls inline. Children get a `close` callback (for the action rows;
// the settings toggles leave the menu open).
function HeaderOverflowMenu({ className = '', children }: { className?: string; children: (close: () => void) => ReactNode }) {
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

  return (
    <div ref={ref} className={`relative shrink-0 ${className}`}>
      <button
        aria-label="File actions"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center justify-center w-8 h-8 rounded-lg border transition-colors cursor-pointer ${open
          ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
          : 'text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
          }`}
      >
        <Menu className="w-4 h-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 p-1.5">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

// ── Tree rendering ──────────────────────────────────────────────────────────────

function TreeRow({
  node, depth, expanded, toggle, selectedPath, fileLink, showIcons,
}: {
  node: TreeNode
  depth: number
  expanded: Set<string>
  toggle: (path: string) => void
  selectedPath: string | null
  // Builds the <Link> target for a file leaf, so file rows are real anchors
  // (middle-click / Ctrl-click open them in a new tab). Dir rows just toggle.
  fileLink: (path: string) => LinkProps
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
          {/* One chevron rotated 90deg when open (not a Down/Right swap), so the
              twist tweens alongside the children's slide. */}
          <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-gray-400 transition-transform duration-200 ease-in-out ${isOpen ? 'rotate-90' : ''}`} />
          {showIcons && (node.artifact === 'dir'
            ? <Images className="w-4 h-4 shrink-0 text-pink-500" />
            : isOpen ? <FolderOpen className="w-4 h-4 shrink-0 text-blue-500" /> : <Folder className="w-4 h-4 shrink-0 text-blue-500" />)}
          <span className="truncate optical-center">{node.name}</span>
        </button>
        {/* Slide the children open/shut instead of snapping them in and out.
            CollapseSlide keeps them mounted through the closing glide and drops
            them afterwards, so a shut directory still costs nothing to render -
            which is what the old `isOpen && ...` bought and what a
            keep-everything-mounted tween would have thrown away on a big repo. */}
        <CollapseSlide open={isOpen}>
          {node.children.map((child) => (
            <TreeRow key={child.path} node={child} depth={depth + 1} expanded={expanded} toggle={toggle} selectedPath={selectedPath} fileLink={fileLink} showIcons={showIcons} />
          ))}
        </CollapseSlide>
      </div>
    )
  }

  const { Icon, className } = node.artifact === 'script'
    ? { Icon: Camera, className: 'text-pink-500' }
    : getFileIcon(node.name)
  return (
    <Link
      {...fileLink(node.path)}
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
      <span className="truncate optical-center">{node.name}</span>
    </Link>
  )
}

// ── File content pane ───────────────────────────────────────────────────────────

// The file pane is shared with the lightbox's text viewer - see CodePane.

// MarkdownView renders a markdown file (README) through the shared <Markdown>
// component in its document variant. linkCtx lets relative repo links resolve
// against the current file and navigate the repository view in-app (with
// middle/ctrl-click still opening the real href in a new tab).
function MarkdownView({ content, projectId, refStr, filePath }: { content: string; projectId: string; refStr: string; filePath: string }) {
  return (
    <Markdown
      text={content}
      variant="doc"
      linkCtx={{ projectId, refStr, filePath }}
      className="max-w-3xl mx-auto px-8 py-6 text-gray-800 dark:text-gray-200"
    />
  )
}

function FileContent({
  file, wrap, projectId, refStr, highlightRange, onSelectLine,
}: {
  file: RepositoryFileResponse
  wrap: boolean
  projectId: string
  refStr: string
  highlightRange?: LineRange | null
  onSelectLine?: (line: number, extend: boolean) => void
}) {
  // For symlinks, render the file we resolved to (target_path) - its extension
  // decides syntax highlighting / markdown / image handling, and the raw blob is
  // fetched from there. A symlink with no target_path couldn't be resolved.
  if (file.symlink && !file.target_path) {
    return (
      <div className="min-h-full flex flex-col items-center justify-center gap-3 text-center px-6 text-gray-400 dark:text-gray-500">
        <FileSymlink className="w-10 h-10" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-gray-600 dark:text-gray-300">Unresolved symbolic link</p>
          {file.symlink_target && (
            <p className="text-xs break-all">→ {file.symlink_target}</p>
          )}
          <p className="text-xs">The target doesn’t exist at this ref, points outside the repository, or is a directory.</p>
        </div>
      </div>
    )
  }
  const contentPath = file.target_path ?? file.path

  if (isImage(contentPath)) {
    const url = `/api/projects/${encodeURIComponent(projectId)}/repository/blob?path=${encodeURIComponent(contentPath)}&ref=${encodeURIComponent(refStr)}`
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
        Binary file ({formatBytes(file.size)}) - preview not available
      </div>
    )
  }

  if (isMarkdown(contentPath)) {
    return <MarkdownView content={file.content} projectId={projectId} refStr={refStr} filePath={contentPath} />
  }

  return (
    <>
      {/* The content head lets getLanguage fall back to a `#!` shebang for
          extension-less scripts; one line is all it reads. */}
      <CodePane content={file.content} lang={getLanguage(contentPath, file.content.slice(0, 200))} wrap={wrap} className="pt-2" highlightRange={highlightRange} onSelectLine={onSelectLine} />
      {file.truncated && (
        <div className="px-4 py-2 text-xs text-amber-600 dark:text-amber-400 border-t border-gray-200 dark:border-gray-700">
          File truncated - showing the first part only.
        </div>
      )}
    </>
  )
}

// ── File-not-found state ──────────────────────────────────────────────────────

// FileNotFound is shown when the requested path doesn't exist at the selected
// ref (a 404 from getRepositoryFile) - e.g. a stale deep link, or a file that
// only exists on another branch. A dedicated state reads more clearly than a raw
// error string.
function FileNotFound({ path, refStr }: { path: string; refStr: string }) {
  const slash = path.lastIndexOf('/')
  const directory = slash >= 0 ? path.slice(0, slash + 1) : ''
  const fileName = slash >= 0 ? path.slice(slash + 1) : path
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
      <FileQuestion className="w-12 h-12 text-gray-300 dark:text-gray-600" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">File not found</p>
        <p className="text-xs break-all">
          {directory && <span className="text-gray-400 dark:text-gray-500">{directory}</span>}
          <span className="text-gray-600 dark:text-gray-300">{fileName}</span>
        </p>
        <p className="text-xs text-gray-400 dark:text-gray-500">
          This file doesn’t exist at <span className="font-mono">{refStr}</span>.
        </p>
      </div>
    </div>
  )
}

// ── File path label ───────────────────────────────────────────────────────────

// FilePathLabel renders the selected file's path in the content header, the same
// way on mobile and desktop: the directory is lowlit and the filename
// emphasised, and when the path is too wide it's the *leading* directory that's
// clipped with a "..." - the filename stays visible (".../filename.go"), and only
// if the filename alone overflows does it clip at its own end. Tapping it expands
// to the full, wrapped path; tapping again collapses.
function FilePathLabel({ path }: { path: string }) {
  const [expanded, setExpanded] = useState(false)
  // Collapse again whenever the displayed file changes (adjusted during render so
  // the path never flashes expanded against the new file).
  const [prevPath, setPrevPath] = useState(path)
  if (prevPath !== path) { setPrevPath(path); setExpanded(false) }

  const slash = path.lastIndexOf('/')
  const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
  const name = slash >= 0 ? path.slice(slash + 1) : path

  if (expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="min-w-0 text-left text-sm break-all cursor-pointer"
      >
        {dir && <span className="text-gray-400 dark:text-gray-500">{dir}</span>}
        <span className="text-gray-700 dark:text-gray-300">{name}</span>
      </button>
    )
  }

  return (
    // min-w-0 also goes on the wrapper: it is the header's flex child now, and
    // without it the clipped path could no longer shrink.
    <Tooltip content={path} className="min-w-0">
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex items-center min-w-0 text-sm cursor-pointer"
      >
        {dir && (
          // Leading-ellipsis: the rtl block clips + ellipsises at the *start*,
          // while the inner plaintext span keeps the path reading left-to-right.
          // It shrinks far more eagerly than the filename (flex-shrink 9999 vs 1),
          // so the directory clips first and the filename only clips once it alone
          // can't fit.
          <span
            className="overflow-hidden whitespace-nowrap text-gray-400 dark:text-gray-500"
            style={{ direction: 'rtl', textOverflow: 'ellipsis', flexShrink: 9999, minWidth: 0 }}
          >
            <span style={{ unicodeBidi: 'plaintext' }}>{dir}</span>
          </span>
        )}
        <span className="truncate text-gray-700 dark:text-gray-300" style={{ flexShrink: 1, minWidth: 0 }}>
          {name}
        </span>
      </button>
    </Tooltip>
  )
}

// ── Settings persistence ──────────────────────────────────────────────────────

function loadBool(key: string, def: boolean): boolean {
  const v = readLocal(key)
  if (v === 'true') return true
  if (v === 'false') return false
  return def
}

// ── Page ────────────────────────────────────────────────────────────────────────

export function RepositoryView({ projectId, splat }: { projectId: string; splat: string }) {
  const navigate = useNavigate()
  const location = useLocation()
  // The compare-diff state that is promoted into the URL: ?compare=
  // (head ref) and ?dfile= (selected file in single-file mode). strict:false reads
  // them from whichever repository route matched (bare or splat).
  const search = useSearch({ strict: false }) as RepositorySearch

  // Seeded from the shared cache (lib/branchCache) so the branch pickers render
  // populated on the first frame; null only on a cold first visit to a project.
  const [branches, setBranches] = useState<RepositoryBranch[] | null>(
    () => peekBranches(projectId)?.branches ?? null,
  )
  const [currentBranch, setCurrentBranch] = useState('')
  // The cached name of HEAD, used to LABEL the branch trigger before the request
  // lands. Deliberately not folded into `currentBranch`: that one decides which
  // ref the tree/blob is fetched at, and a stale cached name there would fetch
  // the wrong ref. Worst case here is a stale label for one round trip.
  const cachedCurrentBranch = useMemo(() => peekBranches(projectId)?.current ?? '', [projectId])

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

  // ── Branch-compare diff view ──────────────────────────────────────────────
  // Picking a compare branch (head) diffs it against the browsed ref (base),
  // reusing the agent diff viewer's FileDiff/FileRow rendering. The compare ref
  // is the whole diff state - '' means "not diffing" - and lives in the URL's
  // ?compare= search param so a comparison (and a line selection
  // within it) is shareable and survives reload. The ref/path splat parser is
  // untouched: the diff state rides query params + the hash alongside it.
  const compareRef = search.compare ?? ''
  // On small screens the tree/changed-files list and the file/diff content are
  // shown one at a time as a drill-down (full-screen list → tap a file → full
  // file, with a back button). For normal browsing the URL path is the source of
  // truth; in diff mode it's this ephemeral flag, set when a changed file is
  // tapped and cleared by the back button (and whenever the diff target changes).
  const [mobileDiffOpen, setMobileDiffOpen] = useState(false)
  const [diff, setDiff] = useState<DiffResponse | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [collapsedDiffFiles, setCollapsedDiffFiles] = useState<Set<string>>(new Set())
  // Folders collapsed in the changed-files sidebar tree (tree view). Empty = all
  // folders open, matching the agent diff viewer; folders start expanded so every
  // changed file is visible without clicking.
  const [collapsedDiffFolders, setCollapsedDiffFolders] = useState<Set<string>>(new Set())
  // The diff defaults to one file at a time (the selected file only); absent
  // storage means the default, an explicit 'false' is the all-files view.
  const [diffSettings, setDiffSettings] = useState<DiffSettings>(() => {
    const storedMode = readLocal(StorageKeys.diffImageMode)
    const imageDiffMode: ImageDiffMode =
      storedMode === 'side-by-side' || storedMode === 'ab' || storedMode === 'slider' || storedMode === 'onion'
        ? storedMode : 'ab'
    const storedView = readLocal(StorageKeys.repoDiffFileView)
    const fileView: FileView =
      storedView === 'flat' || storedView === 'grouped' || storedView === 'tree' ? storedView : 'tree'
    return {
      fileView,
      singleFile: readLocal(StorageKeys.repoDiffSingleFile) !== 'false',
      sideBySide: readLocal(StorageKeys.diffSideBySide) === 'true',
      wordHighlight: readLocal(StorageKeys.diffWordHighlight) !== 'false',
      ignoreWhitespace: readLocal(StorageKeys.diffIgnoreWhitespace) === 'true',
      imageDiffMode,
    }
  })
  useEffect(() => { writeLocal(StorageKeys.repoDiffFileView, diffSettings.fileView) }, [diffSettings.fileView])
  useEffect(() => { writeLocal(StorageKeys.repoDiffSingleFile, String(diffSettings.singleFile)) }, [diffSettings.singleFile])
  useEffect(() => { writeLocal(StorageKeys.diffSideBySide, String(diffSettings.sideBySide)) }, [diffSettings.sideBySide])
  useEffect(() => { writeLocal(StorageKeys.diffWordHighlight, String(diffSettings.wordHighlight)) }, [diffSettings.wordHighlight])
  useEffect(() => { writeLocal(StorageKeys.diffIgnoreWhitespace, String(diffSettings.ignoreWhitespace)) }, [diffSettings.ignoreWhitespace])
  useEffect(() => { writeLocal(StorageKeys.diffImageMode, diffSettings.imageDiffMode) }, [diffSettings.imageDiffMode])
  // In one-file-at-a-time mode, the file whose diff is shown comes from the
  // ?dfile= search param (clicking a file in the sidebar sets it); it is derived
  // below (selectedDiffPath) once the diff has loaded, defaulting to the first
  // file when the param is absent or names a file not in the diff.
  // The selected diff file's blob metadata (content), fetched so the single-file
  // header can offer the same copy/raw actions as the normal file view.
  const [diffFileMeta, setDiffFileMeta] = useState<RepositoryFileResponse | null>(null)
  // Per-file revealed context (for the network-expand fallback on huge files),
  // and refs to each rendered diff card so the sidebar list can scroll to one.
  const [fileContexts, setFileContexts] = useState<Map<string, number>>(new Map())
  const fileContextsRef = useRef<Map<string, number>>(new Map())
  const diffFileRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Settings (wrap-on-by-default, popup, icons).
  const [settings, setSettings] = useState<RepoSettings>(() => ({
    wrap: loadBool(StorageKeys.repoWrap, true),
    showIcons: loadBool(StorageKeys.repoIcons, true),
  }))
  useEffect(() => { writeLocal(StorageKeys.repoWrap, String(settings.wrap)) }, [settings.wrap])
  useEffect(() => { writeLocal(StorageKeys.repoIcons, String(settings.showIcons)) }, [settings.showIcons])

  // Resizable sidebar.
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

  const parsed = useMemo(() => parseRepoSplat(splat, branches), [splat, branches])
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
    // No real .hydra folder in the tree - synthesize one holding just artifacts.
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
  // activeRef is which ref the view is on (what a diff compares against).
  const activeRef = parsed.ref ?? (currentBranch || 'HEAD')
  // What the branch selector shows as selected. On the bare /repository URL the
  // branch's NAME only arrives with the request, so until then use the cached
  // name, and failing that an empty ref (which renders a placeholder bar) rather
  // than flashing the literal "HEAD" and swapping it for the real name a moment
  // later. "HEAD" is still the label once the request has answered without
  // naming a branch.
  const activeLabelRef = parsed.ref ?? (currentBranch || cachedCurrentBranch || (branches === null ? '' : 'HEAD'))
  const isKnownBranch = !!branches?.some((b) => b.name === activeLabelRef)

  // Diff is "live" only once a distinct compare branch is chosen. compareKnown
  // drives the compare selector's known-branch vs short-SHA rendering.
  const compareKnown = !!branches?.some((b) => b.name === compareRef)
  const diffActive = !!compareRef && compareRef !== activeRef

  // The one-file-at-a-time selection, from ?dfile= when it names a file still in
  // the diff, else the diff's first file. null unless diffing in single-file
  // mode. The default is not written back to the URL - a clean /repository?compare
  // link lands on the first file - only an explicit click sets ?dfile=.
  const selectedDiffPath = (diffActive && diffSettings.singleFile && diff && diff.files.length > 0)
    ? (diff.files.some((f) => f.path === search.dfile) ? search.dfile! : diff.files[0].path)
    : null

  // Whether the content pane (not the list) is the active view on small screens.
  // For normal browsing that's an explicitly-selected path (the bare /repository
  // URL resolves to the README via defaultPath, but on a phone we still want to
  // land on the file list - so key off parsed.path, not viewPath). In diff mode
  // it's the drill-down flag. At/above the md breakpoint both panes show side by
  // side (the tree column fits comfortably from tablet widths up) and this only
  // decides which one fills the screen below it.
  const mobileContentOpen = diffActive ? mobileDiffOpen : !!parsed.path

  // The single-file view's selected file, plus the ref its blob lives at: the
  // compare (head) side for added/modified/renamed files, the base side for a
  // deleted file (which no longer exists at head).
  const selectedDiffFile = (diffActive && diffSettings.singleFile && selectedDiffPath)
    ? diff?.files.find((f) => f.path === selectedDiffPath) ?? null
    : null
  const selectedDiffFileRef = selectedDiffFile && selectedDiffFile.change_type === 'deleted' ? activeRef : compareRef

  // The path to display: the URL path, or the repo's default (README) on the
  // bare /repository URL.
  const viewPath = parsed.path ?? defaultPath

  // Only a LEGACY sentinel-free multi-segment splat needs the branch list to
  // resolve; wait for it there (so a slashed branch ref isn't briefly mis-parsed
  // and fetched at the wrong ref). Sentinel splats parse exactly on their own, so
  // they render immediately.
  const ready = !splatNeedsBranchList(splat) || branches !== null

  // Load branches once per project. The list is cleared during render (not in the
  // effect) when the project changes, so the fetch effect below just does the
  // async load. Init to the current id so no redundant clear fires on mount
  // (branches already starts null).
  const [prevBranchProject, setPrevBranchProject] = useState(projectId)
  if (prevBranchProject !== projectId) {
    setPrevBranchProject(projectId)
    // The new project's cached list if there is one, so the pickers stay
    // populated across a project switch instead of blanking.
    setBranches(peekBranches(projectId)?.branches ?? null)
    setCurrentBranch('')
  }
  useEffect(() => {
    let cancelled = false
    fetchBranches(projectId)
      .then((r) => { if (!cancelled) { setBranches(r.branches); setCurrentBranch(r.current) } })
      .catch(() => { if (!cancelled) { setBranches([]); setCurrentBranch('') } })
    return () => { cancelled = true }
  }, [projectId])

  // The tree + artifact-script fetch effects below share the same trigger
  // ([projectId, queryRef, ready]) and each clears its state to a loading value
  // synchronously before fetching. That reset runs during render here instead of
  // in the effect bodies. The null sentinel keeps the reset gated on `ready` (so
  // it also fires on the first ready render, showing the tree spinner on initial
  // load), matching the effects' `if (!ready) return` guards.
  const refFetchKey = ready ? `${projectId}\0${queryRef ?? ''}` : null
  const [prevRefFetchKey, setPrevRefFetchKey] = useState<string | null>(null)
  if (refFetchKey !== null && prevRefFetchKey !== refFetchKey) {
    setPrevRefFetchKey(refFetchKey)
    setTreeLoading(true)
    setTreeError(null)
    setArtifactScripts(null)
  }

  // Load the tree for the resolved ref.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    api.default.getRepositoryTree(projectId, queryRef)
      .then((resp) => {
        if (cancelled) return
        setFiles(resp.files)
        setDefaultPath(resp.default_path ?? null)
        // Collapse all folders by default; auto-expand only the
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

  // Load the artifact-script list for the resolved ref (cheap - config only, no
  // generation). Drives the dynamic ".hydra/artifacts" folder; [] hides it.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    api.default.getRepositoryArtifacts(projectId, queryRef)
      .then((r) => { if (!cancelled) setArtifactScripts(r.scripts.map((s) => s.name)) })
      .catch(() => { if (!cancelled) setArtifactScripts([]) })
    return () => { cancelled = true }
  }, [projectId, queryRef, ready])

  // Load the file content for the displayed path. Synthetic artifact paths are not
  // real files - they render the artifacts viewer instead - so skip the fetch.
  //
  // Clear the previously-shown file during render (not in the effect) so the pane
  // shows a loading icon instead of the stale file while the new one is fetched.
  // The key is null when there's nothing to fetch (not ready / no path / an
  // artifact path), so both the inactive case (just clear the file) and the active
  // case (clear + raise loading) are covered by the key going null <-> a value.
  // The null init makes the loading reset fire on the first active render too.
  const fileFetchActive = ready && !!viewPath && !artifactScriptOf(viewPath)
  const fileFetchKey = fileFetchActive ? `${projectId}\0${queryRef ?? ''}\0${viewPath}` : null
  const [prevFileFetchKey, setPrevFileFetchKey] = useState<string | null>(null)
  if (prevFileFetchKey !== fileFetchKey) {
    setPrevFileFetchKey(fileFetchKey)
    setFile(null)
    if (fileFetchKey !== null) {
      setFileLoading(true)
      setError(null)
      setNotFound(false)
    }
  }
  useEffect(() => {
    if (!ready || !viewPath || artifactScriptOf(viewPath)) return
    let cancelled = false
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
  }, [projectId, queryRef, viewPath, ready])

  // A file deep-link can carry an #L<n> / #L<a>-L<b> hash (e.g. a file://
  // hyperlink clicked in the agent terminal, or a line number clicked here) -
  // the line(s) to highlight, with the first one scrolled into view.
  const selRange = useMemo(() => parseLineRange(location.hash || ''), [location.hash])
  // The anchor a shift+click extends from: the last plainly-clicked line. Kept
  // in a ref (not state) so it survives without re-rendering. Seeded from the
  // initial range (a deep link) and cleared on file change; a shift+click with
  // no anchor falls back to the current selection's start, so a deep-linked
  // range still extends correctly.
  const anchorRef = useRef<number | null>(selRange?.start ?? null)
  useEffect(() => { anchorRef.current = null }, [viewPath])

  // Select a line by clicking its gutter number. A plain click selects just that
  // line and becomes the new anchor; shift+click extends the selection from the
  // anchor to the clicked line. Either way the URL hash is updated so the
  // selection is shareable and survives a reload.
  const selectLine = useCallback((line: number, extend: boolean) => {
    let start = line
    let end = line
    if (extend) {
      const anchor = anchorRef.current ?? selRange?.start ?? line
      start = Math.min(anchor, line)
      end = Math.max(anchor, line)
    } else {
      anchorRef.current = line
    }
    navigate({
      to: '/project/$projectId/repository/$',
      params: { projectId, _splat: splat },
      hash: formatLineHash(start, end),
    })
  }, [navigate, projectId, splat, selRange])

  // The compare-diff's line selection also rides the URL hash, but side-aware:
  // #L<n> selects on the old/base column, #R<n> on the new/head column (ranges
  // #L5-L10 / #R5-R10). It only applies to the one-file-at-a-time view, where
  // ?dfile= names the file the line belongs to; the stacked all-files view keeps
  // its selection local per FileDiff (the hash can't name which file).
  const diffSelRange = useMemo(() => parseDiffLineRange(location.hash || ''), [location.hash])
  const diffAnchorRef = useRef<{ side: DiffSide; line: number } | null>(
    diffSelRange ? { side: diffSelRange.side, line: diffSelRange.start } : null,
  )
  // Reset the shift-anchor when the selected diff file changes (its lines are a
  // different file's), mirroring the file view's per-file anchor reset.
  useEffect(() => { diffAnchorRef.current = null }, [selectedDiffPath])
  const selectDiffLine = useCallback((side: DiffSide, line: number, extend: boolean) => {
    let start = line
    let end = line
    // Extend only along the same side the anchor was set on; a shift+click on the
    // other column starts a fresh single-line selection there.
    if (extend && diffAnchorRef.current?.side === side) {
      const anchor = diffAnchorRef.current.line
      start = Math.min(anchor, line)
      end = Math.max(anchor, line)
    } else {
      diffAnchorRef.current = { side, line }
    }
    navigate({
      to: '/project/$projectId/repository/$',
      params: { projectId, _splat: splat },
      search: (prev) => prev,
      hash: formatDiffLineHash(side, start, end),
    })
  }, [navigate, projectId, splat])

  // Position the content when the displayed file (or selection) changes: scroll
  // the selection's first row into view if it isn't already visible, otherwise
  // reset to the top. Clicking an already-visible line thus
  // doesn't jump the view; a deep link to an off-screen line does. Runs after
  // FileContent renders, so the data-line row exists; markdown/binary/image
  // files have no such row and fall back to the top.
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // The diff view drives its own scroll below; the pane is shared, so skip the
    // file-view positioning while diffing (its reset-to-top would fight it).
    if (diffActive) return
    const el = contentRef.current
    if (!el) return
    if (selRange) {
      const target = el.querySelector(`[data-line="${selRange.start}"]`)
      if (target) {
        const cr = el.getBoundingClientRect()
        const tr = target.getBoundingClientRect()
        if (tr.top < cr.top || tr.bottom > cr.bottom) target.scrollIntoView({ block: 'center' })
        return
      }
    }
    el.scrollTop = 0
    // selRange is memoized on location.hash, so its identity is stable until
    // the selection actually changes.
  }, [viewPath, file, selRange, diffActive])

  // Scroll a deep-linked compare-diff selection into view: the single-file view's
  // #L<n>/#R<n> first row, if it isn't already visible. Runs when the diff, the
  // selected file, or the selection changes, after FileDiff has rendered the rows
  // (each gutter number carries data-diff-ln="<side>:<num>"). A line hidden behind
  // a collapsed context region has no row and is simply left un-scrolled.
  useEffect(() => {
    if (!diffActive || !diffSettings.singleFile || !diffSelRange) return
    const el = contentRef.current
    if (!el) return
    const target = el.querySelector(`[data-diff-ln="${diffSelRange.side}:${diffSelRange.start}"]`)
    if (!target) return
    const cr = el.getBoundingClientRect()
    const tr = target.getBoundingClientRect()
    if (tr.top < cr.top || tr.bottom > cr.bottom) target.scrollIntoView({ block: 'center' })
  }, [diffActive, diffSettings.singleFile, selectedDiffPath, diff, diffSelRange])

  // Fetch the branch-compare diff (base = browsed ref, head = compareRef). Uses
  // full_context so context can be revealed client-side without round-trips.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- legitimate data-fetch effect: the synchronous reset-to-loading on compare-key change is intentional and can't move to render because it sits alongside the fileContextsRef.current reset (a ref write, which would trip react-hooks/refs during render). The cascading render is desired - it immediately clears stale diff content.
    if (!diffActive) { setDiff(null); setDiffError(null); return }
    let cancelled = false
    setDiffLoading(true)
    setDiffError(null)
    fileContextsRef.current = new Map()
    setFileContexts(new Map())
    setCollapsedDiffFiles(new Set())
    api.default.getRepositoryDiff(projectId, activeRef, compareRef, diffSettings.ignoreWhitespace, undefined, 3, true)
      .then((r) => { if (!cancelled) setDiff(r) })
      .catch((err) => { if (!cancelled) { setDiff(null); setDiffError(formatError(err)) } })
      .finally(() => { if (!cancelled) setDiffLoading(false) })
    return () => { cancelled = true }
  }, [diffActive, projectId, activeRef, compareRef, diffSettings.ignoreWhitespace])

  // Leaving diff mode or retargeting the comparison drops the mobile drill-down
  // back to the changed-files list (so it never opens onto a stale selection).
  // Done as a during-render reset keyed on (diffActive, compareRef); init to the
  // current key so no reset fires on mount (it starts closed anyway).
  const mobileDiffResetKey = `${diffActive}\0${compareRef}`
  const [prevMobileDiffResetKey, setPrevMobileDiffResetKey] = useState(mobileDiffResetKey)
  if (prevMobileDiffResetKey !== mobileDiffResetKey) {
    setPrevMobileDiffResetKey(mobileDiffResetKey)
    setMobileDiffOpen(false)
  }

  // Fetch the selected file's blob so the single-file header's copy/raw buttons
  // (reused FileActions) act on its actual content. Binary files still get a
  // working "Raw" link; the copy button hides itself when there's no content.
  // Clear the stale blob metadata during render (both the inactive case and the
  // active reset are just setDiffFileMeta(null), so the null-sentinel key covers
  // both); init to the current key so no redundant clear fires on mount.
  const diffFileMetaKey = selectedDiffFile
    ? `${projectId}\0${selectedDiffFile.path}\0${selectedDiffFileRef}`
    : null
  const [prevDiffFileMetaKey, setPrevDiffFileMetaKey] = useState(diffFileMetaKey)
  if (prevDiffFileMetaKey !== diffFileMetaKey) {
    setPrevDiffFileMetaKey(diffFileMetaKey)
    setDiffFileMeta(null)
  }
  useEffect(() => {
    if (!selectedDiffFile) return
    let cancelled = false
    api.default.getRepositoryFile(projectId, selectedDiffFile.path, selectedDiffFileRef)
      .then((r) => { if (!cancelled) setDiffFileMeta(r) })
      .catch(() => { if (!cancelled) setDiffFileMeta(null) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, selectedDiffFile?.path, selectedDiffFileRef])

  // Selection from the diff branch selector. Picking the base branch (the one
  // being browsed) or the currently-diffed branch again exits diff mode; any
  // other branch becomes the new compare target. Writes ?compare= to the URL and
  // clears the file/line selection (a new comparison starts on its first file).
  const onDiffSelect = (name: string) => {
    const next = (name === activeRef || name === compareRef) ? undefined : name
    navigate({
      to: '/project/$projectId/repository/$',
      params: { projectId, _splat: splat },
      search: { compare: next },
    })
  }

  const toggleDiffFileCollapse = useCallback((path: string) => {
    setCollapsedDiffFiles((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // Revealing context in a file the bulk response left windowed (FileDiff's
  // `-U3` fallback). Same deal as the agent diff's expandFileDiff: ask for that
  // one file in full and let it switch to the client-side reveal model, so later
  // expanders are instant and only open the gap they belong to; a file too big
  // even for that comes back at the wider windowed context in the same response.
  const expandDiffFile = useCallback(async (path: string, context = 3) => {
    try {
      const fileDiff = await api.default.getRepositoryDiff(projectId, activeRef, compareRef, diffSettings.ignoreWhitespace, path, context,
        true, PROMOTED_MAX_CHANGES, PROMOTED_MAX_LINES)
      const updated = fileDiff.files.find((x) => x.path === path)
      const promoted = !!updated?.expanded
      if (!promoted) {
        fileContextsRef.current.set(path, context)
        setFileContexts(new Map(fileContextsRef.current))
      }
      setDiff((prev) => prev
        ? { ...prev, files: prev.files.map((f) => f.path === path ? { ...f, hunks: updated?.hunks ?? [], expanded: promoted, total_lines: updated?.total_lines ?? f.total_lines } : f) }
        : prev)
    } catch (e) {
      console.error('Failed to fetch repository file diff:', e)
    }
  }, [projectId, activeRef, compareRef, diffSettings.ignoreWhitespace])

  const noopComment = useCallback(() => {}, [])
  const getDiffFileRef = (path: string) => (el: HTMLDivElement | null) => {
    if (el) diffFileRefs.current.set(path, el)
    else diffFileRefs.current.delete(path)
  }
  const scrollToDiffFile = (path: string) => {
    const el = diffFileRefs.current.get(path)
    if (el) scrollCardToTop(el)
  }

  // Clicking a changed file in the sidebar: in one-file mode it selects the file
  // (writing ?dfile= and clearing any line hash), otherwise it scrolls the
  // stacked diff to that file's card. On small screens it also drills into the
  // full-screen content view (the back button returns).
  const onDiffFileClick = (path: string) => {
    if (diffSettings.singleFile) {
      navigate({
        to: '/project/$projectId/repository/$',
        params: { projectId, _splat: splat },
        search: (prev) => ({ compare: prev.compare, dfile: path }),
      })
    } else {
      scrollToDiffFile(path)
    }
    setMobileDiffOpen(true)
  }
  const activeDiffPath = diffSettings.singleFile ? selectedDiffPath : null
  const toggleDiffFolder = useCallback((path: string) => {
    setCollapsedDiffFolders((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // Navigate (history push) to a ref + path; empty path goes to the ref root.
  // Keeps ?compare= (so switching the base branch re-diffs against the new base)
  // but drops the file/line selection, which belonged to the old comparison.
  const goTo = (ref: string, path: string | null) => {
    const sp = buildRepoSplat(ref, path)
    navigate({
      to: '/project/$projectId/repository/$',
      params: { projectId, _splat: sp },
      search: (prev) => ({ compare: prev.compare }),
    })
  }
  const selectBranch = (name: string) => goTo(name, parsed.path)
  // <Link> target for a file at the current ref - used by the tree so file rows
  // are real anchors (middle-click / Ctrl-click open them in a new tab).
  const fileLinkProps = (path: string): LinkProps => linkOptions({
    to: '/project/$projectId/repository/$',
    params: { projectId, _splat: buildRepoSplat(refStr, path) },
  })

  // Small-screen "back": pop the full-screen content view back to the list. In
  // diff mode that's the drill-down flag; when browsing it clears the file path
  // (to the ref root) so the tree fills the screen again.
  const backToList = () => {
    if (diffActive) setMobileDiffOpen(false)
    else goTo(refStr, null)
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* Top header - the page title plus the branch picker and the compare /
          diff selector, all hoisted up here (they used to live in the sidebar's
          own header row). On small screens it's hidden once a file/diff is open:
          the content pane's own header takes over there, with a back button. */}
      <div
        className={`shrink-0 h-12 px-3 sm:px-4 items-center gap-2 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 ${mobileContentOpen ? 'hidden md:flex' : 'flex'}`}
      >
        {/* The base picker always sizes to its own content (it stays
            shrink-0 + truncates at its own max width). Keeping it un-shrinkable
            means a short base like "main" can't collapse to a bare icon when the
            long head selector is fighting for room beside it on a narrow header.
            It renders as a dropdown from the first frame - `branches: null` is
            its own loading state inside the same chrome. */}
        <BranchSelector
          branches={branches}
          activeRef={activeLabelRef}
          isKnownBranch={isKnownBranch}
          onSelect={selectBranch}
        />
        {diffActive && branches !== null ? (
          // Diffing: "base → head", each capped + clipped so they stay compact.
          // Gated on branches being loaded: a deep-linked ?compare= makes diff
          // mode active before the branch list arrives, and the head selector
          // needs it (it looks the ref up in the list).
          <>
            <ArrowRightLeft className="w-4 h-4 text-gray-400 dark:text-gray-500 shrink-0" />
            <div className="flex min-w-0 max-w-[11rem] shrink">
              <BranchSelector
                branches={branches}
                activeRef={compareRef}
                isKnownBranch={compareKnown}
                onSelect={onDiffSelect}
                title="Change or exit branch diff"
                flexible
              />
            </div>
          </>
        ) : (
          <>
            {/* Shown while the list is still loading too (`branches === null`),
                so the header doesn't gain a button a beat after it paints; only
                a repo that genuinely has no branches drops it. */}
            {(branches === null || branches.length > 0) && (
              <BranchSelector
                branches={branches}
                activeRef=""
                isKnownBranch={false}
                onSelect={onDiffSelect}
                title="Compare with another branch"
                triggerIcon={GitCompareArrows}
              />
            )}
            <span className="ml-auto text-xs text-gray-400 dark:text-gray-500 shrink-0">
              {files.length} {files.length === 1 ? 'file' : 'files'}
            </span>
          </>
        )}
      </div>
      <div className="flex-1 flex min-w-0 min-h-0 bg-white dark:bg-gray-900">
      {/* File / folder picker. Full-width on phones (the content pane is a
          separate full-screen view there); a fixed, resizable column at md+. */}
      <div
        ref={sidebarRef}
        style={{ width: sidebarWidth }}
        className={`relative shrink-0 border-r border-gray-200 dark:border-gray-700 flex-col bg-gray-50 dark:bg-gray-800/40 max-md:!w-full ${mobileContentOpen ? 'hidden md:flex' : 'flex'}`}
      >
        <div className="flex-1 overflow-y-auto py-1">
          {diffActive ? (
            diffLoading && !diff ? (
              <div className="flex items-center justify-center py-8 text-gray-400">
                <LoaderCircle className="w-4 h-4 animate-spin" />
              </div>
            ) : diffError ? (
              <div className="px-3 py-4 text-xs text-red-500 text-center">{diffError}</div>
            ) : diff && diff.files.length === 0 ? (
              <div className="px-3 py-4 text-xs text-gray-400 dark:text-gray-500 text-center">No differences</div>
            ) : diff ? (
              diffSettings.fileView === 'tree' ? (
                compactDiffTree(buildFileTree(diff.files)).map((node) => (
                  <TreeNodeView
                    key={node.path}
                    node={node}
                    depth={0}
                    collapsedFolders={collapsedDiffFolders}
                    toggleFolder={toggleDiffFolder}
                    onFileClick={onDiffFileClick}
                    activeFilePath={activeDiffPath}
                  />
                ))
              ) : diffSettings.fileView === 'grouped' ? (
                getGroupedFiles(diff.files).map(([folder, groupFiles]) => (
                  <div key={folder || '__root__'}>
                    {folder && (
                      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-50 dark:bg-gray-700/50 border-y border-gray-100 dark:border-gray-700/50">
                        <Folder className="w-3 h-3 text-blue-400 dark:text-blue-500 shrink-0" />
                        <span className="text-3xs text-gray-500 dark:text-gray-400 truncate flex-1 min-w-0">{folder}</span>
                      </div>
                    )}
                    {groupFiles.map((f) => (
                      <FileRow
                        key={f.path}
                        file={f}
                        isActive={f.path === activeDiffPath}
                        onClick={() => onDiffFileClick(f.path)}
                        indent={folder ? 4 : 0}
                      />
                    ))}
                  </div>
                ))
              ) : (
                diff.files.map((f) => (
                  <FileRow
                    key={f.path}
                    file={f}
                    isActive={f.path === activeDiffPath}
                    onClick={() => onDiffFileClick(f.path)}
                  />
                ))
              )
            ) : null
          ) : treeLoading ? (
            <div className="flex items-center justify-center py-8 text-gray-400">
              <LoaderCircle className="w-4 h-4 animate-spin" />
            </div>
          ) : treeError ? (
            <div className="px-3 py-4 text-xs text-red-500 text-center">{treeError}</div>
          ) : displayTree.length === 0 ? (
            <div className="px-3 py-4 text-xs text-gray-400 dark:text-gray-500 text-center">No tracked files</div>
          ) : (
            displayTree.map((node) => (
              <TreeRow key={node.path} node={node} depth={0} expanded={expanded} toggle={toggle} selectedPath={viewPath} fileLink={fileLinkProps} showIcons={settings.showIcons} />
            ))
          )}
        </div>

        {/* Resize handle - md+ only; the sidebar is full-width on
            phones. */}
        <div
          onMouseDown={startResizing}
          className="hidden md:block absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-500/30 transition-colors z-20"
        />
      </div>

      {/* Picked file. A full-screen view on phones (its header doubles as the
          page header there, with a back button); the right pane at md+. */}
      <div className={`flex-1 flex-col min-w-0 ${mobileContentOpen ? 'flex' : 'hidden md:flex'}`}>
        <div className="px-3 sm:px-4 py-2 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2 shrink-0">
          <Tooltip content="Back to files">
            <button
              type="button"
              aria-label="Back to files"
              onClick={backToList}
              className="md:hidden shrink-0 -ml-1 w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          </Tooltip>
          {diffActive ? (
            selectedDiffFile ? (
              // One-file-at-a-time view: a file-view-style header for the selected
              // file - icon, path, change-type tag, line counts, then the same
              // copy/raw actions as the normal file view, and the diff settings.
              <>
                {(() => { const { Icon, className } = getFileIcon(selectedDiffFile.path.split('/').pop() ?? selectedDiffFile.path); return <Icon className={`w-4 h-4 shrink-0 ${className}`} /> })()}
                {selectedDiffFile.change_type === 'renamed' && selectedDiffFile.old_path ? (
                  <span className="text-sm text-gray-700 dark:text-gray-300 truncate">
                    {(() => {
                      const renamedPath = (path: string) => {
                        const slash = path.lastIndexOf('/')
                        const directory = slash >= 0 ? path.slice(0, slash + 1) : ''
                        const fileName = slash >= 0 ? path.slice(slash + 1) : path
                        return <>
                          {directory && <span className="text-gray-400 dark:text-gray-500">{directory}</span>}
                          <span>{fileName}</span>
                        </>
                      }
                      return <>{renamedPath(selectedDiffFile.old_path)} <span className="text-gray-400 dark:text-gray-500">→</span> {renamedPath(selectedDiffFile.path)}</>
                    })()}
                  </span>
                ) : (
                  <FilePathLabel path={selectedDiffFile.path} />
                )}
                <ChangeTypeIcon type={selectedDiffFile.change_type} />
                <div className="flex items-center gap-2 shrink-0 ml-auto">
                  {!selectedDiffFile.binary && (selectedDiffFile.additions > 0 || selectedDiffFile.deletions > 0) && (
                    <div className="flex items-center gap-1.5">
                      {selectedDiffFile.additions > 0 && <span className="text-xs text-green-600 dark:text-green-400 font-medium">+{selectedDiffFile.additions}</span>}
                      {selectedDiffFile.deletions > 0 && <span className="text-xs text-red-600 dark:text-red-400 font-medium">-{selectedDiffFile.deletions}</span>}
                    </div>
                  )}
                  {/* Inline on desktop; folded into the hamburger on phones. */}
                  <div className="hidden md:flex items-center gap-2">
                    {diffFileMeta && <FileActions file={diffFileMeta} projectId={projectId} refStr={selectedDiffFileRef} />}
                    <DiffSettingsPopup settings={diffSettings} onChange={setDiffSettings} />
                  </div>
                  <HeaderOverflowMenu className="md:hidden">
                    {(close) => (
                      <>
                        {diffFileMeta && (
                          <>
                            <FileActionMenuRows file={diffFileMeta} projectId={projectId} refStr={selectedDiffFileRef} onAction={close} />
                            <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
                          </>
                        )}
                        <div className="px-1.5 py-1"><DiffSettingsFields settings={diffSettings} onChange={setDiffSettings} /></div>
                      </>
                    )}
                  </HeaderOverflowMenu>
                </div>
              </>
            ) : (
              // All-files view (or while loading): the diff settings - a popup on
              // desktop, the hamburger on phones.
              <div className="ml-auto flex items-center">
                <div className="hidden md:block"><DiffSettingsPopup settings={diffSettings} onChange={setDiffSettings} /></div>
                <HeaderOverflowMenu className="md:hidden">
                  {() => <div className="px-1.5 py-1"><DiffSettingsFields settings={diffSettings} onChange={setDiffSettings} /></div>}
                </HeaderOverflowMenu>
              </div>
            )
          ) : viewPath ? (
            <>
              {artifactScript
                ? <Camera className={`w-4 h-4 shrink-0 ${settings.showIcons ? 'text-pink-500' : 'text-gray-400'}`} />
                : file?.symlink
                  ? <FileSymlink className={`w-4 h-4 shrink-0 ${settings.showIcons ? 'text-teal-500' : 'text-gray-400'}`} />
                  : (() => { const { Icon, className } = getFileIcon(viewPath.split('/').pop() ?? viewPath); return <Icon className={`w-4 h-4 shrink-0 ${settings.showIcons ? className : 'text-gray-400'}`} /> })()}
              <FilePathLabel path={viewPath} />
              {file?.symlink && file.symlink_target && (
                <span className="flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500 truncate shrink min-w-0" title={`Symlink → ${file.symlink_target}`}>
                  <CornerDownRight className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{file.symlink_target}</span>
                </span>
              )}
              {fileLoading && <LoaderCircle className="w-3.5 h-3.5 shrink-0 animate-spin text-gray-400" />}
              <div className="ml-auto flex items-center gap-1.5 shrink-0">
                {file && <span className="text-xs text-gray-400 dark:text-gray-500">{formatBytes(file.size)}</span>}
                {/* Copy / raw / settings sit inline on desktop and fold into the
                    hamburger on phones. */}
                <div className="hidden md:flex items-center gap-1.5">
                  {file && !artifactScript && <FileActions file={file} projectId={projectId} refStr={refStr} />}
                  <SettingsPopup settings={settings} onChange={setSettings} />
                </div>
                <HeaderOverflowMenu className="md:hidden">
                  {(close) => (
                    <>
                      {file && !artifactScript && (
                        <>
                          <FileActionMenuRows file={file} projectId={projectId} refStr={refStr} onAction={close} />
                          <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
                        </>
                      )}
                      <div className="px-1.5 py-1"><RepoSettingsFields settings={settings} onChange={setSettings} /></div>
                    </>
                  )}
                </HeaderOverflowMenu>
              </div>
            </>
          ) : (
            <div className="ml-auto"><SettingsPopup settings={settings} onChange={setSettings} /></div>
          )}
        </div>

        <div ref={contentRef} className="flex-1 flex flex-col min-h-0 overflow-auto">
          {diffActive ? (
            diffLoading && !diff ? (
              <div className="flex-1 flex items-center justify-center text-gray-400">
                <LoaderCircle className="w-5 h-5 animate-spin" />
              </div>
            ) : diffError ? (
              <div className="flex-1 flex items-center justify-center text-sm text-red-500 px-4 text-center">{diffError}</div>
            ) : diff && diff.files.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-gray-500 px-4 text-center">
                <GitCompareArrows className="w-8 h-8" />
                <span className="text-sm">No differences between <span className="font-mono">{activeRef}</span> and <span className="font-mono">{compareRef}</span></span>
              </div>
            ) : diff ? (
              // The one-file-at-a-time view fills the pane like the file viewer
              // (gutter flush to the edge); the all-files view keeps card padding.
              <div className={diffSettings.singleFile ? '' : 'p-4'}>
                {(diffSettings.singleFile
                  ? diff.files.filter((f) => f.path === selectedDiffPath)
                  : diff.files
                ).map((f) => (
                  <FileDiff
                    key={f.path}
                    file={f}
                    sideBySide={diffSettings.sideBySide}
                    wordHighlight={diffSettings.wordHighlight}
                    isCollapsed={collapsedDiffFiles.has(f.path)}
                    onToggleCollapse={toggleDiffFileCollapse}
                    onComment={noopComment}
                    onExpand={expandDiffFile}
                    currentContext={fileContexts.get(f.path) ?? 3}
                    fileRef={getDiffFileRef(f.path)}
                    readOnly
                    headless={diffSettings.singleFile}
                    imageDiffMode={diffSettings.imageDiffMode}
                    // Branch-compare diff: both sides are real refs (base =
                    // browsed ref, head = compare ref). Missing side → null.
                    imageBefore={f.change_type === 'added' ? null : repoBlobUrl(projectId, f.old_path || f.path, activeRef)}
                    imageAfter={f.change_type === 'deleted' ? null : repoBlobUrl(projectId, f.path, compareRef)}
                    // Single-file view: drive the line selection from the URL hash
                    // (#L/#R) so it is deep-linkable. The stacked view leaves it
                    // uncontrolled (local per-file) - the hash can't name a file.
                    selection={diffSettings.singleFile ? diffSelRange : undefined}
                    onSelectLine={diffSettings.singleFile ? selectDiffLine : undefined}
                  />
                ))}
              </div>
            ) : null
          ) : artifactScript ? (
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
            // Keyed by path so a new file re-mounts + re-runs the fade-in.
            <div key={viewPath} className="repo-file-in flex-1 flex flex-col min-h-0">
              <FileContent file={file} wrap={settings.wrap} projectId={projectId} refStr={refStr} highlightRange={selRange} onSelectLine={selectLine} />
            </div>
          ) : null}
        </div>
      </div>

      {isResizing && <div className="fixed inset-0 z-[100] cursor-col-resize" />}
      </div>
    </div>
  )
}
