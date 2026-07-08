import { describe, it, expect } from 'vitest'
import { deepEqual, reuseIfEqual, reconcileList } from './deepEqual'

describe('deepEqual', () => {
  it('compares primitives', () => {
    expect(deepEqual(1, 1)).toBe(true)
    expect(deepEqual('a', 'a')).toBe(true)
    expect(deepEqual(1, 2)).toBe(false)
    expect(deepEqual(1, '1')).toBe(false)
    expect(deepEqual(null, null)).toBe(true)
    expect(deepEqual(null, undefined)).toBe(false)
    expect(deepEqual(NaN, NaN)).toBe(true)
  })

  it('compares nested objects structurally', () => {
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true)
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe(false)
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
  })

  it('distinguishes arrays from objects', () => {
    expect(deepEqual([], {})).toBe(false)
    expect(deepEqual([1], { 0: 1 })).toBe(false)
  })

  it('treats non-plain objects as reference-equal only', () => {
    const d = new Date(0)
    expect(deepEqual(d, d)).toBe(true)
    expect(deepEqual(new Date(0), new Date(0))).toBe(false)
  })
})

describe('reuseIfEqual', () => {
  it('returns the previous reference when structurally equal', () => {
    const prev = { a: [1, { b: 2 }] }
    expect(reuseIfEqual(prev, { a: [1, { b: 2 }] })).toBe(prev)
  })

  it('returns the next value when different', () => {
    const prev = { a: 1 }
    const next = { a: 2 }
    expect(reuseIfEqual(prev, next)).toBe(next)
  })
})

describe('reconcileList', () => {
  const key = (x: { id: string }) => x.id

  it('returns the previous array when nothing changed', () => {
    const prev = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }]
    const next = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }]
    expect(reconcileList(prev, next, key)).toBe(prev)
  })

  it('reuses unchanged elements when one changed', () => {
    const prev = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }]
    const next = [{ id: 'a', v: 1 }, { id: 'b', v: 3 }]
    const merged = reconcileList(prev, next, key)
    expect(merged).not.toBe(prev)
    expect(merged[0]).toBe(prev[0])
    expect(merged[1]).toBe(next[1])
  })

  it('detects reordering even when elements are unchanged', () => {
    const prev = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }]
    const next = [{ id: 'b', v: 2 }, { id: 'a', v: 1 }]
    const merged = reconcileList(prev, next, key)
    expect(merged).not.toBe(prev)
    expect(merged[0]).toBe(prev[1])
    expect(merged[1]).toBe(prev[0])
  })

  it('handles added and removed elements', () => {
    const prev = [{ id: 'a', v: 1 }]
    const added = reconcileList(prev, [{ id: 'a', v: 1 }, { id: 'b', v: 2 }], key)
    expect(added).toHaveLength(2)
    expect(added[0]).toBe(prev[0])
    const removed = reconcileList(prev, [], key)
    expect(removed).not.toBe(prev)
    expect(removed).toHaveLength(0)
  })
})
