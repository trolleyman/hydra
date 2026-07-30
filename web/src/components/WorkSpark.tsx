// The "working" spark - the little mark on the live status lines in chat
// ("Musing... (2m 5s)") and on a settled turn's result line.
//
// This used to be a literal "✳" character. On most Linux desktops that
// codepoint has an emoji presentation, so the color-emoji font won, the glyph
// came out green regardless of the CSS colour, and it changed shape per
// platform. An SVG renders identically everywhere, takes `currentColor`, and
// can actually animate.
//
// The shape is a six-spoke sparkle (alternating long/short spokes rather than
// a plain even asterisk), the whole thing turning slowly ANTICLOCKWISE while a
// pulse of brightness/length travels around the spokes. `still` drops both
// animations for the settled result line, where nothing is in flight any more.
//
// 20px rather than the 16px it started at: it is the one piece of motion in a
// chat row and it was drawn small enough to read as a bullet. The spokes are
// hairlines, so the extra 4px costs nothing in weight - it just lets the shape
// be seen. Rows sized by their own text (h-7 and friends) are unaffected; the
// mark is `shrink-0` and sits in flex rows that were already taller than it.
//
// It paints itself in the head's brand accent - Claude clay in a Claude chat,
// Gemini violet in a Gemini one, and so on - read from ChatAgentTypeContext so
// it matches that agent's logo mark elsewhere in the UI without every call site
// threading the type down.
import { useContext } from 'react'
import { ChatAgentTypeContext } from '../lib/chatAgentType'
import { agentTypeColor } from '../lib/agentDisplay'

type WorkSparkProps = {
  /** Extra classes. Size and colour are baked in; optical centring is the
      label's job, via `.optical-center` (see below). */
  className?: string
  still?: boolean
  /** Which baked-in size to draw at: `default` is the 20px in-row mark, `lg`
      the 56px hero one the chat's centred loading state uses. A prop rather
      than a `w-14 h-14` handed in through `className`, because both are
      same-specificity Tailwind utilities and which of the two won would come
      down to their order in the generated stylesheet. */
  size?: keyof typeof SIZE_CLASS
}

const SIZE_CLASS = {
  default: 'w-5 h-5',
  lg: 'w-14 h-14',
} as const

// Spoke angles, evenly spaced; every other one is drawn shorter and thinner,
// which reads as a sparkle instead of a snowflake at 14px.
const SPOKE_ANGLES = [0, 60, 120, 180, 240, 300]

// Inner end of every spoke (shared, so they meet in a clean centre) and the
// two outer ends, in viewBox units. y decreases outward - spokes are drawn
// pointing up, then rotated into place.
const INNER_Y = 9.2
const LONG_Y = 3.3
const SHORT_Y = 5.7

export function WorkSpark({ className = '', still = false, size = 'default' }: WorkSparkProps) {
  const accent = agentTypeColor(useContext(ChatAgentTypeContext))
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      // No optical nudge here: the mark is centred honestly, and the LABEL beside
      // it carries `.optical-center` so the row centres on the text's cap box
      // rather than its line box. Correcting the text is the metric-independent
      // half of the pair - it derives the offset from the font's own cap height,
      // where a fixed px nudge on the mark is tuned to one size and one font
      // (see CLAUDE.md). So: `.optical-center` on every label sat next to one of
      // these, and nothing on the spark.
      className={`shrink-0 ${SIZE_CLASS[size]} ${accent} ${still ? '' : 'work-spark'} ${className}`}
    >
      {SPOKE_ANGLES.map((angle, i) => {
        const long = i % 2 === 0
        return (
          // The rotation lives on a wrapping <g> as an attribute so the CSS
          // transform on the spoke itself (the length pulse) doesn't clobber
          // it - a CSS transform overrides the SVG transform attribute.
          <g key={angle} transform={`rotate(${angle} 12 12)`}>
            <line
              x1="12"
              y1={long ? LONG_Y : SHORT_Y}
              x2="12"
              y2={INNER_Y}
              stroke="currentColor"
              strokeWidth={long ? 2.1 : 1.7}
              strokeLinecap="round"
              className={still ? undefined : 'work-spark-spoke'}
              style={still ? undefined : { animationDelay: `${(-i * 0.22).toFixed(2)}s` }}
            />
          </g>
        )
      })}
    </svg>
  )
}
