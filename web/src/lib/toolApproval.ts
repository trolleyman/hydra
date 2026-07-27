import { createContext, useContext } from 'react'
import type { ApprovalRequest } from '../api'
import { ApprovalDecisionRequest } from '../api'
import { api } from '../stores/apiClient'
import { useApprovalStore } from '../stores/approvalStore'
import { useToastStore } from '../stores/toastStore'
import { runWithToast } from './apiAction'
import { approvalMatchesTool } from './approvalMatch'

// The plumbing behind the in-chat approval row (components/ToolApproval renders
// it). The security gate parks a tool call and a toast asks you to allow or deny
// it; that toast is the out-of-context channel - it finds you wherever you are.
// When you ARE looking at the head's chat, the natural place to answer is the
// tool card itself, which already shows the command/arguments in full.
//
// Both surfaces share one pending set (approvalStore, filled by the poller in
// useAgentNotifications) and one decide path, so answering in either tears the
// other down.

// Which head the surrounding chat belongs to; null disables the inline approval
// (a transcript rendered without a project has nowhere to post a decision).
export const ChatApprovalContext = createContext<{ projectId: string; agentId: string } | null>(null)

// usePendingToolApproval returns the parked request this tool card is blocked on,
// if any.
//
// `unresolved` means the card never got a tool_result - not that the chat still
// shows it as "running". Opening the agent page DURING the wait replays the
// parked tool_use as history, and replay settles every result-less card (it
// can't tell a finished turn's leftovers from a live one), so gating on the
// running indicator would hide the buttons in exactly the case they exist for.
export function usePendingToolApproval(
  toolName: string,
  input: Record<string, unknown> | null,
  unresolved: boolean,
): ApprovalRequest | null {
  const ctx = useContext(ChatApprovalContext)
  const parked = useApprovalStore((s) => (ctx ? s.pending[ctx.agentId] : undefined))
  if (!ctx || !unresolved || !parked?.length) return null
  return parked.find((a) => approvalMatchesTool(a, toolName, input)) ?? null
}

// decideToolApproval answers a parked request and clears both surfaces: the
// shared pending set (so the row disappears at once) and the toast raised for the
// same reqid - silently, since that toast's own dismiss would DENY a call we may
// have just allowed.
export async function decideToolApproval(
  projectId: string,
  agentId: string,
  approval: ApprovalRequest,
  decision: ApprovalDecisionRequest.decision,
) {
  useApprovalStore.getState().resolve(agentId, approval.reqid)
  const toasts = useToastStore.getState()
  const open = toasts.toasts.find((t) => t.key === `approval:${agentId}:${approval.reqid}` && !t.exiting)
  if (open) toasts.dismiss(open.id, { silent: true })
  // host_command echoes the approved command back: the daemon runs THAT text
  // rather than re-reading the head-writable request file (the TOCTOU guard).
  const command = approval.kind === 'host_command' ? approval.target : undefined
  await runWithToast(
    () => api.default.decideAgentApproval(projectId, agentId, approval.reqid, { decision, remember: false, command }),
    { errorPrefix: decision === ApprovalDecisionRequest.decision.ALLOW ? 'Failed to allow request' : 'Failed to deny request' },
  )
}
