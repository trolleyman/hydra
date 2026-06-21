import { create } from 'zustand'

export type ToastType = 'info' | 'success' | 'error' | 'warning'

export interface Toast {
  id: number
  message: string
  type: ToastType
}

interface ToastState {
  toasts: Toast[]
  // Returns the new toast's id, so callers showing a persistent toast
  // (duration: 0) can later dismiss() it — e.g. a "Merging…" indicator.
  show: (options: { message: string; type?: ToastType; duration?: number }) => number
  dismiss: (id: number) => void
}

let nextId = 1

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: ({ message, type = 'info', duration = 3000 }) => {
    const id = nextId++
    set((state) => ({ toasts: [...state.toasts, { id, message, type }] }))
    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
      }, duration)
    }
    return id
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))
