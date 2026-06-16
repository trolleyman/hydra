// Shared file-icon mapping used by both the repository browser
// (RepositoryView) and the diff viewer (DiffViewer) so files render with the
// same icon + colour in both places. Originally lived in RepositoryView.

import {
  File as FileIcon, FileText, FileCode, FileJson, FileImage, FileCog,
  Info, Scale, Bot, GitBranch, Braces,
} from 'lucide-react'

export type IconSpec = { Icon: typeof FileIcon; className: string }

// Source-code extensions that fall back to a generic code icon when not matched
// by a more specific case in getFileIcon. Mirrors RepositoryView's EXT_LANG_MAP
// keys (kept as a standalone set here so this module has no other dependencies).
const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'go', 'rs', 'py', 'rb', 'java',
  'c', 'cpp', 'h', 'cs', 'php', 'css', 'scss', 'less', 'html', 'xml',
  'json', 'yaml', 'yml', 'toml', 'sh', 'bash', 'zsh', 'md', 'sql',
  'kt', 'swift', 'dart', 'r', 'dockerfile', 'makefile',
])

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i

// getFileIcon maps a filename (not a full path) to a lucide icon + tailwind
// colour class, picking type-specific icons for common languages and special
// files (README, LICENSE, .gitignore, …).
export function getFileIcon(name: string): IconSpec {
  const lower = name.toLowerCase()
  if (lower === 'readme.md' || lower === 'readme') return { Icon: Info, className: 'text-blue-500' }
  if (lower === 'claude.md' || lower === 'gemini.md' || lower === 'agents.md') return { Icon: Bot, className: 'text-purple-500' }
  if (lower.startsWith('license')) return { Icon: Scale, className: 'text-amber-500' }
  if (lower === '.gitignore' || lower === '.gitattributes' || lower.startsWith('.git')) return { Icon: GitBranch, className: 'text-orange-500' }
  if (IMAGE_EXT_RE.test(name)) return { Icon: FileImage, className: 'text-emerald-500' }
  const ext = lower.split('.').pop() ?? ''
  switch (ext) {
    case 'md':
    case 'markdown':
      return { Icon: FileText, className: 'text-blue-400' }
    case 'toml':
    case 'yaml':
    case 'yml':
    case 'ini':
    case 'conf':
      return { Icon: FileCog, className: 'text-gray-500' }
    case 'json':
      return { Icon: FileJson, className: 'text-yellow-500' }
    case 'go':
      return { Icon: FileCode, className: 'text-cyan-500' }
    case 'ts':
    case 'tsx':
      return { Icon: FileCode, className: 'text-blue-500' }
    case 'js':
    case 'jsx':
      return { Icon: FileCode, className: 'text-yellow-400' }
    case 'rs':
      return { Icon: FileCode, className: 'text-orange-400' }
    case 'py':
      return { Icon: FileCode, className: 'text-green-500' }
    case 'css':
    case 'scss':
    case 'less':
    case 'html':
    case 'xml':
      return { Icon: Braces, className: 'text-pink-500' }
  }
  if (CODE_EXTS.has(ext)) return { Icon: FileCode, className: 'text-gray-400' }
  return { Icon: FileIcon, className: 'text-gray-400' }
}

// changeTypeTextClass colours a filename in the diff viewer to convey its git
// change type (the diff list no longer uses a change-type icon now that the
// file-type icon matches the repo view): green = added, red+strikethrough =
// deleted, blue = renamed, default grey = modified.
export function changeTypeTextClass(type: string): string {
  switch (type) {
    case 'added': return 'text-green-600 dark:text-green-400'
    case 'deleted': return 'text-red-600 dark:text-red-400 line-through'
    case 'renamed': return 'text-blue-600 dark:text-blue-400'
    default: return 'text-gray-700 dark:text-gray-300'
  }
}
