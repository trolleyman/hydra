// Shared masonry layout for the artifact grids — used by BOTH the diff viewer's
// ArtifactsPanel and the repository browser's RepositoryArtifactsView, so the two
// surfaces share one persisted preference. See MasonryGrid in
// components/ArtifactsPanel.tsx for how these drive the layout.
//
// The grid is a fixed BASE_ARTIFACT_COLUMNS masonry. Each tile auto-spans 1..N of
// those columns by its media's aspect ratio — a wide desktop screenshot takes
// several columns, a tall phone screenshot just one — so you don't have to pick a
// column count yourself. Dragging a tile's right edge overrides that tile's span
// column-by-column; those overrides are what we persist here (keyed by file name).

import { useCallback, useEffect, useState } from 'react'
import { StorageKeys, readJSON, writeJSON } from './storage'

// Total columns in the masonry grid — the unit each tile's span is measured in.
// Six gives a desktop shot ~half width and a phone shot a sixth, the spread the
// aspect buckets below target. The rendered count is reduced on narrow containers
// (see MasonryGrid) so a single column never gets too thin.
export const BASE_ARTIFACT_COLUMNS = 6

// Per-tile span overrides set by dragging a tile's edge: file name → column span.
// A key being absent means the tile uses its aspect-ratio-derived default span.
export type ArtifactSpans = Record<string, number>

function loadSpans(): ArtifactSpans {
  return readJSON(StorageKeys.diffArtifactSpans, (v) => {
    if (!v || typeof v !== 'object') return null
    const out: ArtifactSpans = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'number' && val >= 1) out[k] = Math.round(val)
    }
    return out
  }) ?? {}
}

// useArtifactSpans owns the persisted per-tile span overrides. Returns the current
// overrides plus a setter that records one tile's override (or, when span is null,
// clears it so the tile falls back to its aspect-ratio default).
export function useArtifactSpans() {
  const [spans, setSpans] = useState<ArtifactSpans>(loadSpans)
  useEffect(() => { writeJSON(StorageKeys.diffArtifactSpans, spans) }, [spans])
  const setSpanOverride = useCallback((key: string, span: number | null) => {
    setSpans((s) => {
      if (span == null) {
        if (!(key in s)) return s
        const next = { ...s }
        delete next[key]
        return next
      }
      if (s[key] === span) return s
      return { ...s, [key]: span }
    })
  }, [])
  return { spans, setSpanOverride }
}

// defaultSpanForAspect picks how many columns a tile spans from its media aspect
// ratio (width / height): wide landscape (desktop) spans several columns, tall
// portrait (phone) just one. Returns the raw bucket (1..4); the grid scales it for
// side-by-side and clamps it to the rendered column count. `aspect` is undefined
// until the media is measured, when we assume a middling 2-column tile.
export function defaultSpanForAspect(aspect: number | undefined): number {
  if (aspect == null) return 2
  if (aspect < 0.8) return 1   // portrait / phone
  if (aspect < 1.3) return 2   // square-ish / tablet
  if (aspect < 2.2) return 3   // landscape / desktop
  return 4                     // ultra-wide
}
