import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadRichTextEditor, richTextEditorEnabled, useRichTextEditorStore } from './composerPrefs'
import { changedBrowserPrefs, resetBrowserPrefs } from './browserPrefs'
import { StorageKeys } from './storage'

describe('browser editor choice', () => {
  beforeEach(() => { localStorage.clear(); resetBrowserPrefs() })
  afterEach(() => useRichTextEditorStore.getState().setEnabled(true))

  it('persists source editing while keeping the active page choice stable', () => {
    expect(loadRichTextEditor()).toBe(true)
    const active = richTextEditorEnabled
    useRichTextEditorStore.getState().setEnabled(false)
    expect(localStorage.getItem(StorageKeys.richTextEditor)).toBe('0')
    expect(loadRichTextEditor()).toBe(false)
    expect(richTextEditorEnabled).toBe(active)
    expect(changedBrowserPrefs().map((pref) => pref.label)).toContain('rich text editor')
    resetBrowserPrefs()
    expect(useRichTextEditorStore.getState().enabled).toBe(true)
    expect(localStorage.getItem(StorageKeys.richTextEditor)).toBeNull()
  })
})
