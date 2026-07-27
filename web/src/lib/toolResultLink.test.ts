import { describe, it, expect } from 'vitest'
import {
  claimOrphanResult,
  newToolResultLink,
  stashOrphanResult,
  MAX_ORPHAN_RESULTS,
} from './toolResultLink'

describe('toolResultLink', () => {
  const orphan = (result: string) => ({ result, isError: false, images: [] })

  it('applies a stashed result to the card built for it later', () => {
    const link = newToolResultLink()
    stashOrphanResult(link, 'toolu_1', orphan('ok'))
    const card = claimOrphanResult(link, { kind: 'tool', toolUseId: 'toolu_1', name: 'Bash' })
    expect(card).toMatchObject({ result: 'ok', isError: false })
    // Claimed once: a second card with the same id gets nothing.
    expect(claimOrphanResult(link, { kind: 'tool', toolUseId: 'toolu_1', name: 'Bash' })).not.toHaveProperty('result')
  })

  it('carries only the answer text onto a question card', () => {
    const link = newToolResultLink()
    stashOrphanResult(link, 'toolu_q', { result: 'answered', isError: false, images: ['a.png'] })
    const card = claimOrphanResult(link, { kind: 'question', toolUseId: 'toolu_q' })
    expect(card).toMatchObject({ result: 'answered' })
    expect(card).not.toHaveProperty('resultImages')
  })

  it('carries a tool result error flag and images', () => {
    const link = newToolResultLink()
    stashOrphanResult(link, 'toolu_e', { result: 'boom', isError: true, images: ['a.png'] })
    expect(claimOrphanResult(link, { kind: 'tool', toolUseId: 'toolu_e', name: 'Bash' })).toMatchObject({
      result: 'boom',
      isError: true,
      resultImages: ['a.png'],
    })
  })

  it('registers every card id so a later result knows the card exists', () => {
    const link = newToolResultLink()
    claimOrphanResult(link, { kind: 'tool', toolUseId: 'toolu_2', name: 'Read' })
    expect(link.known.has('toolu_2')).toBe(true)
    // Non-tool items are none of its business.
    claimOrphanResult(link, { kind: 'assistant' })
    expect(link.known.size).toBe(1)
  })

  it('bounds the map so never-claimed results cannot grow without limit', () => {
    const link = newToolResultLink()
    for (let i = 0; i < MAX_ORPHAN_RESULTS + 100; i++) stashOrphanResult(link, `toolu_${i}`, orphan('x'))
    expect(link.orphans.size).toBe(MAX_ORPHAN_RESULTS)
    // The oldest entries are the ones evicted.
    expect(link.orphans.has('toolu_0')).toBe(false)
    expect(link.orphans.has(`toolu_${MAX_ORPHAN_RESULTS + 99}`)).toBe(true)
  })
})
