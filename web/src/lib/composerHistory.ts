// Undo/redo history for the spawn composer, spanning BOTH the typed prompt and
// the attachment chips.
//
// The composer turns large/file pastes into attachment chips (and a second paste
// of the same block inlines it again — see SpawnForm / pastedText). Those
// mutations call `e.preventDefault()`, so the browser's native textarea undo
// never sees them and Ctrl+Z can't walk them back. This module replaces native
// undo with an explicit snapshot stack so a single Ctrl+Z steps back through the
// real history regardless of whether a step changed text, attachments, or both:
//
//   text… → [paste image] → typeA → [paste text] → [re-paste inlines it] → typeB
//
// Ctrl+Z then unwinds typeB → un-inline (text back to a chip) → drop the text
// chip → typeA → drop the image chip → text…, each as its own step.
//
// A snapshot is the whole composer state (prompt + attachments + caret). Typing
// is coalesced into one step per burst (so a run of keystrokes is one Ctrl+Z,
// not one-per-character) while every structural action — attach, remove, inline —
// is its own discrete step. Async upload results aren't user actions, so they
// patch the matching chip across the whole timeline (`reconcileHistory`) instead
// of creating an undo step, keeping a resolved path correct at any undo position.
//
// The pure reducers below are exported for unit testing; useComposerHistory wraps
// them for React.

import { useCallback, useRef, useState } from 'react'
import type { Attachment } from './spawnDrafts'

// One point in the composer's history: the full state plus the caret to restore
// when this snapshot becomes current again via undo/redo.
export interface ComposerSnapshot {
  prompt: string
  attachments: Attachment[]
  selStart: number
  selEnd: number
}

// 'type' steps coalesce with one another (a typing burst); 'structural' steps
// (attach/remove/inline) never coalesce, so the typing on either side of one
// stays a separate undo step.
type StepKind = 'type' | 'structural'

export interface HistoryState {
  past: ComposerSnapshot[]
  present: ComposerSnapshot
  future: ComposerSnapshot[]
  // Coalescing bookkeeping — not itself part of any undo step.
  lastKind: StepKind
  lastTime: number
}

// Consecutive typing within this many ms merges into one undo step; a longer
// pause starts a new one, so a long edit still has a few coarse checkpoints.
export const COALESCE_MS = 400

// Cap retained steps so a long session can't grow history without bound. Old
// steps fall off the bottom (you can always still undo the most recent ~200).
export const MAX_HISTORY = 200

export function makeSnapshot(
  prompt: string,
  attachments: Attachment[],
  selStart: number,
  selEnd: number,
): ComposerSnapshot {
  return { prompt, attachments, selStart, selEnd }
}

export function initHistory(present: ComposerSnapshot): HistoryState {
  return { past: [], present, future: [], lastKind: 'structural', lastTime: 0 }
}

export function canUndo(h: HistoryState): boolean {
  return h.past.length > 0
}

export function canRedo(h: HistoryState): boolean {
  return h.future.length > 0
}

// Record a new present. A coalescible typing step that closely follows another
// typing step REPLACES the present (extending the same undo step) rather than
// pushing a new one; anything else pushes. Any commit clears the redo stack.
export function commitHistory(
  h: HistoryState,
  next: ComposerSnapshot,
  coalesce: boolean,
  now: number,
): HistoryState {
  if (coalesce && h.lastKind === 'type' && now - h.lastTime < COALESCE_MS) {
    return { ...h, present: next, future: [], lastTime: now }
  }
  const past = [...h.past, h.present]
  while (past.length > MAX_HISTORY) past.shift()
  return {
    past,
    present: next,
    future: [],
    lastKind: coalesce ? 'type' : 'structural',
    lastTime: now,
  }
}

export function undoHistory(h: HistoryState): HistoryState {
  if (h.past.length === 0) return h
  const present = h.past[h.past.length - 1]
  return {
    past: h.past.slice(0, -1),
    present,
    future: [h.present, ...h.future],
    // After an undo, the next keystroke must start a fresh step rather than
    // coalescing into (and corrupting) the snapshot we just restored.
    lastKind: 'structural',
    lastTime: 0,
  }
}

