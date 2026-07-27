// Renders a project's custom `icon` string (see internal/projects ProjectInfo)
// in place of the default folder glyph. How the string is interpreted lives in
// projectIconValue.ts, shared with the rasterizing renderer in projectIconUrl.ts.
// Empty falls back to the default icon: a rounded box colored by a hash of the
// project id with the id's first character inside (or the bare folder glyph
// when there is no project id, e.g. the "Select project" state).

import { Folder } from 'lucide-react'
import {
  LUCIDE_ICONS,
  IMAGE_ICON_RE,
  hashHue,
  projectImageIconSrc,
} from './projectIconValue'

// Default icon when the project has no custom `icon`: a rounded box in a color
// hashed from the project id, with the id's first character in the middle.
function DefaultProjectIcon({ projectId, size, className }: { projectId: string; size: number; className: string }) {
  return (
    <span
      aria-hidden
      className={`inline-flex items-center justify-center rounded-[25%] font-semibold text-white select-none leading-none ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.6)),
        backgroundColor: `hsl(${hashHue(projectId)} 55% 45%)`,
      }}
    >
      {/* Built-in IDs are underscore-prefixed (`_chat`), and a box containing a
          bare "_" reads as a glitch - use the first real character instead. */}
      {projectId.replace(/^_+/, '').charAt(0) || projectId.charAt(0)}
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

  if (!v) {
    // No project at all (e.g. the "Select project" trigger) keeps the folder
    // glyph; a real project gets its hashed-color letter box.
    if (!projectId) return <Folder size={size} className={className} />
    return <DefaultProjectIcon projectId={projectId} size={size} className={className} />
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

  const Lucide = LUCIDE_ICONS[v.toLowerCase()]
  if (Lucide) return <Lucide size={size} className={className} />

  // Emoji or short text label: render the glyph itself, sized to the box.
  return (
    <span
      aria-hidden
      className={`inline-flex items-center justify-center leading-none ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.95) }}
    >
      {v}
    </span>
  )
}
