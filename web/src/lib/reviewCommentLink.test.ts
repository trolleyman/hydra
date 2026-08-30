import { describe, it, expect, vi } from 'vitest'
import { commentPermalink, jumpToReviewComment, registerCommentJump } from './reviewCommentLink'

describe('commentPermalink', () => {
  it('addresses a comment by head and number', () => {
    expect(commentPermalink('proj', 'agent-1', 4)).toBe(`${window.location.origin}/project/proj/agent/agent-1#comment-4`)
  })

  it('escapes ids and survives a missing project', () => {
    expect(commentPermalink(null, 'a/b', 1)).toBe(`${window.location.origin}/project/_/agent/a%2Fb#comment-1`)
  })
})

describe('review comment jumps', () => {
  it('reports no handler so the caller follows the permalink instead', () => {
    expect(jumpToReviewComment('nobody', 3)).toBe(false)
  })

  it('drives only the head it was registered for', () => {
    const jump = vi.fn()
    const off = registerCommentJump('agent-1', jump)
    expect(jumpToReviewComment('agent-1', 7)).toBe(true)
    expect(jump).toHaveBeenCalledWith(7)
    expect(jumpToReviewComment('agent-2', 7)).toBe(false)
    off()
    expect(jumpToReviewComment('agent-1', 7)).toBe(false)
  })

  it('a remount that registers before the old cleanup keeps the live handler', () => {
    const old = vi.fn()
    const fresh = vi.fn()
    const offOld = registerCommentJump('agent-1', old)
    registerCommentJump('agent-1', fresh)
    offOld()
    expect(jumpToReviewComment('agent-1', 2)).toBe(true)
    expect(fresh).toHaveBeenCalledWith(2)
    expect(old).not.toHaveBeenCalled()
  })
})
