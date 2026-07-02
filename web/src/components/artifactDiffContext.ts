import { createContext } from 'react'
import type { ArtifactABControls, ImageDiffMode } from './ArtifactImageDiff'

// Global A/B controls. When a provider is present (the diff viewer's artifacts
// panel), every A/B tile — image and video — reads its before/after view and
// "highlight changed pixels" flag from here and hides its own per-tile pill, so one
// control (and the X/B/A/H keyboard shortcuts) flips and highlights them all at once.
// Absent (the repository browser, which has no shared toolbar) → each tile falls
// back to its own local toggles, shown inline as before.
export const ABControlsContext = createContext<ArtifactABControls | null>(null)

export const IMAGE_DIFF_MODES: { value: ImageDiffMode; label: string }[] = [
  { value: 'ab', label: 'Before · After' },
  { value: 'slider', label: 'Before · After (slider)' },
  { value: 'side-by-side', label: 'Side by side' },
  { value: 'onion', label: 'Onion skin' },
]
