import type { ReactNode } from 'react'

// A branch name rendered as an inline mono pill, the way the update-from-base
// dialog and the merge toasts embed branch names mid-sentence.
export function BranchPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-gray-100 dark:bg-gray-700/60 border border-gray-200 dark:border-gray-600 px-1.5 py-px font-mono text-[0.9em] text-gray-700 dark:text-gray-200 align-baseline">
      {children}
    </span>
  )
}
