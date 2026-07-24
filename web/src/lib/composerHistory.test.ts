import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Attachment } from './spawnDrafts'
import {
  COALESCE_MS,
  MAX_HISTORY,
  canRedo,
  canUndo,
  commitHistory,
  initHistory,
  makeSnapshot,
  reconcileHistory,
  redoHistory,
  undoHistory,
  useComposerHistory,
  type ComposerSnapshot,
} from './composerHistory'

function att(id: number, over: Partial<Attachment> = {}): Attachment {
  return { id, filename: `f${id}`, path: null, size: 1, uploading: true, ...over }
}

function snap(prompt: string, attachments: Attachment[] = []): ComposerSnapshot {
  return makeSnapshot(prompt, attachments, prompt.length, prompt.length)
}

// A monotonically increasing clock helper so tests don't touch Date.now().
function clock(start = 1000) {
  let t = start
  return { next: (step = COALESCE_MS + 1) => (t += step) }
}

describe('composerHistory', () => {
  it('starts with no undo/redo available', () => {
    const h = initHistory(snap(''))
    expect(canUndo(h)).toBe(false)
    expect(canRedo(h)).toBe(false)
  })

  it('walks the user scenario back step by step', () => {
    // text... → paste image → typeA → paste text → re-paste inlines → typeB
    const c = clock()
    let h = initHistory(snap('text'))
    const img = att(1, { filename: 'image1.png', previewUrl: 'blob:img' })
    const txt = att(2, { filename: 'pasted-text-1.txt' })

    // paste image (structural)
    h = commitHistory(h, snap('text', [img]), false, c.next())
    // typeA (typing burst)
    h = commitHistory(h, snap('textA', [img]), true, c.next())
    // paste text attachment (structural)
    h = commitHistory(h, snap('textA', [img, txt]), false, c.next())
    // re-paste inlines it: chip removed AND text spliced in - one atomic step
    h = commitHistory(h, snap('textA<inlined>', [img]), false, c.next())
    // typeB (typing burst)
    h = commitHistory(h, snap('textA<inlined>B', [img]), true, c.next())

    expect(h.present.prompt).toBe('textA<inlined>B')

    h = undoHistory(h) // undo typeB
    expect(h.present).toEqual(expect.objectContaining({ prompt: 'textA<inlined>' }))
    expect(h.present.attachments).toEqual([img])

    h = undoHistory(h) // un-inline: text back to a chip
    expect(h.present.prompt).toBe('textA')
    expect(h.present.attachments).toEqual([img, txt])

    h = undoHistory(h) // drop the text chip
    expect(h.present.attachments).toEqual([img])
    expect(h.present.prompt).toBe('textA')

    h = undoHistory(h) // undo typeA
    expect(h.present.prompt).toBe('text')
    expect(h.present.attachments).toEqual([img])

    h = undoHistory(h) // drop the image chip
    expect(h.present.prompt).toBe('text')
    expect(h.present.attachments).toEqual([])

    expect(canUndo(h)).toBe(false)
  })

  it('coalesces a fast typing burst into a single undo step', () => {
    let t = 1000
    let h = initHistory(snap(''))
    h = commitHistory(h, snap('a'), true, (t += 10))
    h = commitHistory(h, snap('ab'), true, (t += 10))
    // eslint-disable-next-line no-useless-assignment -- final t += 10 is a dead store, but keep it consistent with the steps above
    h = commitHistory(h, snap('abc'), true, (t += 10))
    // One step back to the empty baseline, not three.
    expect(h.past.length).toBe(1)
    h = undoHistory(h)
    expect(h.present.prompt).toBe('')
  })

  it('starts a new typing step after a pause', () => {
    let h = initHistory(snap(''))
    h = commitHistory(h, snap('a'), true, 1000)
    h = commitHistory(h, snap('ab'), true, 1000 + COALESCE_MS + 1)
    expect(h.past.length).toBe(2)
    h = undoHistory(h)
    expect(h.present.prompt).toBe('a')
  })

  it('does not coalesce typing across a structural step', () => {
    const c = clock()
    let h = initHistory(snap(''))
    h = commitHistory(h, snap('a'), true, c.next(10))
    h = commitHistory(h, snap('a', [att(1)]), false, c.next(10)) // structural, fast
    h = commitHistory(h, snap('ab', [att(1)]), true, c.next(10)) // typing, fast
    // Three distinct steps despite the small time gaps.
    expect(h.past.length).toBe(3)
  })

  it('redo replays an undone step and a fresh commit clears redo', () => {
    let h = initHistory(snap(''))
    h = commitHistory(h, snap('a'), false, 1000)
    h = undoHistory(h)
    expect(canRedo(h)).toBe(true)
    const r = redoHistory(h)
    expect(r.present.prompt).toBe('a')
    expect(canRedo(r)).toBe(false)

    // Branching: undo then a new commit drops the redo future.
    h = undoHistory(redoHistory(h))
    h = commitHistory(h, snap('z'), false, 2000)
    expect(canRedo(h)).toBe(false)
    expect(h.present.prompt).toBe('z')
  })

  it('undo/redo are no-ops at the ends', () => {
    const h = initHistory(snap('x'))
    expect(undoHistory(h)).toBe(h)
    expect(redoHistory(h)).toBe(h)
  })

  it('reconcile patches a chip across the whole timeline without adding a step', () => {
    const c = clock()
    let h = initHistory(snap(''))
    const a = att(7, { filename: 'p.txt' })
    h = commitHistory(h, snap('', [a]), false, c.next()) // attach (uploading)
    h = commitHistory(h, snap('x', [a]), true, c.next()) // type after
    const beforePast = h.past.length

    h = reconcileHistory(h, 7, { path: '/abs/p.txt', uploading: false })
    expect(h.past.length).toBe(beforePast) // no new undo step

    // Present and the earlier snapshot both reflect the settled upload.
    expect(h.present.attachments[0]).toMatchObject({ path: '/abs/p.txt', uploading: false })
    const undone = undoHistory(h)
    expect(undone.present.attachments[0]).toMatchObject({ path: '/abs/p.txt', uploading: false })
  })

  it('reconcile ignores ids not present in a snapshot', () => {
    let h = initHistory(snap(''))
    h = commitHistory(h, snap('', [att(1)]), false, 1000)
    const same = reconcileHistory(h, 999, { uploading: false })
    expect(same.present).toBe(h.present) // untouched snapshots keep identity
  })

  it('caps retained history at MAX_HISTORY', () => {
    let h = initHistory(snap('0'))
    for (let i = 1; i <= MAX_HISTORY + 50; i++) {
      h = commitHistory(h, snap(String(i)), false, 1000 + i)
    }
    expect(h.past.length).toBe(MAX_HISTORY)
  })
})

