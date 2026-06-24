// Shared masonry-column layout for the artifact grids — used by BOTH the diff
// viewer's ArtifactsPanel and the repository browser's RepositoryArtifactsView, so
// the two surfaces share one persisted layout preference (the column count slider +
// the per-column widths set by dragging the dividers). See MasonryGrid in
// components/ArtifactsPanel.tsx for how these drive the layout.

import { useCallback, useEffect, useState } from 'react'
import { StorageKeys, readLocal, writeLocal } from './storage'

// One layout for the whole panel. `count` is the requested number of columns (the
// slider); `weights` are the per-column width fractions set by dragging the
// dividers — applied only when their length matches the rendered column count,
// otherwise columns are equal width.
export type ArtifactColumns = { count: number; weights: number[] }

export const DEFAULT_ARTIFACT_COLUMNS: ArtifactColumns = { count: 3, weights: [] }
export const MIN_ARTIFACT_COLUMNS = 1
export const MAX_ARTIFACT_COLUMNS = 6

const clampCount = (n: number) =>
  Math.max(MIN_ARTIFACT_COLUMNS, Math.min(MAX_ARTIFACT_COLUMNS, Math.round(n)))

function loadColumns(): ArtifactColumns {
  const raw = readLocal(StorageKeys.diffArtifactCols)
  if (raw) {
    try {
      const p = JSON.parse(raw) as Partial<ArtifactColumns>
      const count = typeof p.count === 'number' ? clampCount(p.count) : DEFAULT_ARTIFACT_COLUMNS.count
      const weights = Array.isArray(p.weights) ? p.weights.filter((x): x is number => typeof x === 'number' && x > 0) : []
      return { count, weights }
    } catch { /* fall through to default */ }
  }
  return DEFAULT_ARTIFACT_COLUMNS
}

// useArtifactColumns owns the persisted artifact-grid layout. Returns the current
// columns plus setters for the count (the slider — resets custom widths, since the
// saved weights no longer match the new count) and the weights (the dividers).
export function useArtifactColumns() {
  const [columns, setColumns] = useState<ArtifactColumns>(loadColumns)
  useEffect(() => { writeLocal(StorageKeys.diffArtifactCols, JSON.stringify(columns)) }, [columns])
  const setColumnCount = useCallback((count: number) => {
    setColumns({ count: clampCount(count), weights: [] })
  }, [])
  const setColumnWeights = useCallback((weights: number[]) => {
    setColumns((c) => ({ ...c, weights }))
  }, [])
  return { columns, setColumnCount, setColumnWeights }
}
