import { memo } from 'react'
import { Clock, GitPullRequest } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import type { AgentResponse } from '../api'
import { renderMarkdown } from '../lib/markdown'
import { AgentTypeIcon, type AgentTypeIconName } from './AgentTypeIcon'
import { Badge } from './Badge'
import { TestVerdictChip } from './TestVerdict'
import { RelativeTime } from './LiveTime'
import {
  agentDotClass, agentDotAnimate, agentTypeColor,
  agentStatusBadge, agentStatusDetail, archivedEndStateBadge,
} from '../lib/agentDisplay'

// MRSidebarMarker is the sidebar row's linked-MR indicator: a small forge glyph
// so you can see at a glance which heads have an MR open, carrying an up-arrow
// count while the head has commits the MR branch does not. That count is the
// whole point - an unpushed commit is the state you want to notice from the list
// without opening the head (docs/non-local-integration.md).
//
// Native `title=` rather than <Tooltip>, per the per-row rule in CLAUDE.md: this
// renders once per agent in a list that re-renders about once a second, and a
// portal-mounting tooltip per row is a real perf regression.
function MRSidebarMarker({ review }: { review: NonNullable<AgentResponse['review']> }) {
  const ahead = review.ahead ?? 0
  const noun = review.adopted ? 'PR' : 'MR'
  const title = ahead > 0
    ? `${noun} ${review.id}: ${ahead} commit${ahead === 1 ? '' : 's'} not yet pushed`
    : `${noun} ${review.id}`
  return (
    <span
      title={title}
      className={`shrink-0 inline-flex items-center gap-0.5 text-[10px] tabular-nums ${
        ahead > 0 ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500'
      }`}
    >
      <GitPullRequest className="w-3 h-3 shrink-0" />
      {ahead > 0 ? <>&uarr;{ahead}</> : null}
    </span>
  )
}

