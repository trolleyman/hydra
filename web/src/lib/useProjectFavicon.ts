// Swaps the browser tab favicon to the selected project's icon.
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

function iconLinks(): HTMLLinkElement[] {
  // rel~="icon" matches rel="icon" / "shortcut icon" but not "apple-touch-icon",
  // which is the home-screen icon and shouldn't follow the tab.
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
}

export function useProjectFavicon(projectId: string | null): void {
  // Subscribing to the icon (a primitive, so no re-render churn) rather than
  // snapshotting it means changing a project's icon in Settings repaints the tab
  // straight away instead of waiting for a reload.
  const icon = useProjectStore((s) => projectId ? selectProject(s, projectId)?.icon : undefined)

  useEffect(() => {
    const links = iconLinks()
    if (links.length === 0) return
    // Captured before any swap, so cleanup restores the real defaults even if
    // this effect re-runs while a previous project's icon is still applied.
    const originals = links.map((l) => l.getAttribute('href'))
    const restore = () => {
      links.forEach((l, i) => {
        const href = originals[i]
        if (href !== null) l.setAttribute('href', href)
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
      for (const l of links) l.setAttribute('href', url)
    })

    return () => {
      live = false
      restore()
    }
  }, [projectId, icon])
}
