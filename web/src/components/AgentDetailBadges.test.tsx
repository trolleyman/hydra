import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceKind, type AgentResponse } from '../api'
import { AgentStatusChip, WorkspaceBadge } from './AgentDetail'

afterEach(() => {
  vi.useRealTimers()
})

function projectDirectoryAgent(): AgentResponse {
  return {
    id: 'project-chat',
    workspace_kind: WorkspaceKind.WorkspaceKindProjectDirectory,
    project_path: '/home/callum/code/hydra',
    session_pid: 1,
    session_status: 'running',
    agent_type: 'codex',
    pre_prompt: '',
    prompt: '',
    base_branch: 'main',
  }
}

describe('Agent detail tooltip triggers', () => {
  it('uses the default cursor for the status and workspace tooltip triggers', () => {
    render(
      <>
        <AgentStatusChip status="finished" />
        <WorkspaceBadge agent={projectDirectoryAgent()} />
      </>,
    )

    expect(screen.getByRole('button', { name: 'What "finished" means' })).toHaveClass('cursor-default')
    expect(screen.getByRole('button', { name: 'Project directory workspace' })).toHaveClass('cursor-default')
    expect(document.querySelector('.cursor-help')).toBeNull()
  })

  it('shows the shared folder treatment beside the project directory path', () => {
    vi.useFakeTimers()
    const { container } = render(<WorkspaceBadge agent={projectDirectoryAgent()} />)

    fireEvent.mouseEnter(container.firstElementChild as HTMLElement)
    act(() => void vi.advanceTimersByTime(600))

    const tooltip = screen.getByRole('tooltip')
    const path = screen.getByText('/home/callum/code/hydra')
    expect(tooltip.querySelector('svg')).not.toBeNull()
    expect(path.parentElement).toHaveClass('text-stone-700')
  })
})
