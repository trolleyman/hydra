import { beforeEach, describe, expect, it, vi } from 'vitest'

const { addReviewComment } = vi.hoisted(() => ({ addReviewComment: vi.fn() }))

vi.mock('../stores/apiClient', () => ({
  api: { default: { addReviewComment } },
}))

import { sendReviewComment, notifiedNumbers } from './reviewComments'

describe('sendReviewComment', () => {
  beforeEach(() => addReviewComment.mockReset())

  it('returns the published comment list so the diff can render it immediately', async () => {
    addReviewComment.mockResolvedValue({
      comments: [{
        number: 4,
        status: 'published',
        author: 'user',
        body: 'Handle this edge case',
        path: 'web/src/example.ts',
        line: 18,
        old_side: false,
        diff: 'main -> working tree',
        context: '@@ context',
        hunk_hash: 'abc',
        created_at: '2026-07-30T10:00:00Z',
      }],
      notified: 'New review comment: #4 (web/src/example.ts:18).',
    })

    const result = await sendReviewComment('project', 'agent', {
      path: 'web/src/example.ts',
      lineNum: 18,
      isNew: true,
      text: 'Handle this edge case',
      fromLabel: 'main',
      toLabel: 'working tree',
      contextBlock: '@@ context',
      hunkHash: 'abc',
    })

    expect(addReviewComment).toHaveBeenCalledWith('project', 'agent', expect.objectContaining({
      body: 'Handle this edge case',
      publish: true,
    }))
    expect(result.notified).toContain('#4')
    expect(result.comments).toEqual([expect.objectContaining({
      number: 4,
      published: true,
      text: 'Handle this edge case',
    })])
  })
})

describe('notifiedNumbers', () => {
  it('reads the handles out of the line the agent was actually sent', () => {
    expect(notifiedNumbers('Review comments added: #3 (a.ts:4), #4. Read them with the get_review_comments tool.'))
      .toEqual([3, 4])
  })

  it('is empty when nothing was delivered, so the caller can say so', () => {
    expect(notifiedNumbers(null)).toEqual([])
    // A line with no handle in it is not a number we may invent one from.
    expect(notifiedNumbers('Review comments added.')).toEqual([])
  })
})
