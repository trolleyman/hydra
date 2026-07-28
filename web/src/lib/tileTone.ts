import type { Tone } from '../components/Badge'

// The rounded icon tile at the top-left of a notification surface - a toast, an
// approval card, a confirmation dialog - is the same object everywhere, so its
// colours come from one table rather than three hand-rolled ones (the toast's
// old TYPE_VISUAL, the dialog's old TILE_TONE, the approval card's own map).
//
// The tile is SOLID - a saturated fill with a white glyph on it, not a tint with
// a coloured glyph. A badge is a word on a busy row and has to stay quiet, so it
// keeps the soft tints in badgeTones.ts; the tile is the one piece of colour on
// an otherwise white/near-black card and is what tells you at a glance whether
// something merged or something broke. At that size a tint reads as a smudge -
// especially in dark mode, where the old `900/30` green was nearly the card
// background. A solid square reads as an object.
//
// Light mode takes the `-600` step, dark the brighter `-500`, so the fill sits
// the same distance from its background in both themes. Yellow and amber stay at
// `-600` in dark too: white on a `-500` yellow is barely legible, and the point
// of the white glyph is that you can see it.
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

// Shared geometry for the tile's glyph. A lucide mark is drawn at stroke-width 2
// by default, which is tuned for a dark line on a light background; reversed out
// in white on a saturated fill the same stroke reads thin and the mark loses its
// shape at 18px. 2.25 puts the weight back without turning the glyph into a
// blob. Applied to the tile rather than to each icon so every call site gets it
// - a tile's glyph arrives as `children` from a dozen different places.
export const TILE_GLYPH = '[&_svg]:[stroke-width:2.25]'

export const TILE_TONE: Record<TileTone, string> = {
  green:
    'bg-green-600 text-white dark:bg-green-500',
  emerald:
    'bg-emerald-600 text-white dark:bg-emerald-500',
  blue:
    'bg-blue-600 text-white dark:bg-blue-500',
  indigo:
    'bg-indigo-600 text-white dark:bg-indigo-500',
  violet:
    'bg-violet-600 text-white dark:bg-violet-500',
  teal:
    'bg-teal-600 text-white dark:bg-teal-500',
  yellow:
    'bg-yellow-600 text-white',
  amber:
    'bg-amber-600 text-white',
  red:
    'bg-red-600 text-white dark:bg-red-500',
  neutral:
    'bg-gray-600 text-white dark:bg-gray-500',
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
