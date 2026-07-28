// Per-role font preferences: one zustand store per role (ui / chat / code /
// terminal), the hook that publishes them to <html> as CSS variables, and the
// readers the chat pane and the terminal use.
//
// Same shape as the theme store: client-only, global (localStorage), persisted
// through singleFieldStorage so the stored value is the bare font id rather than
// a JSON envelope, and absent means "the default". The Settings control writes
// the store, the appliers react - see lib/fonts.ts for the catalogue.

import { useEffect } from 'react'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  FONT_BY_ID,
  FONT_ROLES,
  FONT_ROLE_SPEC,
  fontFeaturesFor,
  fontStackFor,
  isValidFontFor,
  type FontRole,
} from './fonts'
import { StorageKeys, readLocal, writeLocal, singleFieldStorage } from './storage'

const KEY: Record<FontRole, string> = {
  ui: StorageKeys.fontUi,
  chat: StorageKeys.fontChat,
  code: StorageKeys.fontCode,
  terminal: StorageKeys.fontTerminal,
}

// Reads one role's stored font id, defaulting to the role's own default.
// Exported for non-React callers / unit testing.
export function loadFont(role: FontRole): string {
  const stored = readLocal(KEY[role])
  if (isValidFontFor(role, stored)) return stored as string
  // Chat inherited the old boolean serif/sans toggle. Its key held the bare
  // marker 'sans' (written only when serif was turned OFF), so an existing
  // browser that opted out of serif keeps a sans chat font instead of being
  // silently put back on Merriweather. Any write through this module clears the
  // legacy key, so this fallback only ever fires once per browser.
  if (role === 'chat' && readLocal(StorageKeys.chatSerif) === 'sans') return 'system-sans'
  return FONT_ROLE_SPEC[role].defaultId
}

function writeFont(role: FontRole, id: string) {
  // Absent = the default, so the key stays out of localStorage for anyone who
  // never touched the control - the convention every other client pref follows.
  writeLocal(KEY[role], id === FONT_ROLE_SPEC[role].defaultId ? null : id)
  // Retire the pre-selector chat toggle on the first deliberate choice.
  // Otherwise picking the default back would clear the new key and let the
  // legacy fallback above resurrect the old value.
  if (role === 'chat') writeLocal(StorageKeys.chatSerif, null)
}

interface FontState {
  font: string
  setFont: (font: string) => void
}

function createFontStore(role: FontRole): UseBoundStore<StoreApi<FontState>> {
  return create<FontState>()(
    persist(
      (set) => ({
        font: loadFont(role),
        setFont: (font) => set({ font }),
      }),
      {
        name: KEY[role],
        storage: singleFieldStorage('font', () => loadFont(role), (font) => writeFont(role, font)),
        partialize: (s) => ({ font: s.font }),
      },
    ),
  )
}

export const fontStores: Record<FontRole, UseBoundStore<StoreApi<FontState>>> = {
  ui: createFontStore('ui'),
  chat: createFontStore('chat'),
  code: createFontStore('code'),
  terminal: createFontStore('terminal'),
}

// Current choice + setter for one role, for the Settings control.
export function useFontChoice(role: FontRole): [string, (id: string) => void] {
  const font = fontStores[role]((s) => s.font)
  const setFont = fontStores[role]((s) => s.setFont)
  return [font, setFont]
}

// The resolved CSS font-family value for a role, and its font-feature-settings.
// For consumers that need real strings rather than CSS variables - xterm's
// fontFamily option, canvas measuring - since those never see the cascade.
export function useFontStack(role: FontRole): string {
  const font = fontStores[role]((s) => s.font)
  return fontStackFor(role, font)
}

export function useFontFeatures(role: FontRole): string {
  const font = fontStores[role]((s) => s.font)
  return fontFeaturesFor(role, font)
}

// Whether the chat font is a serif. The chat pane still switches leading, size
// and bold weight on this (`.chat-serif` vs `.chat-leading` in index.css) - a
// serif reads better a little larger and looser, which is exactly what the old
// serif/sans toggle set. The family itself now comes from --app-font-chat.
export function useChatIsSerif(): boolean {
  const font = fontStores.chat((s) => s.font)
  return FONT_BY_ID.get(font)?.category === 'serif'
}

// Publishes every role's stack - and its font-feature-settings, on a matching
// `-features` variable - to <html>. index.css maps Tailwind's --font-sans /
// --font-mono onto the ui / code variables and gives each one a system fallback,
// so the app renders correctly in the frames before this runs and would still
// render if it never did.
//
// Features are per-role rather than one global rule because the tags are not
// portable: Iosevka's cv10 is a dotted zero, and another family's cv10 is
// something else entirely. Only the font that asked for a tag gets it.
//
// Mount once at the app root (alongside useApplyTheme).
export function useApplyFonts() {
  const ui = fontStores.ui((s) => s.font)
  const chat = fontStores.chat((s) => s.font)
  const code = fontStores.code((s) => s.font)
  const terminal = fontStores.terminal((s) => s.font)
  useEffect(() => {
    const chosen: Record<FontRole, string> = { ui, chat, code, terminal }
    const style = document.documentElement.style
    for (const role of FONT_ROLES) {
      const { cssVar } = FONT_ROLE_SPEC[role]
      style.setProperty(cssVar, fontStackFor(role, chosen[role]))
      style.setProperty(`${cssVar}-features`, fontFeaturesFor(role, chosen[role]))
    }
  }, [ui, chat, code, terminal])
}
