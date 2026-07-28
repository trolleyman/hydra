import type { ReactNode } from 'react'

// A branch name rendered as an inline mono pill, the way the update-from-base
// dialog and the merge toasts embed branch names mid-sentence.
//
// inline-BLOCK, not inline-flex. `align-baseline` only does something if the box
// HAS a baseline to align, and per Flexbox 8.3 a flex container exposes one only
// when an item of its own takes part in baseline alignment - with `items-center`
// none did, so the pill synthesized a baseline from its border box and rode 2.8px
// high against the prose around it. There is one text child here and nothing to
// lay out, so a flex container was never buying anything; as an inline-block the
// pill's baseline is its text's baseline, which is what `align-baseline` needs.
// This also lets it sit in a baseline-aligned flex row (the toast status line).
export function BranchPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rounded-md bg-gray-100 dark:bg-gray-700/60 border border-gray-200 dark:border-gray-600 px-1.5 py-px font-mono text-[0.9em] text-gray-700 dark:text-gray-200 align-baseline">
      {children}
    </span>
  )
}
