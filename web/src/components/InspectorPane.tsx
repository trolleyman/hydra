import type { ReactNode } from 'react'
import type { AgentResponse } from '../api'
import { DiffViewer } from '../DiffViewer'

// InspectorPane is the right-hand "inspector" pane of the two-pane agent
// layout. It owns its own scroll container (independent of the left working
// pane), inside which DiffViewer renders the same stacked layout as the classic
// single-column page: the Changes bar (base -> head selectors), then tests,
// previews, artifacts, and the diff itself (`inspector` only drops DiffViewer's
// top margin - the pane's padding supplies it).
//
// The pane is deliberately thin - the toolbars and the sticky-header
// coordination all live inside DiffViewer, which already holds the
// diff/tests/preview state. This wrapper exists to give that a dedicated scroll
// context (so sticky headers dock against THIS pane, not the page) and a clean
// seam the split layout mounts.
export function InspectorPane({
  agent,
  projectId,
  externalRefreshTrigger,
  externalArtifactRefresh,
  externalCommitSelect,
  changesLeading,
  leadingInline,
  focusComment,
}: {
  agent: AgentResponse
  projectId: string | null
  externalRefreshTrigger?: number
  externalArtifactRefresh?: number
  // A commit chip clicked in the chat: show just that commit's diff.
  externalCommitSelect?: { sha: string; nonce: number } | null
  // A control rendered at the left edge of the diff's Changes bar (the split
  // layout's collapse toggle, flanking the divider).
  changesLeading?: ReactNode
  // Flow changesLeading inline on the Changes bar's top row (beside "Changes")
  // instead of as a vertically-centered left-edge sibling - used by the narrow
  // screen-stack so the base->head selector row below gets the full width.
  leadingInline?: boolean
  // A review comment number from `?comment=N`, forwarded to the diff.
  focusComment?: number
}) {
  return (
    // pt-4 mirrors the classic scroll container so DiffViewer's `-top-4` sticky
    // chrome docks flush at the pane top. data-inspector-scroll marks this as the
    // pane's own scroll context (the classic layout's single [data-main-scroll]
    // is gone in the split - each pane scrolls independently).
    // [overflow-anchor:none]: collapsing a card triggers the browser's scroll
    // anchoring, which re-adjusts scrollTop against an arbitrary anchor node
    // and drags the view away from the card being collapsed (the card
    // components own their scroll positioning explicitly).
    <div
      data-inspector-scroll
      className="flex-1 min-w-0 min-h-0 overflow-auto px-3 sm:px-6 pt-4 pb-6 [overflow-anchor:none]"
    >
      <DiffViewer
        agent={agent}
        projectId={projectId}
        externalRefreshTrigger={externalRefreshTrigger}
        externalArtifactRefresh={externalArtifactRefresh}
        externalCommitSelect={externalCommitSelect}
        inspector
        changesLeading={changesLeading}
        leadingInline={leadingInline}
        focusComment={focusComment}
      />
    </div>
  )
}
