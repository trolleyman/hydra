import { describe, expect, it } from 'vitest'
import type { AgentResponse, ProjectInfo } from '../api'
import { AgentStatus } from '../api'
import { agentHasActiveTurn, desktopRunningAgentCount } from './desktopCloseState'

function agent(session: string, status?: AgentStatus): AgentResponse {
  return {
    id: 'agent-1', project_path: '/repo', session_pid: 1, session_status: session,
    agent_type: 'codex', pre_prompt: '', prompt: '', base_branch: 'main',
    agent_status: status ? { status, timestamp: '' } : undefined,
  }
}

describe('desktop close state', () => {
  it('does not mistake a finished turn reusable process for active work', () => {
    expect(agentHasActiveTurn(agent('running', AgentStatus.FINISHED))).toBe(false)
    expect(agentHasActiveTurn(agent('running', AgentStatus.WAITING))).toBe(false)
  })

  it('recognises working and starting turns', () => {
    expect(agentHasActiveTurn(agent('running', AgentStatus.RUNNING))).toBe(true)
    expect(agentHasActiveTurn(agent('running', AgentStatus.STARTING))).toBe(true)
    expect(agentHasActiveTurn(agent('running'))).toBe(true)
  })

  it('counts active agent statuses across projects', () => {
    const projects = [
      { id: 'one', name: 'One', path: '/one', running_count: 2 },
      { id: 'two', name: 'Two', path: '/two', running_count: 1 },
    ] as ProjectInfo[]
    expect(desktopRunningAgentCount(projects, false)).toBe(3)
    expect(desktopRunningAgentCount([], true)).toBe(1)
  })
})
