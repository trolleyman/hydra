import type { ButtonHTMLAttributes, ReactNode } from 'react'

// Visual presets for an icon-only button. Each variant is self-contained (it
// carries its own sizing, shape and color) so callers don't stack conflicting
// utilities; pass extra layout via `className` (e.g. `shrink-0 -ml-1`).
//
// - `ghost`  - borderless hover-bg button used for modal/toast close (✕) and
//   other inline dismiss affordances. Deliberately not flex-centered, matching
//   the historical close-button box.
// - `panel`  - the larger flex-centered square used for the collapsed-sidebar
//   show/hide toggle.
type IconButtonVariant = 'ghost' | 'panel'

const VARIANT_CLASS: Record<IconButtonVariant, string> = {
  ghost:
    'p-1 rounded-md text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700',
  panel:
    'w-9 h-9 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700',
}

// IconButton is the shared icon-only button: a `<button>` wrapping a single icon,
// with consistent transition/cursor/disabled handling. It forwards all native
// button props (onClick, disabled, aria-label, title, type...).
export function IconButton({
  variant = 'ghost',
  className = '',
  children,
  ...rest
}: {
  variant?: IconButtonVariant
  className?: string
  children: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`${VARIANT_CLASS[variant]} transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  )
}
