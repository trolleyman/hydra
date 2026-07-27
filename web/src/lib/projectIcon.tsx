// Renders a project's custom `icon` string (see internal/projects ProjectInfo)
// in place of the default folder glyph. How the string is interpreted lives in
// projectIconValue.ts, shared with the rasterizing renderer in projectIconUrl.ts.
// Empty falls back to the default icon: a rounded box colored by a hash of the
// project id with the id's first character inside (or the bare folder glyph
// when there is no project id, e.g. the "Select project" state).

import { Folder } from 'lucide-react'
import { useLucideIcon } from './lucideIcons'
import {
  IMAGE_ICON_RE,
  firstGlyph,
  hashHue,
  isGlyphIcon,
  projectImageIconSrc,
} from './projectIconValue'

// One character on a rounded box colored by a hash of the project id. Backs both
// the no-icon default (the project id's initial) and the fallback for a text
// value that is not an icon name (the label's initial) - a label rendered as-is
// would spill out of the icon's box, which is the size of one glyph.
function LetterTile({
  letter,
  projectId,
  size,
  className,
}: {
  letter: string
  projectId: string
  size: number
  className: string
}) {
  return (
    <span
      aria-hidden
      className={`inline-flex items-center justify-center rounded-[25%] font-semibold text-white select-none leading-none overflow-hidden ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.6)),
        backgroundColor: `hsl(${hashHue(projectId)} 55% 45%)`,
      }}
    >
      {letter}
    </span>
  )
}

export function ProjectIcon({
  icon,
  projectId,
  size = 14,
  className = '',
}: {
  icon: string | null | undefined
  // Needed to build the backend image URL for a bare-path image icon.
  projectId: string
  // Rendered box size in pixels (icons and emoji are sized to this).
  size?: number
  className?: string
}) {
  const v = (icon ?? '').trim()
  // Unconditional (hooks rule) - a no-op for values that are not icon names.
  const { icon: Lucide, pending } = useLucideIcon(v)

  if (!v) {
    // No project at all (e.g. the "Select project" trigger) keeps the folder
    // glyph; a real project gets its hashed-color letter box.
    if (!projectId) return <Folder size={size} className={className} />
    // Built-in IDs are underscore-prefixed (`_chat`), and a box containing a
    // bare "_" reads as a glitch - use the first real character instead.
    const initial = projectId.replace(/^_+/, '').charAt(0) || projectId.charAt(0)
    return <LetterTile letter={initial} projectId={projectId} size={size} className={className} />
  }

  if (IMAGE_ICON_RE.test(v)) {
    const src = projectImageIconSrc(v, projectId)
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: 'contain' }}
        className={`rounded-[3px] ${className}`}
      />
    )
  }

  if (Lucide) return <Lucide size={size} className={className} />

  // A plausible icon name whose set is still downloading: hold the space empty
  // rather than flashing the value for a frame.
  if (pending) return <span aria-hidden style={{ width: size, height: size }} className={`inline-block ${className}`} />

  // A single emoji (or other lone glyph) is the icon - render it at box size.
  if (isGlyphIcon(v)) {
    return (
      <span
        aria-hidden
        className={`inline-flex items-center justify-center leading-none overflow-hidden ${className}`}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.95) }}
      >
        {firstGlyph(v)}
      </span>
    )
  }

  // Anything else is a text label - most often a misspelled icon name. Collapse
  // it to its initial on the default icon's tile so it stays inside the box.
  return (
    <LetterTile
      letter={firstGlyph(v).toUpperCase()}
      projectId={projectId}
      size={size}
      className={className}
    />
  )
}
