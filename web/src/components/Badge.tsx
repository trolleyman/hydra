import type { ReactNode } from 'react'

// Color tones are the single source of truth for agent status / session /
// end-state colors. Each tone knows how to paint itself two ways: as a solid
// status `dot` (TONE_DOT) and as a soft text `badge` (TONE_BADGE — light fill +
// readable text, with dark-mode variants). Because both presentations come from
// the same tone, a status dot and its badge can never drift out of sync.
//
// `red` vs `redSoft` differ only as dots — needs_input reads a stronger red than
// an exited/killing session — but share the same badge fill. The three grays
// (`neutral`/`muted`/`faint`) are progressively dimmer badge fills used for
// pending → ended/archived → unknown states; their dots are identical.
export type Tone =
  | 'green'
  | 'blue'
  | 'indigo'
  | 'yellow'
  | 'violet'
  | 'red'
  | 'redSoft'
  | 'neutral'
  | 'muted'
  | 'faint'

export const TONE_DOT: Record<Tone, string> = {
  green: 'bg-green-500',
  blue: 'bg-blue-400',
  indigo: 'bg-indigo-400',
  yellow: 'bg-yellow-400',
  violet: 'bg-violet-500',
  red: 'bg-red-500',
  redSoft: 'bg-red-400',
  neutral: 'bg-gray-300 dark:bg-gray-600',
  muted: 'bg-gray-300 dark:bg-gray-600',
  faint: 'bg-gray-300 dark:bg-gray-600',
}

export const TONE_BADGE: Record<Tone, string> = {
  green: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  yellow: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
  red: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  redSoft: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  neutral: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  muted: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
  faint: 'bg-gray-50 text-gray-400 dark:bg-gray-800 dark:text-gray-500',
}

// Size/shape presets for the chip. `sm` is the default status badge; `xs` is the
// denser sidebar chip; `pill` is the fully-rounded brand/type pill (slightly more
// horizontal padding). Each preset bundles its own padding so callers never
// stack conflicting `px-*` utilities.
type BadgeVariant = 'xs' | 'sm' | 'pill'

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  xs: 'text-[10px] px-1 py-0.5 rounded',
  sm: 'text-xs px-2 py-0.5 rounded',
  pill: 'text-xs px-2.5 py-0.5 rounded-full',
}

// Badge is the shared status/label chip: an inline-flex pill carrying optional
// leading icon + text. Pass either a `tone` (mapped to TONE_BADGE) or an explicit
// `className` for one-off color schemes (e.g. brand-matched agent-type pills).
export function Badge({
  tone,
  className,
  containerClassName,
  variant = 'sm',
  icon,
  title,
  children,
}: {
  tone?: Tone
  /** Explicit color classes; overrides `tone`. Use for non-status palettes. */
  className?: string
  /**
   * Extra layout classes appended to the chip's outer span (always, alongside
   * the tone/`className` color). Use for sizing/overflow concerns like
   * `min-w-0` so a chip can shrink and truncate within a tight row — kept
   * separate from `className` so it doesn't clobber the tone color.
   */
  containerClassName?: string
  variant?: BadgeVariant
  icon?: ReactNode
  title?: string
  children: ReactNode
}) {
  const color = className ?? (tone ? TONE_BADGE[tone] : '')
  // Only icon-bearing chips need flex layout (icon + text alignment); a text-only
  // chip stays a plain inline span so its box matches the historical badges.
  const layout = icon ? 'inline-flex items-center gap-1 ' : ''
  return (
    <span title={title} className={`${layout}font-medium ${VARIANT_CLASS[variant]} ${color}${containerClassName ? ` ${containerClassName}` : ''}`}>
      {icon}
      {children}
    </span>
  )
}
