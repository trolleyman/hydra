import { create } from 'zustand'

export type DialogType = 'info' | 'error' | 'warning' | 'confirm'

interface DialogState {
  isOpen: boolean
  title: string
  message: string
  type: DialogType
  showCancel?: boolean
  onConfirm?: () => void
  onCancel?: () => void
  show: (options: { 
    title: string; 
    message: string; 
    type?: DialogType; 
    showCancel?: boolean;
    onConfirm?: () => void;
    onCancel?: () => void;
  }) => void
  // Patch the currently-open dialog in place (e.g. to fold in a warning that
  // was computed asynchronously after the dialog was shown). No-op if closed.
  update: (patch: Partial<Pick<DialogState, 'title' | 'message' | 'type'>>) => void
  hide: () => void
}

export const useDialogStore = create<DialogState>((set) => ({
  isOpen: false,
  title: '',
  message: '',
  type: 'info',
  showCancel: false,
  onConfirm: undefined,
  onCancel: undefined,
  show: ({ title, message, type = 'info', showCancel = false, onConfirm, onCancel }) =>
    set({ isOpen: true, title, message, type, showCancel, onConfirm, onCancel }),
  update: (patch) => set((s) => (s.isOpen ? patch : {})),
  hide: () => set({ isOpen: false }),
}))
