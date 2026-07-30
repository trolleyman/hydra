import type { ReactNode } from 'react'
import { TONE_BADGE } from './badgeTones'

// Color tones are the single source of truth for agent status / session /
// end-state colors. Each tone knows how to paint itself two ways: as a solid
// status `dot` (TONE_DOT) and as a soft text `badge` (TONE_BADGE - light fill +
// readable text, with dark-mode variants), both in badgeTones. Because both
// presentations come from the same tone, a status dot and badge never drift.
//
// `red` vs `redSoft` differ only as dots - needs_input reads a stronger red than
// an exited/killing session - but share the same badge fill. The three grays
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

// Size/shape presets for the chip. `sm` is the default status badge; `xs` is the
// denser sidebar chip; `pill` is the fully-rounded brand/type pill (slightly more
// horizontal padding). Each preset bundles its own padding so callers never
// stack conflicting `px-*` utilities.
//
// `xs` additionally pins a fixed height and centers its content (`inline-flex
// items-center h-[18px]`) so every chip in the sidebar badge row is the SAME
// height regardless of whether it carries a 12px icon (the test-verdict chips), a
// 1px dashed border (the stale chip - box-border keeps it inside the 18px), or is
// plain text (the status badge). Without this the row's `items-center` grew to the
// tallest child, so the layout jumped as a head's verdict changed. The fixed
// height replaces vertical padding (hence no `py-*` on `xs`).
type BadgeVariant = 'xs' | 'sm' | 'pill'

const VARIANT_CLASS: Record<BadgeVariant, string> = {
  xs: 'inline-flex items-center box-border h-[18px] text-3xs leading-none px-1 rounded',
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
   * `min-w-0` so a chip can shrink and truncate within a tight row - kept
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
