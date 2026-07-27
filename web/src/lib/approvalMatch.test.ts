import { describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../api'
import { approvalMatchesTool } from './approvalMatch'

const req = (over: Partial<ApprovalRequest>): ApprovalRequest => ({
  reqid: '1',
  tool: 'host-run',
  kind: 'host_command',
  target: 'echo hi',
  summary: 'wants to run a command on the host',
  ...over,
})

describe('approvalMatchesTool', () => {
  it('matches a host_command to the Bash card that asked for it', () => {
    const input = { command: `/tmp/hydra-internal host-run -- bash -c "echo hi"` }
    expect(approvalMatchesTool(req({}), 'Bash', input)).toBe(true)
  })

  it('does not match a different host-run in the same transcript', () => {
    const input = { command: '/tmp/hydra-internal host-run -- bash -c "rm -rf /"' }
    expect(approvalMatchesTool(req({}), 'Bash', input)).toBe(false)
  })

  it('does not match an ordinary Bash command', () => {
    expect(approvalMatchesTool(req({}), 'Bash', { command: 'echo hi' })).toBe(false)
  })

  it('matches a gated tool call by the tool the gate parked on', () => {
    const a = req({ kind: 'mcp_tool', tool: 'mcp__linear__create_issue', target: 'linear__create_issue' })
    expect(approvalMatchesTool(a, 'mcp__linear__create_issue', {})).toBe(true)
    expect(approvalMatchesTool(a, 'mcp__linear__list_issues', {})).toBe(false)
  })

  it('matches a webfetch only on the same URL', () => {
    const a = req({ kind: 'webfetch', tool: 'WebFetch', target: 'example.com', url: 'https://example.com/a' })
    expect(approvalMatchesTool(a, 'WebFetch', { url: 'https://example.com/a' })).toBe(true)
    expect(approvalMatchesTool(a, 'WebFetch', { url: 'https://example.com/b' })).toBe(false)
  })

  it('never matches an egress request (no tool call behind it)', () => {
    expect(approvalMatchesTool(req({ kind: 'egress', tool: 'WebFetch', target: 'example.com' }), 'WebFetch', {})).toBe(false)
  })
})