export function redoHistory(h: HistoryState): HistoryState {
  if (h.future.length === 0) return h
  const present = h.future[0]
  return {
    past: [...h.past, h.present],
    present,
    future: h.future.slice(1),
    lastKind: 'structural',
    lastTime: 0,
  }
}

// Patch the attachment with `id` everywhere it appears in the timeline (past,
// present, future) WITHOUT creating an undo step. Used when an async upload
// resolves its path/error: the resolution isn't a user action, and the chip may
// be present in several snapshots, so undoing to any of them must show the
// settled state, not a stale "uploading…".
export function reconcileHistory(
  h: HistoryState,
  id: number,
  patch: Partial<Attachment>,
): HistoryState {
  const fix = (s: ComposerSnapshot): ComposerSnapshot => {
    if (!s.attachments.some((a) => a.id === id)) return s
    return { ...s, attachments: s.attachments.map((a) => (a.id === id ? { ...a, ...patch } : a)) }
  }
  return {
    ...h,
    past: h.past.map(fix),
    present: fix(h.present),
    future: h.future.map(fix),
  }
}

export interface ComposerHistory {
  present: ComposerSnapshot
  canUndo: boolean
  canRedo: boolean
  // Commit a new present, built from the authoritative current present (so it
  // composes correctly with any async `reconcile` that landed since the caller
  // last rendered). `coalesce` true marks a typing edit (merges with an adjacent
  // typing burst); false marks a structural step (its own undo step).
  commit: (updater: (prev: ComposerSnapshot) => ComposerSnapshot, coalesce: boolean) => void
  // Patch one attachment across the whole timeline without a new undo step.
  reconcile: (id: number, patch: Partial<Attachment>) => void
  // Replace the whole history with a single fresh baseline (e.g. on project
  // switch or after submit), discarding undo/redo.
  reset: (present: ComposerSnapshot) => void
  // Step the present back/forward, returning the now-current snapshot (so the
  // caller can restore its caret), or null if there was nothing to undo/redo.
  undo: () => ComposerSnapshot | null
  redo: () => ComposerSnapshot | null
}

export function useComposerHistory(initial: ComposerSnapshot): ComposerHistory {
  const [history, setHistory] = useState<HistoryState>(() => initHistory(initial))
  // historyRef mirrors `history` so undo()/redo() can read the current state and
  // return the restored snapshot synchronously (no stale closure, and correct
  // even for two undos in one tick). Seeded from the initial state; thereafter
  // it's only ever written by `apply`, which runs in event handlers — never
  // during render.
  const historyRef = useRef<HistoryState>(history)

  const apply = useCallback((next: HistoryState) => {
    historyRef.current = next
    setHistory(next)
  }, [])

  const commit = useCallback(
    (updater: (prev: ComposerSnapshot) => ComposerSnapshot, coalesce: boolean) => {
      const h = historyRef.current!
      apply(commitHistory(h, updater(h.present), coalesce, Date.now()))
    },
    [apply],
  )

  const reconcile = useCallback(
    (id: number, patch: Partial<Attachment>) => {
      apply(reconcileHistory(historyRef.current!, id, patch))
    },
    [apply],
  )

  const reset = useCallback(
    (present: ComposerSnapshot) => {
      apply(initHistory(present))
    },
    [apply],
  )

  const undo = useCallback((): ComposerSnapshot | null => {
    const h = historyRef.current!
    if (!canUndo(h)) return null
    const next = undoHistory(h)
    apply(next)
    return next.present
  }, [apply])

  const redo = useCallback((): ComposerSnapshot | null => {
    const h = historyRef.current!
    if (!canRedo(h)) return null
    const next = redoHistory(h)
    apply(next)
    return next.present
  }, [apply])

  return {
    present: history.present,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    commit,
    reconcile,
    reset,
    undo,
    redo,
  }
}
