import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { TILE_TONE } from '../lib/tileTone'

// Shared building blocks for the app's rich confirmation dialogs (the merge /
// kill confirmations in Dialog.tsx and the merge-conflict panel in DiffViewer).
// Centralising the icon tile, toned action button, neutral button and section
// label keeps every dialog visually consistent - change the look here and it
// lands everywhere. Colours come paired with `dark:` variants so they read in
// both themes.

// A dialog's tone is a subset of the shared tile vocabulary (lib/tileTone), so
// the icon tile on a confirmation dialog and the one on a toast are literally
// the same square - change it there and it lands on both.
export type DialogTone = 'emerald' | 'red' | 'amber' | 'indigo' | 'blue'

const CONFIRM_TONE: Record<DialogTone, string> = {
  emerald: 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm',
  red: 'bg-red-600 hover:bg-red-700 text-white shadow-sm',
  amber: 'bg-amber-600 hover:bg-amber-700 text-white shadow-sm',
  indigo: 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm',
  blue: 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm',
}

// The rounded icon tile shown at the top-left of a dialog header. `sm` is the
// toast's 9x9 square, for the plain dialog's shorter header row; the rich panels
// keep the roomier default.
export function DialogIconTile({
  tone,
  size = 'md',
  children,
}: {
  tone: DialogTone
  size?: 'sm' | 'md'
  children: ReactNode
}) {
  const box = size === 'sm' ? 'w-9 h-9' : 'w-10 h-10'
  return (
    <span className={`${box} shrink-0 rounded-xl flex items-center justify-center ${TILE_TONE[tone]}`}>
      {children}
    </span>
  )
}

// A small, letter-spaced section label (e.g. "Conflicting files"). `className`
// REPLACES the default mb-2 rather than adding to it - two margin-bottom
// utilities on one element resolve by stylesheet order, not by the order they
// appear in the attribute, so an override has to be the only one present. A
// caller whose labelled content is a bordered panel wants the tighter gap;
// there, mb-2 reads as a separation rather than a caption.
export function DialogSectionLabel({ children, className = 'mb-2' }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-[11px] font-semibold tracking-wider text-gray-400 dark:text-gray-500 ${className}`.trim()}>
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
