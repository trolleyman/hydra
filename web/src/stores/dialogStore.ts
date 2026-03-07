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
  hide: () => set({ isOpen: false }),
}))
