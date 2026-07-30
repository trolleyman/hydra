import { useState } from 'react'
import { User } from 'lucide-react'
import { AgentTypeIcon, type AgentTypeIconName } from './AgentTypeIcon'
import { AGENT_ACCENT } from '../lib/agentTypeMeta'

// Who left a review comment, as a small rounded square beside it.
//
// Hydra hosts no images and proxies none. There are exactly three sources, in
// this order, and every one of them degrades to the next rather than to a broken
// frame:
//
//   1. An AGENT gets its own brand mark - the same logomark the sidebar and the
//      spawn form use, in the same accent colour, just larger and on a tinted
//      tile. Nothing to fetch, it is already in the bundle, and it makes "an
//      agent said this" readable at a glance rather than a name you have to read.
//   2. A FORGE user gets the picture the forge already hosts (GitHub/GitLab both
//      return one with the comment). The browser loads it directly; if that fails
//      - offline, a private instance, an avatar that moved - it falls back to (3)
//      silently, which is why the img is only rendered until its first error.
//   3. Everyone else, including YOU when there is no forge in the picture, gets a
//      monogram on a colour derived from the name. Deterministic, so the same
//      person is the same colour every time, and it works with no network at all.
//      With no name to draw on - git has no user.name configured - it falls back
//      to a person glyph rather than inventing an initial: "Y" for "You" is a
//      letter that belongs to nobody, and reads as someone whose name starts with
//      Y rather than as you.
//
// Rounded square rather than a circle, to match the chips and tiles the rest of
// the UI is built from - a lone circle in a square-cornered gutter reads as a
// different system.

// The palette monograms pick from. Chosen to stay legible on both themes at
// this size, and to be distinguishable from each other rather than pretty in a
// row - the whole job is "these are two different people".
const MONOGRAM_COLOURS = [
  'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200',
  'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200',
  'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-200',
  'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200',
  'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-200',
]

// A stable colour for a name. A tiny string hash rather than an index into
// anything: the same person must land on the same colour in every list, in every
// session, without a lookup table to keep in sync.
function colourFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return MONOGRAM_COLOURS[Math.abs(h) % MONOGRAM_COLOURS.length]
}

// The letter(s) shown when there is no picture. One character for a single word,
// two for a name with a space in it - more than that stops being readable at
// 20px, which is the size these actually render at.
function monogram(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export type AvatarSize = 'sm' | 'md'

const SIZES: Record<AvatarSize, { box: string; text: string; icon: string }> = {
  sm: { box: 'w-5 h-5 rounded', text: 'text-[9px]', icon: 'w-3 h-3' },
  md: { box: 'w-6 h-6 rounded-md', text: 'text-[10px]', icon: 'w-3.5 h-3.5' },
}

export function Avatar({
  name,
  label,
  avatarUrl,
  agentType,
  size = 'sm',
  className = '',
}: {
  /**
   * Display name - the monogram and its colour come from this. Empty means "we do
   * not know who this is", which draws a person glyph rather than a made-up
   * initial.
   */
  name: string
  /** What to call it in the tooltip when that differs from `name` (e.g. "You"). */
  label?: string
  /** A forge-hosted picture, if the forge gave us one. */
  avatarUrl?: string | null
  /**
   * Render the agent's brand mark instead of a person. Any agent type name works;
   * an unknown one (or a plain "agent") falls back to Claude's mark, since that is
   * what a reviewer slot always is.
   */
  agentType?: string | null
  size?: AvatarSize
  className?: string
}) {
  const shown = label ?? name
  const [imgFailed, setImgFailed] = useState(false)
  const s = SIZES[size]
  const anonymous = name.trim() === ''
  const base = `inline-flex items-center justify-center shrink-0 overflow-hidden ${s.box} ${className}`

  if (agentType) {
    const known: AgentTypeIconName[] = ['claude', 'gemini', 'copilot', 'codex']
    const mark = (known as string[]).includes(agentType) ? (agentType as AgentTypeIconName) : 'claude'
    return (
      <span
        className={`${base} bg-stone-100 dark:bg-white/[0.08] ${AGENT_ACCENT[mark]}`}
        title={shown}
        aria-label={shown}
      >
        <AgentTypeIcon name={mark} className={s.icon} />
      </span>
    )
  }

  if (avatarUrl && !imgFailed) {
    return (
      <img
        src={avatarUrl}
        alt={shown}
        title={shown}
        onError={() => setImgFailed(true)}
        // referrerPolicy: the forge does not need to be told which Hydra page
        // someone was looking at when their avatar loaded.
        referrerPolicy="no-referrer"
        loading="lazy"
        className={`${base} bg-stone-100 dark:bg-white/[0.08] object-cover`}
      />
    )
  }

  if (anonymous) {
    return (
      <span
        className={`${base} bg-stone-100 text-stone-400 dark:bg-white/[0.08] dark:text-stone-500`}
        title={shown}
        aria-label={shown}
      >
        <User className={s.icon} />
      </span>
    )
  }
  return (
    <span className={`${base} ${colourFor(name)} font-medium ${s.text}`} title={shown} aria-label={shown}>
      {monogram(name)}
    </span>
  )
}
