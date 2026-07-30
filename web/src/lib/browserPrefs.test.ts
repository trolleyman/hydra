import { describe, it, expect, beforeEach } from 'vitest'
import { browserPrefs, changedBrowserPrefs, describeChanged, resetBrowserPrefs } from './browserPrefs'
import { useThemeStore } from './theme'
import { fontSizeStores, fontStores } from './fontPrefs'
import { useChatBashIndentStore, useChatHeightStore } from './chatPrefs'
import { useWhitespaceStore } from './whitespacePrefs'
import { useDefaultRowsStore } from './terminalGeometry'
import { StorageKeys } from './storage'

describe('browser prefs reset', () => {
  beforeEach(() => {
    resetBrowserPrefs()
    localStorage.clear()
  })

  it('starts with nothing to reset', () => {
    expect(changedBrowserPrefs()).toHaveLength(0)
  })

  // The point of the button: everything the tab offers goes back, whatever type
  // it is - an enum, an id, a step, a number, a nullable number.
  it('puts every kind of pref back', () => {
    useThemeStore.getState().setMode('dark')
    fontStores.chat.getState().setFont('source-serif')
    fontSizeStores.ui.getState().setStep(2)
    useChatBashIndentStore.getState().setIndent(0)
    useChatHeightStore.getState().setHeight(900)
    useWhitespaceStore.getState().setMarks('all')
    useDefaultRowsStore.getState().setRows(40)
    expect(changedBrowserPrefs()).toHaveLength(7)

    resetBrowserPrefs()

    expect(changedBrowserPrefs()).toHaveLength(0)
    expect(useThemeStore.getState().mode).toBe('system')
    expect(fontSizeStores.ui.getState().step).toBe(0)
    expect(useChatHeightStore.getState().height).toBeNull()
    expect(useDefaultRowsStore.getState().rows).toBeNull()
  })

  // A reset that leaves the value in localStorage would come back on reload.
  it('clears the stored keys, not just the live value', () => {
    fontSizeStores.ui.getState().setStep(3)
    useThemeStore.getState().setMode('light')
    expect(localStorage.getItem(StorageKeys.fontSizeUi)).toBe('3')

    resetBrowserPrefs()

    // 0 / 'system' are the defaults, and the stores write those as an ABSENT key.
    expect(localStorage.getItem(StorageKeys.fontSizeUi)).toBeNull()
    expect(useThemeStore.getState().mode).toBe('system')
  })

  // A pref missing from the list survives a reset silently, so the size is worth
  // pinning: theme + 4 font families + 4 font sizes + one each for the other
  // eleven sections of the tab. Adding a section? This number moves with it.
  it('covers every pref on the tab', () => {
    expect(browserPrefs()).toHaveLength(20)
  })

  // The Fonts section's own reset is a filter over the same list, so it must
  // move the eight font prefs and nothing else.
  it('scopes a reset to one group', () => {
    useThemeStore.getState().setMode('dark')
    fontStores.chat.getState().setFont('source-serif')
    fontSizeStores.ui.getState().setStep(2)
    expect(changedBrowserPrefs()).toHaveLength(3)
    expect(changedBrowserPrefs('fonts')).toHaveLength(2)

    resetBrowserPrefs('fonts')

    expect(changedBrowserPrefs('fonts')).toHaveLength(0)
    expect(fontStores.chat.getState().font).toBe('merriweather')
    expect(fontSizeStores.ui.getState().step).toBe(0)
    // Not a font, so untouched.
    expect(useThemeStore.getState().mode).toBe('dark')
    expect(changedBrowserPrefs()).toHaveLength(1)
  })

  describe('describeChanged', () => {
    const p = (label: string) => ({ label, isDefault: () => false, reset: () => {} })

    it('reads as a sentence', () => {
      expect(describeChanged([p('theme')])).toBe('theme')
      expect(describeChanged([p('theme'), p('the chat font')])).toBe('theme and the chat font')
      expect(describeChanged([p('a'), p('b'), p('c')])).toBe('a, b and c')
    })

    it('counts the tail rather than listing twenty things', () => {
      expect(describeChanged([p('a'), p('b'), p('c'), p('d')])).toBe('a, b, c and 1 other')
      expect(describeChanged([p('a'), p('b'), p('c'), p('d'), p('e')])).toBe('a, b, c and 2 others')
    })
  })
})