// memo: the sidebar renders one of these per agent and the list re-renders on
// every agent-store refresh (about once a second while an agent is working).
// The store preserves object identity for unchanged agents, so memo makes a
// no-op refresh skip every untouched row. The created-at label stays live via
// its self-ticking <RelativeTime> leaf.
export const AgentSidebarItem = memo(function AgentSidebarItem({
  agent,
  selected,
  projectId,
  onDeselect,
}: {
  agent: AgentResponse
  selected: boolean
  projectId: string
  // Left-click on the already-open agent toggles back to the project home
  // (mirrors the Repository button). Middle/Ctrl-click ignore this and open the
  // agent page in a new tab, since the row is a real link to that page.
  onDeselect: () => void
}) {
  const archived = agent.archived ?? false
  return (
    <Link
      to="/project/$projectId/agent/$agentId"
      params={{ projectId, agentId: agent.id }}
      onClick={(e) => {
        if (selected) {
          e.preventDefault()
          onDeselect()
        }
      }}
      className={`relative block w-full text-left px-3 py-2.5 rounded-lg transition-colors cursor-pointer ${
        selected
          ? 'bg-blue-50 border border-blue-200 dark:bg-blue-900/30 dark:border-blue-800'
          : archived
            // Archived rows brighten their text on hover (opacity) rather than
            // taking a full-width background highlight like live rows do.
            ? 'opacity-60 hover:opacity-100 border border-transparent'
            : 'hover:bg-gray-100 dark:hover:bg-gray-700 border border-transparent'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${archived ? 'bg-gray-300 dark:bg-gray-600' : `${agentDotClass(agent)} ${agentDotAnimate(agent)}`}`}
        />
        <span className={`font-medium text-sm truncate ${archived ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}>{agent.title || agent.id}</span>
        {!archived && agent.agent_status?.status === 'needs_input' ? (
          // Needs-input marker: a red sibling of the blue unread dot, pinned to
          // the right of the title line. Driven by the live status rather than
          // the unread flag, so it stays lit while the agent is blocked on you
          // and clears on its own once you answer (not on open). Takes priority
          // over the blue dot since "needs you now" is the stronger signal.
          <span
            aria-label="needs your input"
            className="ml-auto shrink-0 w-2.5 h-2.5 rounded-full bg-red-500 ring-2 ring-red-500/25"
          />
        ) : agent.has_unread_changes && !archived ? (
          // Unread-changes marker, pinned to the right of the title line so it
          // never overlaps the type/status/created-time row below. Set when the
          // agent settles into finished (or reaches needs_input), cleared when it's opened.
          <span
            aria-label="unread changes"
            className="ml-auto shrink-0 w-2.5 h-2.5 rounded-full bg-sky-400 ring-2 ring-sky-400/25"
          />
        ) : null}
      </div>
      <div className="flex items-center gap-1.5 mt-0.5 ml-4 min-w-0 overflow-hidden">
        <span className={`flex items-center gap-1 text-xs ${agentTypeColor(agent.agent_type)}`}>
          <AgentTypeIcon name={agent.agent_type as AgentTypeIconName} className="w-3 h-3 shrink-0" />
          {agent.agent_type || 'unknown'}
        </span>
        {archived ? (
          <Badge variant="xs" className={archivedEndStateBadge(agent.end_state).className}>
            {archivedEndStateBadge(agent.end_state).label}
          </Badge>
        ) : agent.agent_status && (
          <Badge variant="xs" className={agentStatusBadge(agent.agent_status.status).className}>
            {agentStatusBadge(agent.agent_status.status).label}
          </Badge>
        )}
        {/* Test verdict chip (PLAN #68): passing/failing/running/errored/stale.
            Hidden while the head's tip is still the base commit (at_base): that
            verdict is inherited from the base, not the agent's own work, so a
            green "passed" here is just misleading noise. The agent detail view
            still shows it. */}
        {!archived && !agent.tests?.at_base && <TestVerdictChip tests={agent.tests} variant="xs" />}
        {!archived && agent.merge_when_green ? (
          <Clock className="w-3 h-3 text-green-600 dark:text-green-400 shrink-0" aria-label="auto-merge armed" />
        ) : null}
        {!archived && agent.review ? <MRSidebarMarker review={agent.review} /> : null}
      </div>
      {((!archived && agent.agent_status) || agent.created_at || agent.archived_at) && (
        // Bottom line: live activity / last message on the left, with the relative
        // created-at timestamp pinned to the bottom-right. The timestamp lives here
        // (rather than on the badge row above) so the badge row keeps its full width
        // for the type/status/test chips instead of squeezing them against the date.
        //
        // Reserve a fixed-height line so the row keeps a constant height as the
        // activity text appears, disappears, or changes between status transitions -
        // otherwise the whole sidebar jumps around. The height MUST NOT be driven by
        // the rendered content's line box: an inline monospace `code` chip
        // (shell-command activity) and plain proportional status text are
        // baseline-aligned but have different font metrics, so even at an identical
        // `line-height` their inline boxes distribute that height differently around
        // the baseline and the line box's union can exceed it - making a code line
        // taller than a plain one. Pinning line-height (a previous fix) wasn't enough
        // for that reason. Instead lock a fixed `h-4` and center the content
        // (`flex items-center`), clipping any overflow, so the row is exactly 1rem
        // tall whichever font the activity uses. The activity span carries `truncate`
        // (+ `min-w-0` so it can shrink inside the flex row) for the horizontal
        // ellipsis; the timestamp is `shrink-0` so it always stays fully visible.
        <div className="mt-0.5 ml-4 h-4 flex items-center gap-2 overflow-hidden text-[11px] text-gray-400 dark:text-gray-500">
          <span className="min-w-0 flex-1 truncate">
            {!archived && agent.agent_status
              ? renderMarkdown(agentStatusDetail(agent), { dollarCommand: true, singleLine: true })
              : null}
          </span>
          {/* An archived row shows when it ENDED, not when it was spawned: the
              history list is ordered by that (see db.ListArchivedAgents), and a
              list sorted on one timestamp while showing another reads as
              unsorted. Falls back to created_at for a legacy row archived
              before the timestamp was recorded. Native title (not <Tooltip>) -
              this renders once per sidebar row, see CLAUDE.md. */}
          {archived && agent.archived_at ? (
            <span
              className="shrink-0 text-[10px] text-gray-300 dark:text-gray-600 tabular-nums"
              title={`${archivedEndStateBadge(agent.end_state).label} ${new Date(agent.archived_at * 1000).toLocaleString()}`}
            >
              <RelativeTime createdAt={agent.archived_at} />
            </span>
          ) : agent.created_at ? (
            <span
              className="shrink-0 text-[10px] text-gray-300 dark:text-gray-600 tabular-nums"
              title={`created ${new Date(agent.created_at * 1000).toLocaleString()}`}
            >
              <RelativeTime createdAt={agent.created_at} />
            </span>
          ) : null}
        </div>
      )}
    </Link>
  )
})
