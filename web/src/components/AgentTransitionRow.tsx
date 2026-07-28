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
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-gray-500 dark:text-gray-400">
        {lead && <span>{withBranchPills(lead)}</span>}
        {badge && <Badge variant="sm" className={badge.className}>{badge.label}</Badge>}
        {after && <span>{withBranchPills(after)}</span>}
      </div>
    </>
  )
}
