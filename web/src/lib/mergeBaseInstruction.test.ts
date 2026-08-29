import { describe, expect, it } from 'vitest'
import type { AgentResponse } from '../api'
import { mergeBaseInstruction } from './mergeBaseInstruction'

function agent(gitIsolation: string): AgentResponse {
  return { base_branch: 'main', git_isolation: gitIsolation } as AgentResponse
}

describe('mergeBaseInstruction', () => {
  it('directs a read-only head to the scoped Hydra merge tools', () => {
    const text = mergeBaseInstruction(agent('readonly'), false)
    expect(text).toContain('mcp__hydra__git_merge` tool')
    expect(text).toContain('mcp__hydra__git_merge_continue')
    expect(text).toContain('not host-run or raw git merge')
  })

  it('directs a writable head to merge directly in its sandbox', () => {
    const text = mergeBaseInstruction(agent('off'), false)
    expect(text).toContain('Run `git merge main` directly in the sandbox')
    expect(text).toContain('not through host-run')
    expect(text).not.toContain('mcp__hydra__git_merge')
  })

  it('uses conflict-repair wording for the merge conflict action', () => {
    expect(mergeBaseInstruction(agent('readonly'), true)).toMatch(/^Fix the merge conflicts/)
  })
})
