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

// Spy on the OS-notification helpers. fireNotification is inert in these tests
// (pageActive=true keeps it from being called anyway); dismissNotification is the
// retraction we assert on when a needs_input/unread state clears.
vi.mock('./notifyPrefs', () => ({
  fireNotification: vi.fn(),
  dismissNotification: vi.fn(),
}))
import { dismissNotification } from './notifyPrefs'

const PROJECT = 'proj-1'

function makeAgent(id: string, status: AgentStatus, unread = false): AgentResponse {
  return {
    id,
    project_path: '/proj',
    session_pid: 0,
    session_status: 'running',
    agent_type: 'claude',
    pre_prompt: '',
    prompt: '',
    base_branch: 'main',
    has_unread_changes: unread,
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
  vi.mocked(dismissNotification).mockClear()
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
})

describe('useAgentNotifications - retract OS notifications when state clears', () => {
  it('dismisses the needs-input notification when the agent leaves needs_input', () => {
    seedAgents([makeAgent('a1', AgentStatus.NEEDS_INPUT)])
    renderHook(() => useAgentNotifications(PROJECT, true, undefined))
    seedAgents([makeAgent('a1', AgentStatus.RUNNING)])

    expect(dismissNotification).toHaveBeenCalledWith('needs-input:a1')
  })

  it('does not dismiss needs-input while the agent stays blocked', () => {
    seedAgents([makeAgent('a1', AgentStatus.RUNNING)])
    renderHook(() => useAgentNotifications(PROJECT, true, undefined))
    seedAgents([makeAgent('a1', AgentStatus.NEEDS_INPUT)])

    expect(dismissNotification).not.toHaveBeenCalledWith('needs-input:a1')
  })

  it('dismisses the finished notification when the unread flag is read', () => {
    seedAgents([makeAgent('a1', AgentStatus.FINISHED, true)])
    renderHook(() => useAgentNotifications(PROJECT, true, undefined))
    seedAgents([makeAgent('a1', AgentStatus.FINISHED, false)])

    expect(dismissNotification).toHaveBeenCalledWith('finished:a1')
  })

  it('does not dismiss finished while the changes stay unread', () => {
    seedAgents([makeAgent('a1', AgentStatus.FINISHED, true)])
    renderHook(() => useAgentNotifications(PROJECT, true, undefined))
    seedAgents([makeAgent('a1', AgentStatus.FINISHED, true)])

    expect(dismissNotification).not.toHaveBeenCalledWith('finished:a1')
  })
})
