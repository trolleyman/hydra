import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MRStateChip, ReviewTooltipContent } from './ReviewControls'
import type { AgentResponse } from '../api'

// A minimal linked head. Only the fields MRStateChip reads matter.
function linked(review: Partial<NonNullable<AgentResponse['review']>>): AgentResponse {
  return {
    id: 'h1',
    agent_type: 'claude',
    project_path: '/p',
    base_branch: 'main',
    review: { url: 'https://forge/mr/1', id: '1', provider: 'gitlab', ...review },
  } as AgentResponse
}

describe('MRStateChip ahead/behind', () => {
  it('offers a push when the head is ahead', () => {
    const onPush = vi.fn()
    const { getByLabelText } = render(<MRStateChip agent={linked({ ahead: 2, behind: 0 })} onPush={onPush} />)
    const btn = getByLabelText('Push 2 to the MR branch')
    btn.click()
    expect(onPush).toHaveBeenCalledOnce()
  })

  it('offers a pull when the head is behind', () => {
    const onPull = vi.fn()
    const { getByLabelText, queryByLabelText } = render(
      <MRStateChip agent={linked({ ahead: 0, behind: 3 })} onPull={onPull} />,
    )
    getByLabelText('Pull 3 from the MR branch').click()
    expect(onPull).toHaveBeenCalledOnce()
    expect(queryByLabelText(/^Push/)).toBeNull()
  })

  it('says "in sync" when there is nothing to do', () => {
    const { getByText } = render(<MRStateChip agent={linked({ ahead: 0, behind: 0 })} />)
    expect(getByText('in sync')).toBeInTheDocument()
  })

  // Unmeasured ahead/behind (no downstream ref yet) must stay silent rather than
  // claim "in sync" - that would be a guess presented as a fact.
  it('renders no sync chip when ahead/behind are unknown', () => {
    const { queryByText, queryByLabelText } = render(<MRStateChip agent={linked({})} />)
    expect(queryByText('in sync')).toBeNull()
    expect(queryByLabelText(/^(Push|Pull)/)).toBeNull()
  })

  // A read-only adopted PR still shows how far ahead it is (worth knowing) but
  // must not offer a push the backend would reject.
  it('shows the ahead count but no push button on a read-only adopted PR', () => {
    const onPush = vi.fn()
    const { getByText, queryByLabelText } = render(
      <MRStateChip agent={linked({ ahead: 4, behind: 0, adopted: true, can_push: false })} onPush={onPush} />,
    )
    expect(getByText('4')).toBeInTheDocument()
    expect(queryByLabelText(/^Push/)).toBeNull()
  })
})

describe('ReviewTooltipContent', () => {
  it('uses PR wording and keeps the GitHub source branch in the hover summary', () => {
    const agent = linked({
      provider: 'github',
      id: '5',
      target_branch: 'main',
      state: { state: 'draft', ci_status: 'running', approvals: 1, approvals_required: 2, unresolved_discussions: 3 },
    })
    agent.downstream_branch = 'feat/close-pr'
    const { getByText, queryByText } = render(<ReviewTooltipContent agent={agent} />)

    expect(getByText('GitHub PR #5')).toBeInTheDocument()
    expect(getByText('PR branch')).toBeInTheDocument()
    expect(getByText('feat/close-pr')).toBeInTheDocument()
    expect(getByText('1/2')).toBeInTheDocument()
    expect(getByText('3 unresolved')).toBeInTheDocument()
    expect(queryByText('MR branch')).toBeNull()
  })

  it('uses MR wording for GitLab', () => {
    const agent = linked({ id: '42' })
    agent.downstream_branch = 'feat/gitlab'
    const { getByText, queryByText } = render(<ReviewTooltipContent agent={agent} />)

    expect(getByText('GitLab MR #42')).toBeInTheDocument()
    expect(getByText('MR branch')).toBeInTheDocument()
    expect(queryByText('PR branch')).toBeNull()
  })
})
