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
// a plain even asterisk), the whole thing turning slowly while a pulse of
// brightness/length travels around the spokes. `still` drops both animations
// for the settled result line, where nothing is in flight any more.
//
// It paints itself in the head's brand accent - Claude clay in a Claude chat,
// Gemini violet in a Gemini one, and so on - read from ChatAgentTypeContext so
// it matches that agent's logo mark elsewhere in the UI without every call site
// threading the type down.
import { useContext } from 'react'
import { ChatAgentTypeContext } from '../lib/chatAgentType'
import { agentTypeColor } from '../lib/agentDisplay'

type WorkSparkProps = {
  /** Extra classes. Size, colour and optical offset are all baked in. */
  className?: string
  still?: boolean
}

// Spoke angles, evenly spaced; every other one is drawn shorter and thinner,
// which reads as a sparkle instead of a snowflake at 14px.
const SPOKE_ANGLES = [0, 60, 120, 180, 240, 300]

// Inner end of every spoke (shared, so they meet in a clean centre) and the
// two outer ends, in viewBox units. y decreases outward - spokes are drawn
// pointing up, then rotated into place.
const INNER_Y = 9.2
const LONG_Y = 3.3
const SHORT_Y = 5.7

export function WorkSpark({ className = '', still = false }: WorkSparkProps) {
  const accent = agentTypeColor(useContext(ChatAgentTypeContext))
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      // -mt-px is optical centring, not a fudge: `items-center` centres the
      // mark on the text's LINE box, but the eye lines it up against the
      // glyphs, whose cap-height centre sits ~0.6px higher at 11px/16.5px.
      // Under align-items:center a negative top margin shrinks the margin box,
      // so this nudges the mark up by half of it - which is the amount wanted.
      className={`shrink-0 w-3.5 h-3.5 -mt-px ${accent} ${still ? '' : 'work-spark'} ${className}`}
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
