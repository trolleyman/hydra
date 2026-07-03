import type { ButtonHTMLAttributes, ReactNode } from 'react'

// Shared building blocks for the app's rich confirmation dialogs (the merge /
// kill confirmations in Dialog.tsx and the merge-conflict panel in DiffViewer).
// Centralising the icon tile, toned action button, neutral button and section
// label keeps every dialog visually consistent - change the look here and it
// lands everywhere. Colours come paired with `dark:` variants so they read in
// both themes.

export type DialogTone = 'emerald' | 'red' | 'amber' | 'indigo' | 'blue'

const TILE_TONE: Record<DialogTone, string> = {
  emerald: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400',
  red: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
  amber: 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
  indigo: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400',
  blue: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
}

const CONFIRM_TONE: Record<DialogTone, string> = {
  emerald: 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm',
  red: 'bg-red-600 hover:bg-red-700 text-white shadow-sm',
  amber: 'bg-amber-600 hover:bg-amber-700 text-white shadow-sm',
  indigo: 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm',
  blue: 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm',
}

// The rounded icon tile shown at the top-left of a rich dialog header.
export function DialogIconTile({ tone, children }: { tone: DialogTone; children: ReactNode }) {
  return (
    <span className={`w-10 h-10 shrink-0 rounded-xl flex items-center justify-center ${TILE_TONE[tone]}`}>
      {children}
    </span>
  )
}

// An uppercase, letter-spaced section label (e.g. "CONFLICTING FILES").
export function DialogSectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
      {children}
    </p>
  )
}

// The neutral Cancel / Dismiss button: white, bordered, subtle hover.
export function DialogCancelButton({
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center px-4 py-2 rounded-lg text-sm font-semibold bg-white dark:bg-[#1c2330] border border-gray-200 dark:border-[#2e3747] text-gray-600 dark:text-[#cbd2de] hover:border-gray-300 dark:hover:bg-[#252d3b] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
    >
      {children}
    </button>
  )
}

// The toned primary action button with an optional leading icon.
export function DialogConfirmButton({
  tone,
  icon,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone: DialogTone; icon?: ReactNode }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap px-4 py-2 rounded-lg text-sm font-semibold transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${CONFIRM_TONE[tone]} ${className}`}
    >
      {icon}
      {children}
    </button>
  )
}
