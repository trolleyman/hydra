// How a project's custom `icon` string (see internal/projects ProjectInfo) is
// interpreted, shared by the two renderers of it:
//   - projectIcon.tsx    - renders it as JSX (the in-app project glyph);
//   - projectIconUrl.ts  - rasterizes it to a URL (OS notification / favicon).
//
// The interpretation matches the backend contract:
//   - a value ending in an image extension is an image (an http(s)/data URI is
//     used directly, any other path is served by the backend /project-icon route);
//   - a lucide-react icon name in any spelling ("FolderDot", "folder-dot") is
//     that icon - name matching and loading live in lucideIcons.ts;
//   - a lone glyph (an emoji) is drawn as itself;
//   - anything else is a text label, which only its first character survives -
//     the icon is one glyph wide, so a whole word would spill out of it.
//
// This lives apart from projectIcon.tsx purely because react-refresh requires a
// component file to export only components.

// The set of extensions that mark an icon value as an image. Kept in sync with
// isImageIcon in internal/http/project_icon.go.
export const IMAGE_ICON_RE = /\.(png|svg|ico|jpe?g|gif|webp|avif|bmp)$/i

const DIRECT_URI_RE = /^(https?:|data:)/i

// Where to fetch an image icon from: an http(s)/data URI is used verbatim, any
// other value is a path the backend serves out of the project.
export function projectImageIconSrc(icon: string, projectId: string): string {
  return DIRECT_URI_RE.test(icon) ? icon : `/project-icon/projects/${encodeURIComponent(projectId)}`
}

// Whether an icon value that is neither an image nor a lucide name should be
// drawn as-is. True for an emoji (or any glyph carrying no ASCII letters or
// digits), false for a word - "FolderDot", say, when the name did not resolve -
// which renders as an initial on a tile instead of overflowing the icon box.
export function isGlyphIcon(value: string): boolean {
  return !/[a-z0-9]/i.test(value)
}

// The first glyph of a value, via the string iterator so a surrogate pair or a
// multi-codepoint emoji is not sliced in half.
export function firstGlyph(value: string): string {
  return [...value][0] ?? ''
}

// Deterministic hue (0-359) hashed from the project id, for the default icon's
// background. Plain 31-multiplier string hash.
export function hashHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return ((h % 360) + 360) % 360
}
