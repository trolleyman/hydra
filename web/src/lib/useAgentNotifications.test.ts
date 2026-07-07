import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAgentNotifications } from './useAgentNotifications'
import { useAgentStore } from '../stores/agentStore'
import { useProjectStore } from '../stores/projectStore'
import { useToastStore } from '../stores/toastStore'
import type { AgentResponse } from '../api'
import { AgentStatus } from '../api'

// react-router's useNavigate touches a live router context we don't set up here;
// the transition-toast path only needs it to exist, so stub it to a no-op.
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

const PROJECT = 'proj-1'

function makeAgent(id: string, status: AgentStatus): AgentResponse {
  return {
    id,
    project_path: '/proj',
    session_pid: 0,
    session_status: 'running',
    agent_type: 'claude',
    pre_prompt: '',
    prompt: '',
    base_branch: 'main',
    agent_status: { status, timestamp: '2026-01-01T00:00:00Z' },
  }
}

// Seed the live agent list for the current project without the optimistic-override
// machinery in setAgents, so a status is exactly what we set.
function seedAgents(agents: AgentResponse[]) {
  act(() => {
    useAgentStore.setState({ agents, agentsProjectId: PROJECT })
  })
}

const transitionToasts = () =>
  useToastStore.getState().toasts.filter((t) => t.agentTransition !== undefined)

beforeEach(() => {
  useToastStore.setState(useToastStore.getInitialState(), true)
  useAgentStore.setState(useAgentStore.getInitialState(), true)
  useProjectStore.setState({ projects: [] })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Render the hook, seed a first-sighting (which never toasts), then transition the
// agent's status and let the effect re-run. `selectedAgentId` is what the branch
// page has open. pageActive=true keeps OS notifications out of the picture.
function runTransition(selectedAgentId: string | undefined, to: AgentStatus) {
  seedAgents([makeAgent('a1', AgentStatus.RUNNING)])
  renderHook(() => useAgentNotifications(PROJECT, true, selectedAgentId))
  seedAgents([makeAgent('a1', to)])
}

describe('useAgentNotifications - suppress toasts for the selected branch', () => {
  it('pops a finished transition toast when a different branch is selected', () => {
    runTransition('other-agent', AgentStatus.FINISHED)
    expect(transitionToasts()).toHaveLength(1)
    expect(transitionToasts()[0].agentTransition?.agentId).toBe('a1')
  })

  it('pops a needs_input transition toast when no branch is selected', () => {
    runTransition(undefined, AgentStatus.NEEDS_INPUT)
    expect(transitionToasts()).toHaveLength(1)
  })

  it('suppresses the finished toast when its own branch is the selected one', () => {
    runTransition('a1', AgentStatus.FINISHED)
    expect(transitionToasts()).toHaveLength(0)
  })

  it('suppresses the needs_input toast when its own branch is the selected one', () => {
    runTransition('a1', AgentStatus.NEEDS_INPUT)
    expect(transitionToasts()).toHaveLength(0)
  })

  it('pops an error transition toast when a different branch is selected', () => {
    runTransition('other-agent', AgentStatus.ERRORED)
    const toasts = transitionToasts()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].agentTransition?.status).toBe('errored')
    expect(toasts[0].type).toBe('error')
  })

  it('suppresses the error toast when its own branch is the selected one', () => {
    runTransition('a1', AgentStatus.ERRORED)
    expect(transitionToasts()).toHaveLength(0)
  })
})
