// Experimental browser-only behavior exposed on Settings -> Feature flags.
// Both flags default off: an absent key always means the browser's native scroll
// behavior and native scrollbar chrome. They are independent so either suspect
// layer can be tested without turning the other one back on.

import { create } from 'zustand'
import { StorageKeys, readLocal, writeLocal } from './storage'

export function loadSmoothChatWheel(): boolean {
  return readLocal(StorageKeys.featureSmoothChatWheel) === 'on'
}

export function loadCustomScrollbars(): boolean {
  return readLocal(StorageKeys.featureCustomScrollbars) === 'on'
}

interface FeatureFlagsState {
  smoothChatWheel: boolean
  customScrollbars: boolean
  setSmoothChatWheel: (enabled: boolean) => void
  setCustomScrollbars: (enabled: boolean) => void
}

function applyCustomScrollbarClass(enabled: boolean): void {
  document.documentElement.classList.toggle('hydra-custom-scrollbars', enabled)
}

export const useFeatureFlagsStore = create<FeatureFlagsState>((set) => ({
  smoothChatWheel: loadSmoothChatWheel(),
  customScrollbars: loadCustomScrollbars(),
  setSmoothChatWheel: (enabled) => {
    writeLocal(StorageKeys.featureSmoothChatWheel, enabled ? 'on' : null)
    set({ smoothChatWheel: enabled })
  },
  setCustomScrollbars: (enabled) => {
    writeLocal(StorageKeys.featureCustomScrollbars, enabled ? 'on' : null)
    applyCustomScrollbarClass(enabled)
    set({ customScrollbars: enabled })
  },
}))

// Run before React mounts so an opted-in scrollbar width is present on the first
// frame rather than changing the page geometry after paint.
export function applyFeatureFlagClasses(): void {
  applyCustomScrollbarClass(useFeatureFlagsStore.getState().customScrollbars)
}
