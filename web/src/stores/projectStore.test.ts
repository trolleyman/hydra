import { describe, it, expect } from 'vitest'
import { expandOrder, visibleProjects } from './projectStore'
import type { ProjectInfo } from '../api'

// Unit tests for the two pure helpers behind the per-project visibility setting:
// which projects a list shows, and how a drag over that (shortened) list is
// mapped back onto the full one before being persisted.

function p(id: string, hidden = false): ProjectInfo {
  return { id, name: id, path: `/tmp/${id}`, hidden } as ProjectInfo
}

describe('visibleProjects', () => {
  it('returns the same array when nothing is hidden', () => {
    const list = [p('a'), p('b')]
    // Identity matters: the dropdown and the switcher re-derive this on every
    // render, and a fresh array would defeat their memoisation.
    expect(visibleProjects(list, null)).toBe(list)
  })

  it('drops hidden projects', () => {
    const list = [p('a'), p('b', true), p('c')]
    expect(visibleProjects(list, null).map((x) => x.id)).toEqual(['a', 'c'])
  })

  it('keeps a hidden project that is the selected one', () => {
    const list = [p('a'), p('b', true), p('c')]
    expect(visibleProjects(list, 'b').map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('expandOrder', () => {
  const all = [p('a'), p('hidden1', true), p('b'), p('c'), p('hidden2', true)]

  it('passes a full list straight through', () => {
    // Edit mode renders every project, so the dragged list is already complete.
    const shown = [p('a'), p('b'), p('c')]
    expect(expandOrder(shown, ['c', 'b', 'a'])).toEqual(['c', 'b', 'a'])
  })

  it('keeps each hidden project behind the visible one it followed', () => {
    // Visible rows dragged into c, a, b: hidden1 rides with a, hidden2 with c.
    expect(expandOrder(all, ['c', 'a', 'b'])).toEqual(['c', 'hidden2', 'a', 'hidden1', 'b'])
  })

  it('leaves hidden projects ahead of every visible one at the front', () => {
    const lead = [p('hidden0', true), p('a'), p('b')]
    expect(expandOrder(lead, ['b', 'a'])).toEqual(['hidden0', 'b', 'a'])
  })
})
