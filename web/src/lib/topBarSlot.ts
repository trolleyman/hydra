import { create } from 'zustand'

// The global top bar (rendered by __root) exposes a slot element that route
// content can portal into - the agent page injects its status dot, title and
// action toolbar there. A tiny element-holding store (rather than context)
// because __root and the portal live in unrelated subtrees of the router.
interface TopBarSlotState {
  el: HTMLDivElement | null
  setEl: (el: HTMLDivElement | null) => void
}

export const useTopBarSlot = create<TopBarSlotState>()((set) => ({
  el: null,
  setEl: (el) => set({ el }),
}))
