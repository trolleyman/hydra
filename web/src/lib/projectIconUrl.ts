// Resolves a project's `icon` string into an *image URL*, for the two surfaces
// that can't render a React component: the OS notification icon (the Notification
// API's `icon` option) and the browser tab favicon (`<link rel="icon">`).
//
// ProjectIcon (projectIcon.tsx) renders the same three icon flavours as JSX; only
// the image flavour is already a URL. Emoji/text and lucide icons are components
// or glyphs, so here they're rasterized to a PNG data: URL via an offscreen
// canvas. SVG data URLs would be smaller, but Chrome does not reliably render
// them as notification icons, so everything goes through the canvas.
//
// Rasterizing is async (a lucide icon round-trips through an <img>), while
// fireNotification is synchronous - so this module is a cache, not a lookup:
// callers prewarm with ensureProjectIconUrl() when the project list loads, then
// read the cached URL synchronously at notification time. A cache miss simply
// means no icon on that one notification (the browser falls back to the page
// favicon), which is why the miss path is a silent undefined rather than a wait.

import { createElement } from 'react'
import { loadLucideIcons, looksLikeIconName, lucideIcon, type LucideIcon } from './lucideIcons'
import {
  IMAGE_ICON_RE,
  firstGlyph,
  hashHue,
  isGlyphIcon,
  projectImageIconSrc,
} from './projectIconValue'

// Rendered at 128px: comfortably above what any OS notification tray or favicon
// slot asks for (typically 16-64px), so downscaling stays crisp, while a single
// data URL of this size stays small enough to keep in memory per project.
const ICON_PX = 128

// The site-wide Hydra icon, used when a project's icon can't be rasterized
// (no canvas, a lucide render failure) so the notification still shows *some*
// mark rather than the browser's generic placeholder.
export const DEFAULT_ICON_URL = '/android-chrome-192x192.png'

// cacheKey → resolved URL. '\0' separates the two fields because it cannot
// appear in either (see CLAUDE.md on collision-proof string keys).
const cache = new Map<string, string>()
// In-flight resolutions, so N notifications for one project don't each rasterize.
const pending = new Map<string, Promise<string>>()

function cacheKey(icon: string | null | undefined, projectId: string): string {
  return `${projectId}\0${(icon ?? '').trim()}`
}

// projectIconUrl returns the already-resolved icon URL for a project, or
// undefined if it hasn't been rasterized yet. Synchronous by design - see the
// module comment on why a miss is not worth waiting for.
export function projectIconUrl(icon: string | null | undefined, projectId: string): string | undefined {
  return cache.get(cacheKey(icon, projectId))
}

// ensureProjectIconUrl resolves (and caches) a project's icon URL, reusing an
// in-flight resolution for the same icon. Safe to call repeatedly.
export function ensureProjectIconUrl(icon: string | null | undefined, projectId: string): Promise<string> {
  const key = cacheKey(icon, projectId)
  const hit = cache.get(key)
  if (hit !== undefined) return Promise.resolve(hit)
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const p = renderIconUrl((icon ?? '').trim(), projectId)
    .catch(() => DEFAULT_ICON_URL)
    .then((url) => {
      cache.set(key, url)
      pending.delete(key)
      return url
    })
  pending.set(key, p)
  return p
}

async function renderIconUrl(v: string, projectId: string): Promise<string> {
  // Image icons are already URLs - the backend serves bare paths out of the
  // project, and http(s)/data URIs are used verbatim.
  if (IMAGE_ICON_RE.test(v)) return projectImageIconSrc(v, projectId)

  // Unlike the JSX renderer this path is already async, so a name outside the
  // eagerly-bundled set just waits for the full icon set to load.
  let lucide = lucideIcon(v)
  if (!lucide && looksLikeIconName(v)) {
    await loadLucideIcons()
    lucide = lucideIcon(v)
  }
  if (lucide) return await rasterizeLucide(lucide, projectId)

  // An emoji is self-colored, so it's drawn bare on transparency and reads on
  // both light and dark notification trays.
  if (isGlyphIcon(v)) return drawGlyph(firstGlyph(v), null)

  // A text label (or a name that matched no icon) falls back to its initial on
  // the hashed tile, matching ProjectIcon.
  if (v) return drawGlyph(firstGlyph(v).toUpperCase(), hashHue(projectId))

  // No custom icon: mirror the default icon - the project id's first character
  // on a box colored by a hash of the id, so projects stay distinguishable.
  return drawGlyph(projectId.charAt(0).toUpperCase(), hashHue(projectId))
}

// A 128px canvas, or null where there is no canvas at all (jsdom in unit tests,
// some embedded webviews). Callers degrade to DEFAULT_ICON_URL.
function newCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = ICON_PX
  canvas.height = ICON_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  return { canvas, ctx }
}

// Fills the hashed-hue rounded box that backs lucide and default icons. roundRect
// is recent enough to be worth a square-corner fallback.
function fillBox(ctx: CanvasRenderingContext2D, hue: number): void {
  ctx.fillStyle = `hsl(${hue} 55% 45%)`
  ctx.beginPath()
  const r = ICON_PX * 0.25
  if (typeof ctx.roundRect === 'function') ctx.roundRect(0, 0, ICON_PX, ICON_PX, r)
  else ctx.rect(0, 0, ICON_PX, ICON_PX)
  ctx.fill()
}

// Draws one glyph centered on the canvas. `hue` null = transparent background
// (emoji, which carry their own color); otherwise the glyph is drawn in white on
// the hashed box, matching ProjectIcon's letter tile.
function drawGlyph(text: string, hue: number | null): string {
  const made = newCanvas()
  if (!made) return DEFAULT_ICON_URL
  const { canvas, ctx } = made
  if (hue !== null) fillBox(ctx, hue)
  ctx.fillStyle = hue === null ? '#111827' : '#ffffff'
  // Emoji render via the system color font regardless of the family listed here;
  // the sans-serif fallback covers the plain-letter (default icon) case.
  ctx.font = `600 ${Math.round(ICON_PX * (hue === null ? 0.86 : 0.58))}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // Callers already pass a single glyph; the guard is for an empty string.
  const first = firstGlyph(text) || '?'
  ctx.fillText(first, ICON_PX / 2, ICON_PX * 0.54)
  return canvas.toDataURL('image/png')
}

// Renders a lucide icon component to SVG markup, then rasterizes it white-on-box
// so it has a solid backdrop in the tray. react-dom/server is imported lazily so
// its weight lands in a chunk only projects with a lucide icon ever fetch.
async function rasterizeLucide(icon: LucideIcon, projectId: string): Promise<string> {
  const made = newCanvas()
  if (!made) return DEFAULT_ICON_URL
  const { canvas, ctx } = made

  const { renderToStaticMarkup } = await import('react-dom/server')
  const glyphPx = Math.round(ICON_PX * 0.6)
  const svg = renderToStaticMarkup(
    createElement(icon, { size: glyphPx, color: '#ffffff', strokeWidth: 2 }),
  )
  const img = new Image()
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('lucide icon failed to rasterize'))
    img.src = url
  })
  fillBox(ctx, hashHue(projectId))
  const off = (ICON_PX - glyphPx) / 2
  ctx.drawImage(img, off, off, glyphPx, glyphPx)
  return canvas.toDataURL('image/png')
}
