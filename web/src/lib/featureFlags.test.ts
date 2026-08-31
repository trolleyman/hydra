import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyFeatureFlagClasses,
  loadCustomScrollbars,
  loadSmoothChatWheel,
  useFeatureFlagsStore,
} from './featureFlags'
import { StorageKeys } from './storage'

describe('scroll feature flags', () => {
  beforeEach(() => {
    localStorage.clear()
    useFeatureFlagsStore.setState({ smoothChatWheel: false, customScrollbars: false })
    document.documentElement.classList.remove('hydra-custom-scrollbars')
  })

  it('defaults both behaviors off', () => {
    expect(loadSmoothChatWheel()).toBe(false)
    expect(loadCustomScrollbars()).toBe(false)
  })

  it('persists each flag independently', () => {
    useFeatureFlagsStore.getState().setSmoothChatWheel(true)
    expect(localStorage.getItem(StorageKeys.featureSmoothChatWheel)).toBe('on')
    expect(localStorage.getItem(StorageKeys.featureCustomScrollbars)).toBeNull()

    useFeatureFlagsStore.getState().setCustomScrollbars(true)
    expect(localStorage.getItem(StorageKeys.featureCustomScrollbars)).toBe('on')
    expect(document.documentElement).toHaveClass('hydra-custom-scrollbars')

    useFeatureFlagsStore.getState().setSmoothChatWheel(false)
    expect(localStorage.getItem(StorageKeys.featureSmoothChatWheel)).toBeNull()
    expect(useFeatureFlagsStore.getState().customScrollbars).toBe(true)
  })

  it('applies the persisted scrollbar class before app mount', () => {
    localStorage.setItem(StorageKeys.featureCustomScrollbars, 'on')
    useFeatureFlagsStore.setState({ customScrollbars: true })
    applyFeatureFlagClasses()
    expect(document.documentElement).toHaveClass('hydra-custom-scrollbars')
  })
})
