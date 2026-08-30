import { describe, expect, it } from 'vitest'
import type { AgentResponse } from '../api'
import { agentPrimaryActionAppearances } from './agentPrimaryActions'

function agent(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    id: 'agent-1',
    base_branch: 'main',
    ...overrides,
  } as AgentResponse
}

function tooltipFor(subject: AgentResponse, command: string, provider?: string): string | undefined {
  return agentPrimaryActionAppearances({ agent: subject, provider })
    .find((action) => action.command === command)?.tooltip
}

describe('agent primary action tooltips', () => {
  it('names the forge and its native review-request noun', () => {
    expect(tooltipFor(agent(), 'publish', 'github')).toBe('Create PR on GitHub')
    expect(tooltipFor(agent(), 'publish', 'gitlab')).toBe('Create MR on GitLab')
    expect(tooltipFor(agent(), 'publish')).toBe('Create MR on the forge')
  })

  it('explains the local lifecycle actions', () => {
    const subject = agent({ base_branch: 'release/next' })
    expect(tooltipFor(subject, 'merge')).toBe('Merge into release/next')
    expect(tooltipFor(subject, 'restart')).toBe('Restart the agent process, keeping its conversation, branch, and worktree')
    expect(tooltipFor(subject, 'kill')).toBe('Stop the agent and delete its worktree')
  })
})
