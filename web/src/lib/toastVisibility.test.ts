import { describe, expect, it } from 'vitest'
import type { ApprovalToastData } from '../stores/toastStore'
import { approvalToastDuplicatesOpenAgent } from './toastVisibility'

const hostApproval = (overrides: Partial<ApprovalToastData> = {}): ApprovalToastData => ({
  kind: 'host_command',
  target: 'ss -Hltn',
  projectId: 'project-1',
  agentId: 'agent-1',
  ...overrides,
})

describe('approvalToastDuplicatesOpenAgent', () => {
  it('hides a host-run toast on its own open agent page', () => {
    expect(approvalToastDuplicatesOpenAgent(hostApproval(), 'project-1', 'agent-1')).toBe(true)
  })

  it('keeps the host-run toast available away from that agent page', () => {
    expect(approvalToastDuplicatesOpenAgent(hostApproval(), 'project-1', 'agent-2')).toBe(false)
    expect(approvalToastDuplicatesOpenAgent(hostApproval(), undefined, undefined)).toBe(false)
  })

  it('does not hide approval kinds without a matching transcript card', () => {
    expect(approvalToastDuplicatesOpenAgent(hostApproval({ kind: 'egress' }), 'project-1', 'agent-1')).toBe(false)
  })
})
