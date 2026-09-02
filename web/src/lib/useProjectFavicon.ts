// Swaps the browser tab favicon to the selected project's icon and overlays the
// same attention dot used in project navigation: blue for unread updates, red
// when an agent needs input. Installed web apps also receive the platform's
// native app-icon badge where the Badging API is available; its appearance is
// controlled by the operating system.
//
// Hydra is commonly kept open as one tab per project, where every tab is an
// identical Hydra logo. Painting the project's own icon into the tab makes them
// tellable apart at a glance - the same reason the OS notification now carries
// it (see lib/projectIconUrl, which resolves both).
//
// index.html declares two <link rel="icon"> tags (16px and 32px). Rather than
// adding a third and leaving the browser to pick among them, this rewrites the
// href of whichever icon links exist and restores the originals on cleanup, so
// leaving a project (or unmounting) always returns the Hydra mark.

import { useEffect } from 'react'
import { selectProject, useProjectStore } from '../stores/projectStore'
import { ensureProjectIconUrl } from './projectIconUrl'

export type ProjectAttention = 'unread' | 'needs_input' | null

const ATTENTION_COLOR: Record<Exclude<ProjectAttention, null>, string> = {
  unread: '#0ea5e9',
  needs_input: '#ef4444',
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

// SVG is reliable for favicons and lets image-backed, emoji, letter, and lucide
// project icons share one crisp overlay without another canvas round-trip.
export function attentionFaviconUrl(baseUrl: string, attention: ProjectAttention): string {
  if (!attention) return baseUrl
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><image href="${escapeXml(baseUrl)}" width="128" height="128"/><circle cx="103" cy="103" r="19" fill="${ATTENTION_COLOR[attention]}" stroke="white" stroke-width="9"/></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function iconLinks(): HTMLLinkElement[] {
  // rel~="icon" matches rel="icon" / "shortcut icon" but not "apple-touch-icon",
  // which is the home-screen icon and shouldn't follow the tab.
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
}

export function useProjectFavicon(projectId: string | null, attention: ProjectAttention): void {
  // Subscribing to the icon (a primitive, so no re-render churn) rather than
  // snapshotting it means changing a project's icon in Settings repaints the tab
  // straight away instead of waiting for a reload.
  const icon = useProjectStore((s) => projectId ? selectProject(s, projectId)?.icon : undefined)

  useEffect(() => {
    const links = iconLinks()
    if (links.length === 0) return
    // Captured before any swap, so cleanup restores the real defaults even if
    // this effect re-runs while a previous project's icon is still applied.
    const originals = links.map((l) => ({
      href: l.getAttribute('href'),
      type: l.getAttribute('type'),
    }))
    const restore = () => {
      links.forEach((l, i) => {
        const original = originals[i]
        if (original.href !== null) l.setAttribute('href', original.href)
        if (original.type !== null) l.setAttribute('type', original.type)
        else l.removeAttribute('type')
      })
    }

    if (!projectId) {
      restore()
      return
    }

    // Effect may outlive the async resolve (fast project switch / unmount) - the
    // flag keeps a late icon from overwriting the newer project's favicon.
    let live = true
    void ensureProjectIconUrl(icon, projectId).then((url) => {
      if (!live) return
      const absoluteUrl = new URL(url, document.baseURI).href
      const faviconUrl = attentionFaviconUrl(absoluteUrl, attention)
      for (const l of links) {
        l.setAttribute('href', faviconUrl)
        if (attention) l.setAttribute('type', 'image/svg+xml')
      }
    })

    return () => {
      live = false
      restore()
    }
  }, [projectId, icon, attention])

  useEffect(() => {
    // The Badging API is implemented by some installed desktop web apps. It has
    // no color control, so the exact blue/red distinction remains in the favicon
    // while the OS-level badge provides the best available desktop signal.
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: () => Promise<void>
      clearAppBadge?: () => Promise<void>
    }
    if (attention) void badgeNavigator.setAppBadge?.().catch(() => {})
    else void badgeNavigator.clearAppBadge?.().catch(() => {})
  }, [attention])
}
