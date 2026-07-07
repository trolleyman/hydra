import { create } from 'zustand'
import { StorageKeys, readLocal, writeLocal } from './storage'

// Which head action is primary in the agent header. A per-device UI preference
// (set on the Browser settings tab) - it only orders the two buttons, so it is
// not part of the project/review config. null = unset (follow the project's
// [review] default_action, else 'merge').
export type PrimaryAction = 'merge' | 'create_mr'

function initialAction(): PrimaryAction | null {
  const v = readLocal(StorageKeys.defaultAction)
  return v === 'merge' || v === 'create_mr' ? v : null
}

interface DefaultActionState {
  action: PrimaryAction | null
  setAction: (a: PrimaryAction) => void
}

// Backed by localStorage so it persists, and a store so the Browser toggle and
// the agent header stay in sync live (mirrors useThemeStore).
export const useDefaultAction = create<DefaultActionState>((set) => ({
  action: initialAction(),
  setAction: (action) => {
    writeLocal(StorageKeys.defaultAction, action)
    set({ action })
  },
}))
