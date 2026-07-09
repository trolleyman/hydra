import type { AgentResponse } from '../api'
import { DiffViewer } from '../DiffViewer'

// InspectorPane is the right-hand "inspector" pane of the new two-pane agent
// layout. It owns its own scroll container (independent of the left working
// pane), inside which DiffViewer renders in `inspector` mode: a target selector
// plus a Diff | Tests | Previews view switcher on top, and the selected view
// below (the diff owning the base selector, with artifacts folded into it).
//
// The pane is deliberately thin - the view selector, per-view toolbars and the
// sticky-header coordination all live inside DiffViewer's inspector branch, which
// already holds the diff/tests/preview state. This wrapper exists to give that a
// dedicated scroll context (so sticky headers dock against THIS pane, not the
// page) and a clean seam the split layout mounts.
export function InspectorPane({
  agent,
  projectId,
  externalRefreshTrigger,
  externalArtifactRefresh,
}: {
  agent: AgentResponse
  projectId: string | null
  externalRefreshTrigger?: number
  externalArtifactRefresh?: number
}) {
  return (
    // pt-4 mirrors the classic scroll container so DiffViewer's `-top-4` sticky
    // chrome docks flush at the pane top. data-inspector-scroll marks this as the
    // pane's own scroll context (the classic layout's single [data-main-scroll]
    // is gone in the split - each pane scrolls independently).
    <div
      data-inspector-scroll
      className="flex-1 min-w-0 min-h-0 overflow-auto px-3 sm:px-6 pt-4 pb-6"
    >
      <DiffViewer
        agent={agent}
        projectId={projectId}
        externalRefreshTrigger={externalRefreshTrigger}
        externalArtifactRefresh={externalArtifactRefresh}
        inspector
      />
    </div>
  )
}
