import { describe, expect, it, vi } from 'vitest'
import { createArrayIndex } from './arrayIndex'

describe('createArrayIndex', () => {
  it('builds one map per array identity', () => {
    const keyOf = vi.fn((item: { id: string }) => item.id)
    const index = createArrayIndex(keyOf)
    const items = [{ id: 'a' }, { id: 'b' }]

    const first = index(items)
    const second = index(items)

    expect(second).toBe(first)
    expect(second.get('b')).toBe(items[1])
    expect(keyOf).toHaveBeenCalledTimes(2)
  })

  it('rebuilds the map for a new array', () => {
    const index = createArrayIndex((item: { id: string }) => item.id)
    const firstItem = { id: 'a' }
    const nextItem = { id: 'a' }

    expect(index([firstItem]).get('a')).toBe(firstItem)
    expect(index([nextItem]).get('a')).toBe(nextItem)
  })
})
