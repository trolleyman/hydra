import { Folder } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tooltip } from './Tooltip'

/**
 * The shared tooltip for a directory path: one folder icon and one emphasis
 * level across the whole path. Unlike a file path, a directory has no basename
 * that should read louder than its parents.
 */
export function DirectoryTooltip({ path, children, className = '' }: {
  path: string
  children: ReactNode
  className?: string
}) {
  return (
    <Tooltip
      content={(
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Folder className="h-3.5 w-3.5 shrink-0 text-blue-500" aria-hidden="true" />
          <span className="break-all text-stone-700 dark:text-stone-200">{path}</span>
        </span>
      )}
      align="left"
      className={className}
    >
      {children}
    </Tooltip>
  )
}
