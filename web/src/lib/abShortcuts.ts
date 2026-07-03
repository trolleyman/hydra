// The shared X/B/A/H keyboard bindings for a before/after comparator: X flips the
// view, B and A jump straight to Before/After, H toggles the changed-pixel
// highlight. Used by both the diff grid's global A/B controls (ArtifactsPanel) and
// the fullscreen lightbox comparator (ImageLightbox) so the two always agree -
// each caller adds its own scope guards (grid: only in A/B mode and not while the
// lightbox is open; lightbox: only on a diff entry) before delegating here.
export type ABShortcutTarget = {
  view: 'before' | 'after'
  highlight: boolean
  onViewChange: (v: 'before' | 'after') => void
  onHighlightChange: (h: boolean) => void
}

// Applies the shortcut (and preventDefaults) if the event is one of X/B/A/H;
// returns whether it was. Plain single keys only (no Ctrl/Meta/Alt, so browser
// chords like Ctrl+H pass through), and never while typing in a field.
export function applyABShortcut(e: KeyboardEvent, target: ABShortcutTarget): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false
  const t = e.target as HTMLElement | null
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return false
  switch (e.key.toLowerCase()) {
    case 'x': target.onViewChange(target.view === 'before' ? 'after' : 'before'); break
    case 'b': target.onViewChange('before'); break
    case 'a': target.onViewChange('after'); break
    case 'h': target.onHighlightChange(!target.highlight); break
    default: return false
  }
  e.preventDefault()
  return true
}
