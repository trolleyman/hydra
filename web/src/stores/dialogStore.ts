import { create } from 'zustand'

export type DialogType = 'info' | 'error' | 'warning' | 'confirm'

// Confirmation layout. 'generic' is the default text dialog (icon + title +
// message). 'merge', 'kill' and 'updateBase' render bespoke panels (an icon
// tile, a stacked title/description and a details chip) matching the
// agent-action redesign. They flow through the same store so the single mounted
// <Dialog/> and every `isOpen` guard around the app keep working unchanged.
export type DialogVariant = 'generic' | 'merge' | 'kill' | 'updateBase' | 'mergeGate'

// Extra structured content for the rich variants, filled in (and patched in
// asynchronously via `update`) by the merge/kill handlers.
export interface DialogDetails {
  // merge / updateBase: the branch chip endpoints. For merge it's branch → base;
  // for updateBase it's base → branch (the base merged into the agent's branch).
  fromBranch?: string
  toBranch?: string
  additions?: number
  deletions?: number
  // updateBase: how many commits the branch is behind its base.
  behind?: number
  // kill: how many unmerged files the worktree deletion will discard.
  lostFiles?: number
  // shared: a secondary caution line (e.g. a running-parent warning), plus a
  // flag while the counts above are still being fetched.
  note?: string
  loading?: boolean
  // mergeGate: the head's test verdict + failing count, so the gate dialog can
  // render an explanatory status chip alongside the Force / Queue choice.
  // testProgress is the running run's "done/total" (e.g. "84/142").
  testStatus?: 'failing' | 'errored' | 'running'
  testFailed?: number
  testProgress?: string
  // mergeGate: when the merge is gated because the AGENT itself hasn't finished
  // (still working, or blocked asking you a question) rather than by a test
  // verdict, this says which — the panel renders that reason instead of a test
  // chip, over the same Force / Queue choice.
  agentGate?: 'running' | 'needs_input'
}

interface DialogState {
  isOpen: boolean
  title: string
  message: string
  type: DialogType
  variant: DialogVariant
  // Label for the confirm button on rich variants (e.g. "Merge branch").
  confirmLabel?: string
  // An optional second action (e.g. the merge-gate's "Force merge" alongside
  // "Queue merge"). Rendered as an extra toned button left of the primary confirm.
  secondaryLabel?: string
  details?: DialogDetails
  showCancel?: boolean
  onConfirm?: () => void
  onSecondary?: () => void
  onCancel?: () => void
  show: (options: {
    title: string
    message: string
    type?: DialogType
    variant?: DialogVariant
    confirmLabel?: string
    secondaryLabel?: string
    details?: DialogDetails
    showCancel?: boolean
    onConfirm?: () => void
    onSecondary?: () => void
    onCancel?: () => void
  }) => void
  // Patch the currently-open dialog in place (e.g. to fold in a warning or diff
  // stats computed asynchronously after the dialog was shown). No-op if closed.
  update: (patch: Partial<Pick<DialogState, 'title' | 'message' | 'type' | 'details'>>) => void
  hide: () => void
}

export const useDialogStore = create<DialogState>((set) => ({
  isOpen: false,
  title: '',
  message: '',
  type: 'info',
  variant: 'generic',
  confirmLabel: undefined,
  secondaryLabel: undefined,
  details: undefined,
  showCancel: false,
  onConfirm: undefined,
  onSecondary: undefined,
  onCancel: undefined,
  show: ({ title, message, type = 'info', variant = 'generic', confirmLabel, secondaryLabel, details, showCancel = false, onConfirm, onSecondary, onCancel }) =>
    set({ isOpen: true, title, message, type, variant, confirmLabel, secondaryLabel, details, showCancel, onConfirm, onSecondary, onCancel }),
  update: (patch) => set((s) => (s.isOpen ? patch : {})),
  hide: () => set({ isOpen: false }),
}))
