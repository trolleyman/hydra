import { describe, expect, it } from 'vitest'
import { parseServerPlan } from './planStore'

describe('parseServerPlan', () => {
  it('normalizes Codex step plans for the shared plan panel', () => {
    expect(parseServerPlan(JSON.stringify([
      { step: 'Inspect repository', status: 'completed' },
      { step: 'Run checks', status: 'inProgress' },
      { step: 'Report', status: 'pending' },
    ]))).toEqual([
      { key: 'plan:0', content: 'Inspect repository', status: 'completed', activeForm: undefined, description: undefined, order: 1 },
      { key: 'plan:1', content: 'Run checks', status: 'in_progress', activeForm: undefined, description: undefined, order: 2 },
      { key: 'plan:2', content: 'Report', status: 'pending', activeForm: undefined, description: undefined, order: 3 },
    ])
  })
})
