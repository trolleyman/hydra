import { useContext } from 'react'
import { Link } from '@tanstack/react-router'
import { ToastDismissContext } from '../stores/toastStore'
import { useProjectStore } from '../stores/projectStore'
import { Badge } from './Badge'
import { agentStatusBadge } from '../lib/agentDisplay'
import { withBranchPills } from '../lib/branchPills'
import type { AgentTransitionSpec } from '../lib/agentToast'

// AgentTransitionRow is the body of an agent status-transition / merge-lifecycle
// toast: the agent's name as a link to it, then a "<before> <status pill> <after>"
// line. It reads the bound dismiss from ToastDismissContext so clicking the name
// navigates AND closes the toast. Rendered via agentTransitionToast (lib/agentToast).
export function AgentTransitionRow({ agentName, agentId, projectId, status, before, after }: AgentTransitionSpec) {
  const dismiss = useContext(ToastDismissContext)
  const badge = status ? agentStatusBadge(status) : undefined
  const lead = before ?? 'transitioned to'
  const openAgent = () => {
    // Match a cross-project View: select the project (a no-op for the current one)
    // before the link routes, then tear the toast down.
    useProjectStore.getState().setSelectedProjectId(projectId)
    dismiss()
  }
  return (
    <>
      <Link
        to="/project/$projectId/agent/$agentId"
        params={{ projectId, agentId }}
        onClick={openAgent}
        title="Open this agent"
        className="block max-w-full truncate text-left text-sm font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 hover:underline dark:hover:text-blue-400 cursor-pointer transition-colors"
      >
        {agentName}
      </Link>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-gray-500 dark:text-gray-400">
        {lead && <span>{withBranchPills(lead)}</span>}
        {badge && <Badge variant="sm" className={badge.className}>{badge.label}</Badge>}
        {after && <span>{withBranchPills(after)}</span>}
      </div>
    </>
  )
}
