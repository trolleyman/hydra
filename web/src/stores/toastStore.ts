import { create } from 'zustand'

export type ToastType = 'info' | 'success' | 'error' | 'warning'

export interface Toast {
  id: number
  message: string
  type: ToastType
  // Total lifetime in ms before the toast auto-dismisses. 0 = persistent (the
  // caller dismisses it manually). Kept on the toast so the renderer can drive
  // the expiry countdown bar from it.
  duration: number
  // Wall-clock time the toast was shown, so the renderer can compute how much of
  // the lifetime remains if it ever mounts late (e.g. a re-render mid-life).
  createdAt: number
  // True once the toast is animating out. It lingers in the list for one exit
  // animation before being removed, so the leave transition can play.
  exiting: boolean
}

// How long the leave animation runs before the toast is removed from the list.
// Must match the `toast-out` keyframe duration in index.css.
const EXIT_ANIMATION_MS = 220

interface ToastState {
  toasts: Toast[]
  // Returns the new toast's id, so callers showing a persistent toast
  // (duration: 0) can later dismiss() it — e.g. a "Merging…" indicator.
  show: (options: { message: string; type?: ToastType; duration?: number }) => number
  dismiss: (id: number) => void
}

let nextId = 1

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  show: ({ message, type = 'info', duration = 3000 }) => {
    const id = nextId++
    set((state) => ({
      toasts: [...state.toasts, { id, message, type, duration, createdAt: Date.now(), exiting: false }],
    }))
    if (duration > 0) {
      setTimeout(() => get().dismiss(id), duration)
    }
    return id
  },
  // dismiss plays the leave animation: flag the toast `exiting` (so the renderer
  // swaps to the out transition and drops its countdown bar), then remove it once
  // the animation has run. Guarded so a double dismiss (timer + click) is a no-op.
  dismiss: (id) => {
    const toast = get().toasts.find((t) => t.id === id)
    if (!toast || toast.exiting) return
    set((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
    }))
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, EXIT_ANIMATION_MS)
  },
}))
