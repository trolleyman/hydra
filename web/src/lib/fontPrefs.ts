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
  FONT_SIZE_ROLES,
  clampFontStep,
  fontFeaturesFor,
  fontSizePx,
  fontStackFor,
  isValidFontFor,
  type FontRole,
  type FontSizeRole,
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
  let stored = readLocal(KEY[role])
  // Iosevka and Iosevka Term were consolidated into the patched terminal-safe
  // face. Preserve either old role choice under the new single catalogue id.
  if ((role === 'code' || role === 'terminal') && stored === 'iosevka-term') {
    stored = 'iosevka'
    writeLocal(KEY[role], stored)
  }
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

const SIZE_KEY: Record<FontSizeRole, string> = {
  ui: StorageKeys.fontSizeUi,
  chat: StorageKeys.fontSizeChat,
  code: StorageKeys.fontSizeCode,
  terminal: StorageKeys.fontSizeTerminal,
}

// Reads one role's stored size step, clamped to the offered range. Anything
// unparseable (a hand-edited key, a value from a build with a wider range) reads
// as 0 rather than throwing the surface to an absurd size.
export function loadFontSize(role: FontSizeRole): number {
  const stored = readLocal(SIZE_KEY[role])
  if (stored === null || stored === '') return 0
  const n = Number(stored)
  return Number.isFinite(n) ? clampFontStep(n, role) : 0
}

function writeFontSize(role: FontSizeRole, step: number) {
  // Absent = the built-in size, same convention as the family keys above.
  writeLocal(SIZE_KEY[role], step === 0 ? null : String(step))
}

interface FontState {
  font: string
  setFont: (font: string) => void
}

interface FontSizeState {
  step: number
  setStep: (step: number) => void
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

function createFontSizeStore(role: FontSizeRole): UseBoundStore<StoreApi<FontSizeState>> {
  return create<FontSizeState>()(
    persist(
      (set) => ({
        step: loadFontSize(role),
        setStep: (step) => set({ step: clampFontStep(step, role) }),
      }),
      {
        name: SIZE_KEY[role],
        storage: singleFieldStorage(
          'step',
          () => loadFontSize(role),
          (step) => writeFontSize(role, step),
        ),
        partialize: (s) => ({ step: s.step }),
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

export const fontSizeStores: Record<FontSizeRole, UseBoundStore<StoreApi<FontSizeState>>> = {
  ui: createFontSizeStore('ui'),
  chat: createFontSizeStore('chat'),
  code: createFontSizeStore('code'),
  terminal: createFontSizeStore('terminal'),
}

// Current choice + setter for one role, for the Settings control.
export function useFontChoice(role: FontRole): [string, (id: string) => void] {
  const font = fontStores[role]((s) => s.font)
  const setFont = fontStores[role]((s) => s.setFont)
  return [font, setFont]
}

// Current size step + setter for one role, for the Settings stepper.
export function useFontSizeStep(role: FontSizeRole): [number, (step: number) => void] {
  const step = fontSizeStores[role]((s) => s.step)
  const setStep = fontSizeStores[role]((s) => s.setStep)
  return [step, setStep]
}

// The px a role's text lands on, for consumers that need a real number rather
// than a CSS variable - xterm's fontSize option, the Settings samples - and as a
// re-measure trigger for anything whose layout depends on the size.
export function useFontSizePx(role: FontSizeRole): number {
  const step = fontSizeStores[role]((s) => s.step)
  const font = fontStores[role]((s) => s.font)
  return fontSizePx(role, step, font)
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
  const uiStep = fontSizeStores.ui((s) => s.step)
  const chatStep = fontSizeStores.chat((s) => s.step)
  const codeStep = fontSizeStores.code((s) => s.step)
  const terminalStep = fontSizeStores.terminal((s) => s.step)
  useEffect(() => {
    const chosen: Record<FontRole, string> = { ui, chat, code, terminal }
    const style = document.documentElement.style
    for (const role of FONT_ROLES) {
      const { cssVar } = FONT_ROLE_SPEC[role]
      style.setProperty(cssVar, fontStackFor(role, chosen[role]))
      style.setProperty(`${cssVar}-features`, fontFeaturesFor(role, chosen[role]))
    }
    // The size rides a `-step` variable holding a signed px LENGTH ('2px',
    // '-1px'), not the resolved size, because every surface adds it to a
    // different built-in number: a diff row is 12px, chat prose 13px, its mono
    // runs a fractional em of that. Each does `calc(<its own size> + step)`, so
    // one variable moves a whole family of sizes and each keeps its own
    // relationship to the others - and at 0px every calc lands exactly where it
    // did before the control existed. The terminal has no CSS surface (xterm
    // takes a number, see AgentTerminal), so it is published for completeness
    // and read through useFontSizePx.
    //
    // Interface is the one whose variable is read by a scale rather than by a
    // surface: every rung of the shell's type ladder in index.css is a
    // `calc(<its own px> + var(--app-font-ui-step))`, so one step moves all of
    // them and each rung keeps its distance from its neighbours. Type only -
    // padding, gaps and row heights are rem/px and stay put, which is what keeps
    // this from being browser zoom (and why the Interface step is capped one
    // lower than the rest - see UI_MAX_FONT_STEP in lib/fonts).
    const steps: Record<FontSizeRole, number> = { ui: uiStep, chat: chatStep, code: codeStep, terminal: terminalStep }
    for (const role of FONT_SIZE_ROLES) {
      style.setProperty(`${FONT_ROLE_SPEC[role].cssVar}-step`, `${clampFontStep(steps[role], role)}px`)
    }
  }, [ui, chat, code, terminal, uiStep, chatStep, codeStep, terminalStep])
}
