import { create } from 'zustand'

// Open/close state for the keyboard-shortcuts help overlay. A tiny store (rather
// than local state in __root) so any surface can pop it open - the global `?`
// handler, the sidebar footer button - without prop-drilling.
interface ShortcutsState {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

export const useShortcutsStore = create<ShortcutsState>((set, get) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),
}))
