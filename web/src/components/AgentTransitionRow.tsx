import { Badge } from './Badge'
import { AgentNameLink } from './AgentNameLink'
import { agentStatusBadge } from '../lib/agentDisplay'
import { withBranchPills } from '../lib/branchPills'
import type { AgentTransitionSpec } from '../lib/agentToast'

// AgentTransitionRow is the body of an agent status-transition / merge-lifecycle
// toast: the agent's name as a link to it, then a "<before> <status pill> <after>"
// line. The name row is the shared AgentNameLink, which also closes the toast on
// click. Rendered via agentTransitionToast (lib/agentToast).
export function AgentTransitionRow({ agentName, agentId, projectId, status, before, after }: AgentTransitionSpec) {
  const badge = status ? agentStatusBadge(status) : undefined
  const lead = before ?? 'transitioned to'
  return (
    <>
      {/* The flex row keeps the tooltip's inline-flex wrapper off a line box (an
          inline child of the block toast body would pick up the parent's taller
          strut and grow the row); min-w-0 keeps the name truncating. */}
      <div className="flex min-w-0">
        <AgentNameLink agentName={agentName} agentId={agentId} projectId={projectId} size="title" />
      </div>
      {/* mt-1, not mt-0.5: the title above carries `.optical-center`, which trims
          its line box to the cap-to-baseline ink and so takes 1.33px out of the
          row. Without putting that back the two lines read as one cramped block
          - the trim fixes the title's alignment against its Bot but must not
          also close the gap to the status line. */}
      {/* items-BASELINE. This line mixes three kinds of box - a status chip at
          12px, prose at 13px, and a mono branch pill at 0.9em - and centring
          aligns each one's LINE BOX, which differs per type scale and per
          padding. The three sat on three baselines ("merged" 1.8px below "into",
          "main" 2.2px above it) and the row read as jumbled. Their text
          baselines are what should agree.
          The chips cooperate because neither is a flex container with
          items-center: Badge's text-only variant is a plain span, and BranchPill
          is an inline-block (see the note there) - a flex container would expose
          no baseline at all and this would silently do nothing for the pill. */}
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
        {/* Trimmed like the title above: with items-baseline the row's height is
            max-above-baseline + max-below-baseline, and an untrimmed 13px run
            contributes descender slack the eye doesn't weigh - which is what
            pushed the whole body's ink above the tile's centre. */}
        {lead && <span className="optical-center">{withBranchPills(lead)}</span>}
        {badge && <Badge variant="sm" className={badge.className}>{badge.label}</Badge>}
        {after && <span className="optical-center">{withBranchPills(after)}</span>}
      </div>
    </>
  )
}
