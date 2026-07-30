import React, { useContext } from 'react'
import { Check, ShieldAlert, X } from 'lucide-react'
import type { ApprovalRequest } from '../api'
import { ApprovalDecisionRequest } from '../api'
import { ChatApprovalContext, decideToolApproval } from '../lib/toolApproval'

const buttonBase = 'inline-flex items-center gap-1 rounded-md px-2 py-1 text-2xs font-semibold transition-colors cursor-pointer'

// ToolApproval is the Allow once / Deny row inside a tool card whose call the
// security gate has parked (see lib/toolApproval for how a card finds its
// request). "Always allow" is deliberately absent - it persists a grant to the
// trusted config, which belongs with the full approval card and its explanation,
// not a two-button row in the transcript.
export const ToolApproval: React.FC<{ approval: ApprovalRequest }> = ({ approval }) => {
  const ctx = useContext(ChatApprovalContext)
  if (!ctx) return null
  const { projectId, agentId } = ctx
  const decide = (decision: ApprovalDecisionRequest.decision) =>
    void decideToolApproval(projectId, agentId, approval, decision)
  return (
    <div className="rounded-md border border-amber-300/70 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/10 px-2.5 py-2 space-y-1.5">
      <div className="flex items-start gap-1.5 text-2xs leading-snug text-amber-800 dark:text-amber-200">
        <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
        {/* The agent's own explanation (host-run --why) leads when there is one:
            it says what this call is FOR, which is what the decision turns on.
            The gate's reason is generic by comparison, so it drops to a muted
            second line rather than displacing it. */}
        {approval.description ? (
          <span className="space-y-0.5">
            <span className="block whitespace-pre-wrap">{approval.description}</span>
            <span className="block text-amber-700/70 dark:text-amber-200/60">
              {approval.reason || 'This call is waiting for your approval.'}
            </span>
          </span>
        ) : (
          <span>{approval.reason || 'This call is waiting for your approval.'}</span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => decide(ApprovalDecisionRequest.decision.ALLOW)}
          className={`${buttonBase} bg-blue-600 text-white hover:bg-blue-500`}
        >
          <Check className="w-3 h-3" />
          Allow once
        </button>
        <button
          onClick={() => decide(ApprovalDecisionRequest.decision.DENY)}
          className={`${buttonBase} border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10`}
        >
          <X className="w-3 h-3" />
          Deny
        </button>
      </div>
    </div>
  )
}