describe('useComposerHistory', () => {
  it('commits via an updater, undoes, and redoes through React state', () => {
    const { result } = renderHook(() => useComposerHistory(snap('')))

    act(() => result.current.commit((p) => makeSnapshot('a', p.attachments, 1, 1), false))
    expect(result.current.present.prompt).toBe('a')
    expect(result.current.canUndo).toBe(true)

    let restored: ComposerSnapshot | null = null
    act(() => { restored = result.current.undo() })
    expect(restored).toEqual(expect.objectContaining({ prompt: '' }))
    expect(result.current.present.prompt).toBe('')
    expect(result.current.canRedo).toBe(true)

    act(() => { restored = result.current.redo() })
    expect(restored).toEqual(expect.objectContaining({ prompt: 'a' }))
    expect(result.current.present.prompt).toBe('a')
  })

  it('reconcile after a later commit settles the chip at every undo position', () => {
    const { result } = renderHook(() => useComposerHistory(snap('')))
    const chip = att(3, { filename: 'p.txt' })

    // Attach (uploading), then type - mirrors a real paste followed by typing.
    act(() => result.current.commit((p) => makeSnapshot(p.prompt, [chip], 0, 0), false))
    act(() => result.current.commit((p) => makeSnapshot('x', p.attachments, 1, 1), true))
    // Upload resolves out-of-band (no new undo step).
    act(() => result.current.reconcile(3, { path: '/abs/p.txt', uploading: false }))

    expect(result.current.present.attachments[0]).toMatchObject({ path: '/abs/p.txt', uploading: false })

    // Undo the typing step - the attachment is still settled, not "uploading".
    act(() => { result.current.undo() })
    expect(result.current.present.prompt).toBe('')
    expect(result.current.present.attachments[0]).toMatchObject({ path: '/abs/p.txt', uploading: false })
  })

  it('reset discards undo/redo and starts a fresh baseline', () => {
    const { result } = renderHook(() => useComposerHistory(snap('a')))
    act(() => result.current.commit((p) => makeSnapshot('ab', p.attachments, 2, 2), false))
    act(() => result.current.reset(snap('fresh')))
    expect(result.current.present.prompt).toBe('fresh')
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
  })

  it('two undos in one tick walk back two steps (ref stays current)', () => {
    const { result } = renderHook(() => useComposerHistory(snap('')))
    act(() => result.current.commit((p) => makeSnapshot('a', p.attachments, 1, 1), false))
    act(() => result.current.commit((p) => makeSnapshot('b', p.attachments, 1, 1), false))
    act(() => {
      result.current.undo()
      result.current.undo()
    })
    expect(result.current.present.prompt).toBe('')
  })
})
