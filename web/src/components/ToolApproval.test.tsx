import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../api'
import { ChatApprovalContext } from '../lib/toolApproval'
import { ToolApproval } from './ToolApproval'

const context = { projectId: 'project-1', agentId: 'agent-1' }

function renderApproval(approval: ApprovalRequest) {
  return render(
    <ChatApprovalContext.Provider value={context}>
      <ToolApproval approval={approval} />
    </ChatApprovalContext.Provider>,
  )
}

describe('ToolApproval explanation', () => {
  it('does not repeat a host-run why above the durable body section', () => {
    renderApproval({
      reqid: 'host-1',
      kind: 'host_command',
      tool: 'host-run',
      target: 'ss -Hltn',
      summary: 'wants to run a command on the host',
      description: 'Inspect the host listener table.',
      reason: 'The agent asked to run a command outside its sandbox, on the host.',
    })

    expect(screen.queryByText('Inspect the host listener table.')).toBeNull()
    expect(screen.getByText('The agent asked to run a command outside its sandbox, on the host.')).toBeVisible()
  })

  it('keeps descriptions for approvals without their own durable body section', () => {
    renderApproval({
      reqid: 'tool-1',
      kind: 'mcp_tool',
      tool: 'mcp__example__write',
      target: 'example__write',
      summary: 'wants to run an MCP tool',
      description: 'Create the requested record.',
      reason: 'This tool writes.',
    })

    expect(screen.getByText('Create the requested record.')).toBeVisible()
    expect(screen.getByText('This tool writes.')).toBeVisible()
  })
})
