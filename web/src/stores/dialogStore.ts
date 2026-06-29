import { create } from 'zustand'

export type DialogType = 'info' | 'error' | 'warning' | 'confirm'

// Confirmation layout. 'generic' is the default text dialog (icon + title +
// message). 'merge' and 'kill' render bespoke panels (an icon tile, a stacked
// title/description and a details chip) matching the agent-action redesign. They
// flow through the same store so the single mounted <Dialog/> and every
// `isOpen` guard around the app keep working unchanged.
export type DialogVariant = 'generic' | 'merge' | 'kill'

// Extra structured content for the rich variants, filled in (and patched in
// asynchronously via `update`) by the merge/kill handlers.
export interface DialogDetails {
  // merge: the branch chip + its diff stat counts.
  fromBranch?: string
  toBranch?: string
  additions?: number
  deletions?: number
  // kill: how many unmerged files the worktree deletion will discard.
  lostFiles?: number
  // shared: a secondary caution line (e.g. a running-parent warning), plus a
  // flag while the counts above are still being fetched.
  note?: string
  loading?: boolean
}

interface DialogState {
  isOpen: boolean
  title: string
  message: string
  type: DialogType
  variant: DialogVariant
  // Label for the confirm button on rich variants (e.g. "Merge branch").
  confirmLabel?: string
  details?: DialogDetails
  showCancel?: boolean
  onConfirm?: () => void
  onCancel?: () => void
  show: (options: {
    title: string
    message: string
    type?: DialogType
    variant?: DialogVariant
    confirmLabel?: string
    details?: DialogDetails
    showCancel?: boolean
    onConfirm?: () => void
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
  details: undefined,
  showCancel: false,
  onConfirm: undefined,
  onCancel: undefined,
  show: ({ title, message, type = 'info', variant = 'generic', confirmLabel, details, showCancel = false, onConfirm, onCancel }) =>
    set({ isOpen: true, title, message, type, variant, confirmLabel, details, showCancel, onConfirm, onCancel }),
  update: (patch) => set((s) => (s.isOpen ? patch : {})),
  hide: () => set({ isOpen: false }),
}))
