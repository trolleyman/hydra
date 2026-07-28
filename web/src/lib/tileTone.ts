import type { Tone } from '../components/Badge'

// The rounded icon tile at the top-left of a notification surface - a toast, an
// approval card, a confirmation dialog - is the same object everywhere, so its
// colours come from one table rather than three hand-rolled ones (the toast's
// old TYPE_VISUAL, the dialog's old TILE_TONE, the approval card's own map).
//
// The fills are deliberately stronger than the `Badge` tints in badgeTones.ts.
// A badge is a word on a busy row and has to stay quiet; the tile is the one
// piece of colour on an otherwise white/near-black card and is what tells you at
// a glance whether something merged or something broke. The old `-50`/`-900/30`
// fills read as a smudge at that size - especially in dark mode, where a
// `900/30` green is nearly the card background. So: a mid-hue fill at low alpha
// (alive in both themes, no separate light/dark hue to keep in sync), a matching
// inset ring to give the square an edge, and a glyph two steps brighter than the
// badge's so it carries against the fill.
export type TileTone =
  | 'green'
  | 'emerald'
  | 'blue'
  | 'indigo'
  | 'violet'
  | 'teal'
  | 'yellow'
  | 'amber'
  | 'red'
  | 'neutral'

export const TILE_TONE: Record<TileTone, string> = {
  green:
    'bg-green-500/20 text-green-700 ring-1 ring-inset ring-green-600/25 dark:bg-green-500/25 dark:text-green-200 dark:ring-green-400/30',
  emerald:
    'bg-emerald-500/20 text-emerald-700 ring-1 ring-inset ring-emerald-600/25 dark:bg-emerald-500/25 dark:text-emerald-200 dark:ring-emerald-400/30',
  blue:
    'bg-blue-500/20 text-blue-700 ring-1 ring-inset ring-blue-600/25 dark:bg-blue-500/25 dark:text-blue-200 dark:ring-blue-400/30',
  indigo:
    'bg-indigo-500/20 text-indigo-700 ring-1 ring-inset ring-indigo-600/25 dark:bg-indigo-500/25 dark:text-indigo-200 dark:ring-indigo-400/30',
  violet:
    'bg-violet-500/20 text-violet-700 ring-1 ring-inset ring-violet-600/25 dark:bg-violet-500/25 dark:text-violet-200 dark:ring-violet-400/30',
  teal:
    'bg-teal-500/20 text-teal-700 ring-1 ring-inset ring-teal-600/25 dark:bg-teal-500/25 dark:text-teal-200 dark:ring-teal-400/30',
  yellow:
    'bg-yellow-500/20 text-yellow-700 ring-1 ring-inset ring-yellow-600/25 dark:bg-yellow-500/25 dark:text-yellow-200 dark:ring-yellow-400/30',
  amber:
    'bg-amber-500/20 text-amber-700 ring-1 ring-inset ring-amber-600/25 dark:bg-amber-500/25 dark:text-amber-200 dark:ring-amber-400/30',
  red:
    'bg-red-500/20 text-red-700 ring-1 ring-inset ring-red-600/25 dark:bg-red-500/25 dark:text-red-200 dark:ring-red-400/30',
  neutral:
    'bg-gray-500/20 text-gray-700 ring-1 ring-inset ring-gray-600/25 dark:bg-gray-400/25 dark:text-gray-100 dark:ring-gray-300/30',
}

// The solid companion fill, used for the toast's countdown bar so the bar and
// the tile can never name different colours.
export const TILE_BAR: Record<TileTone, string> = {
  green: 'bg-green-500',
  emerald: 'bg-emerald-500',
  blue: 'bg-blue-500',
  indigo: 'bg-indigo-500',
  violet: 'bg-violet-500',
  teal: 'bg-teal-500',
  yellow: 'bg-yellow-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  neutral: 'bg-gray-500',
}

// Badge tones (badgeTones.ts) and tile tones are separate vocabularies - the
// badge set carries emphasis variants (redSoft/muted/faint) a tile has no use
// for. This maps one onto the other so a status pill and the tile above it are
// always the same hue: agentStatusTone() gives a Tone, this turns it into the
// tile that goes with it.
const TONE_TO_TILE: Record<Tone, TileTone> = {
  green: 'green',
  blue: 'blue',
  indigo: 'indigo',
  yellow: 'yellow',
  violet: 'violet',
  red: 'red',
  redSoft: 'red',
  neutral: 'neutral',
  muted: 'neutral',
  faint: 'neutral',
}

export function tileToneForBadge(tone: Tone): TileTone {
  return TONE_TO_TILE[tone] ?? 'neutral'
}
