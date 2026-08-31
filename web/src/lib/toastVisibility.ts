import type { ApprovalToastData } from '../stores/toastStore'

export function approvalToastDuplicatesOpenAgent(
  approval: ApprovalToastData | undefined,
  projectId: string | undefined,
  agentId: string | undefined,
): boolean {
  return approval?.kind === 'host_command'
    && approval.projectId === projectId
    && approval.agentId === agentId
}
