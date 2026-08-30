import type { ReactNode } from 'react'
import { getFileIcon } from '../lib/fileIcons'

/**
 * A repository-style file label: file-kind icon, quiet directory, readable
 * basename. Chat tool cards, review comments, and file-change headers share it
 * so paths do not drift into one-off bullets or filename-only treatments.
 */
export function FilePathLabel({ path, className = '', trailing, nativeTitle = true }: {
  path: string
  className?: string
  trailing?: ReactNode
  /** Suppress the browser tooltip when this label already sits in <Tooltip>. */
  nativeTitle?: boolean
}) {
  const slash = path.lastIndexOf('/')
  const directory = slash >= 0 ? path.slice(0, slash + 1) : ''
  const fileName = slash >= 0 ? path.slice(slash + 1) : path
  const { Icon, className: iconClassName } = getFileIcon(fileName)

  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`} title={nativeTitle ? path : undefined}>
      <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClassName}`} aria-hidden="true" />
      <span className="min-w-0 truncate">
        {directory && <span className="text-stone-400 dark:text-stone-500">{directory}</span>}
        <span className="text-stone-700 dark:text-stone-200">{fileName}</span>
      </span>
      {trailing}
    </span>
  )
}
