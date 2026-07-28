import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { WorkSpark } from './WorkSpark'
import { ChatAgentTypeContext } from '../lib/chatAgentType'
import { AGENT_ACCENT } from '../lib/agentTypeMeta'

const spark = (agentType?: string, still = false) => {
  const el = <WorkSpark still={still} />
  const { container } = render(
    agentType == null ? el : <ChatAgentTypeContext.Provider value={agentType}>{el}</ChatAgentTypeContext.Provider>,
  )
  return container.querySelector('svg')!
}

describe('WorkSpark', () => {
  it('takes the accent of the chat it is rendered in', () => {
    for (const type of ['claude', 'gemini', 'copilot', 'codex'] as const) {
      for (const cls of AGENT_ACCENT[type].split(' ')) expect(spark(type)).toHaveClass(cls)
    }
  })

  it('falls back to Claude accent outside a provider, and for an unknown agent type', () => {
    for (const cls of AGENT_ACCENT.claude.split(' ')) expect(spark()).toHaveClass(cls)
    // An agent type with no brand accent must still render something legible
    // rather than inheriting the muted status-line grey it sits in.
    expect(spark('some-future-agent').getAttribute('class')).toMatch(/text-gray-500/)
  })

  it('animates only when the turn is live', () => {
    expect(spark('claude')).toHaveClass('work-spark')
    expect(spark('claude').querySelectorAll('line.work-spark-spoke')).toHaveLength(6)
    // The settled result line: same mark, no motion.
    expect(spark('claude', true)).not.toHaveClass('work-spark')
    expect(spark('claude', true).querySelectorAll('line.work-spark-spoke')).toHaveLength(0)
  })

  it('is decorative - no text for a screen reader to announce', () => {
    expect(spark('claude')).toHaveAttribute('aria-hidden', 'true')
  })
})
