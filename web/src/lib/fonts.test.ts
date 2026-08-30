import { describe, it, expect, beforeEach } from 'vitest'
import {
  FONT_BASE_PX,
  FONT_BY_ID,
  FONT_OPTIONS,
  FONT_ROLES,
  FONT_ROLE_SPEC,
  FONT_SIZE_ROLES,
  MAX_FONT_STEP,
  MIN_FONT_STEP,
  SYSTEM_MONO,
  SYSTEM_SANS,
  SYSTEM_SERIF,
  clampFontStep,
  fontFeaturesFor,
  fontOptionsFor,
  fontSizePx,
  fontStackFor,
  UI_MAX_FONT_STEP,
  isValidFontFor,
} from './fonts'
import { loadFont, loadFontSize } from './fontPrefs'
import { StorageKeys } from './storage'

describe('font catalogue', () => {
  it('has unique ids', () => {
    expect(new Set(FONT_OPTIONS.map((f) => f.id)).size).toBe(FONT_OPTIONS.length)
  })

  // Every stack must end in the system fallback for its category, so a font that
  // fails to load (offline, blocked CDN) lands where the app rendered before the
  // selector existed rather than on the browser's last-resort default.
  it('falls back to the system stack of its own category', () => {
    const tail = { sans: SYSTEM_SANS, serif: SYSTEM_SERIF, mono: SYSTEM_MONO }
    for (const font of FONT_OPTIONS) expect(font.stack.endsWith(tail[font.category])).toBe(true)
  })

  // The mono roles are grids: a proportional arrows face in front of them would
  // put an arrow out of its cell.
  it('only puts the arrows face in front of serif stacks', () => {
    for (const font of FONT_OPTIONS) {
      expect(font.stack.startsWith("'Hydra Arrows'")).toBe(font.category === 'serif')
    }
  })

  it('gives every role a default it is actually allowed to use', () => {
    for (const role of FONT_ROLES) {
      const spec = FONT_ROLE_SPEC[role]
      expect(isValidFontFor(role, spec.defaultId)).toBe(true)
      expect(fontOptionsFor(role).map((o) => o.id)).toContain(spec.defaultId)
    }
  })

  it('offers each role only its own categories', () => {
    for (const role of FONT_ROLES) {
      const cats = new Set(fontOptionsFor(role).map((o) => o.category))
      expect([...cats].sort()).toEqual([...FONT_ROLE_SPEC[role].categories].sort())
    }
  })

  // The tags are private to Iosevka. Turning them on for a family that happens to
  // define the same tag differently (Fira Code also has cvNN) would silently
  // swap glyphs nobody asked to change.
  it('only carries OpenType features on the fonts that asked for them', () => {
    const withFeatures = FONT_OPTIONS.filter((f) => f.features).map((f) => f.id)
    expect(withFeatures).toEqual(['iosevka'])
    for (const id of withFeatures) {
      expect(FONT_BY_ID.get(id)!.features).toBe("'calt' 1, 'VLAC' 2, 'VSAB' 3, 'cv10' 6")
    }
  })

  it('reports `normal` features for a font that sets none', () => {
    expect(fontFeaturesFor('code', 'fira-code')).toBe('normal')
    expect(fontFeaturesFor('terminal', 'iosevka')).toBe(FONT_BY_ID.get('iosevka')!.features)
    // ...including when the id is rejected and the role default steps in.
    expect(fontFeaturesFor('ui', 'iosevka')).toBe('normal')
  })

  // A terminal is where emoji actually turn up, and no monospace family draws
  // them - without an explicit tail the browser's last-resort pick on Linux is
  // often nothing at all.
  it('ends every mono stack with an emoji fallback', () => {
    for (const font of FONT_OPTIONS.filter((f) => f.category === 'mono')) {
      expect(font.stack).toContain("'Noto Color Emoji'")
    }
  })

  // Without the fallback face, every Powerline separator and Devicon an agent
  // prints is a tofu box. The size-adjusted variant has to match the family's
  // own cell, or the symbols push the line and break column alignment.
  it('gives every mono stack the Nerd Fonts fallback, cut to its own cell', () => {
    for (const font of FONT_OPTIONS.filter((f) => f.category === 'mono')) {
      const narrow = font.id.startsWith('iosevka')
      expect(font.stack).toContain(`'Hydra Nerd Symbols ${narrow ? 50 : 60}'`)
      expect(font.stack).not.toContain(`'Hydra Nerd Symbols ${narrow ? 60 : 50}'`)
      // After the real family, so a letter it does cover still wins.
      if (font.id !== 'system-mono') {
        expect(font.stack.indexOf('Hydra Nerd Symbols')).toBeGreaterThan(font.stack.indexOf(font.label))
      }
    }
  })

  it('keeps the Nerd Fonts fallback out of the proportional stacks', () => {
    for (const font of FONT_OPTIONS.filter((f) => f.category !== 'mono')) {
      expect(font.stack).not.toContain('Hydra Nerd Symbols')
    }
  })

  it('resolves an unknown or wrong-category id to the role default', () => {
    expect(fontStackFor('code', 'no-such-font')).toBe(FONT_BY_ID.get('fira-code')!.stack)
    // A mono font is a perfectly real font, just not one the chat role offers.
    expect(fontStackFor('chat', 'iosevka')).toBe(FONT_BY_ID.get('merriweather')!.stack)
    expect(fontStackFor('chat', 'inter')).toBe(FONT_BY_ID.get('inter')!.stack)
  })
})

describe('loadFont', () => {
  beforeEach(() => localStorage.clear())

  it('defaults each role when nothing is stored', () => {
    for (const role of FONT_ROLES) expect(loadFont(role)).toBe(FONT_ROLE_SPEC[role].defaultId)
  })

  it('reads a stored id back', () => {
    localStorage.setItem(StorageKeys.fontCode, 'fira-code')
    expect(loadFont('code')).toBe('fira-code')
  })

  it('migrates the old Iosevka Term choice to Iosevka', () => {
    localStorage.setItem(StorageKeys.fontTerminal, 'iosevka-term')
    expect(loadFont('terminal')).toBe('iosevka')
    expect(localStorage.getItem(StorageKeys.fontTerminal)).toBe('iosevka')
  })

  it('ignores a stored id the role does not offer', () => {
    localStorage.setItem(StorageKeys.fontUi, 'iosevka')
    expect(loadFont('ui')).toBe('inter')
  })

  // The pre-selector chat toggle wrote 'sans' only when serif was turned OFF, so
  // a browser carrying that marker must not be silently put back on a serif.
  it('honours the legacy chat serif marker', () => {
    localStorage.setItem(StorageKeys.chatSerif, 'sans')
    expect(loadFont('chat')).toBe('system-sans')
  })

  it('lets an explicit chat choice win over the legacy marker', () => {
    localStorage.setItem(StorageKeys.chatSerif, 'sans')
    localStorage.setItem(StorageKeys.fontChat, 'source-serif')
    expect(loadFont('chat')).toBe('source-serif')
  })

  it('leaves the other roles alone when only the legacy marker is set', () => {
    localStorage.setItem(StorageKeys.chatSerif, 'sans')
    expect(loadFont('ui')).toBe(FONT_ROLE_SPEC.ui.defaultId)
    expect(loadFont('code')).toBe(FONT_ROLE_SPEC.code.defaultId)
    expect(loadFont('terminal')).toBe(FONT_ROLE_SPEC.terminal.defaultId)
  })
})

describe('font size', () => {
  it('offers a size for every role', () => {
    expect(FONT_SIZE_ROLES).toEqual(['ui', 'chat', 'code', 'terminal'])
  })

  // Interface type grows inside rows whose heights are fixed in px (h-7/h-8), so
  // it stops a step short of the roles that own their own line box.
  it('caps the interface step below the others', () => {
    expect(UI_MAX_FONT_STEP).toBeLessThan(MAX_FONT_STEP)
    expect(clampFontStep(99, 'ui')).toBe(UI_MAX_FONT_STEP)
    expect(clampFontStep(99, 'chat')).toBe(MAX_FONT_STEP)
    expect(fontSizePx('ui', 99)).toBe(FONT_BASE_PX.ui + UI_MAX_FONT_STEP)
    // The floor is shared.
    expect(clampFontStep(-99, 'ui')).toBe(MIN_FONT_STEP)
  })

  it('clamps a step to the offered range and rounds it to whole pixels', () => {
    expect(clampFontStep(MAX_FONT_STEP + 5)).toBe(MAX_FONT_STEP)
    expect(clampFontStep(MIN_FONT_STEP - 5)).toBe(MIN_FONT_STEP)
    // Whole pixels: a fractional line box is what makes streaming chat jiggle.
    expect(clampFontStep(1.4)).toBe(1)
    expect(clampFontStep(NaN)).toBe(0)
  })

  // The step is an offset, so the default must land on the size the surface
  // already rendered at - that is what makes an untouched build byte-identical.
  it('resolves step 0 to each role built-in size', () => {
    expect(fontSizePx('code', 0)).toBe(FONT_BASE_PX.code)
    expect(fontSizePx('terminal', 0)).toBe(FONT_BASE_PX.terminal)
    expect(fontSizePx('chat', 0, 'system-sans')).toBe(FONT_BASE_PX.chat)
  })

  // A serif chat font renders a pixel larger than a sans one (.chat-serif), and
  // the stepper shows the size the prose will be - so it has to carry that.
  it('adds the serif chat pixel, at every step', () => {
    expect(fontSizePx('chat', 0, 'merriweather')).toBe(FONT_BASE_PX.chat + 1)
    expect(fontSizePx('chat', 2, 'merriweather')).toBe(FONT_BASE_PX.chat + 3)
    expect(fontSizePx('chat', 2, 'inter')).toBe(FONT_BASE_PX.chat + 2)
    // Only chat: the mono roles have no serif/sans split to honour.
    expect(fontSizePx('code', 1, 'merriweather')).toBe(FONT_BASE_PX.code + 1)
  })

  it('steps by whole pixels from the base', () => {
    expect(fontSizePx('code', MIN_FONT_STEP)).toBe(FONT_BASE_PX.code + MIN_FONT_STEP)
    expect(fontSizePx('code', MAX_FONT_STEP)).toBe(FONT_BASE_PX.code + MAX_FONT_STEP)
    expect(fontSizePx('terminal', 99)).toBe(FONT_BASE_PX.terminal + MAX_FONT_STEP)
  })
})

describe('loadFontSize', () => {
  beforeEach(() => localStorage.clear())

  it('defaults every sized role to no offset', () => {
    for (const role of FONT_SIZE_ROLES) expect(loadFontSize(role)).toBe(0)
  })

  it('reads a stored step back, including a negative one', () => {
    localStorage.setItem(StorageKeys.fontSizeCode, '2')
    localStorage.setItem(StorageKeys.fontSizeChat, '-1')
    expect(loadFontSize('code')).toBe(2)
    expect(loadFontSize('chat')).toBe(-1)
  })

  // A hand-edited key, or one written by a build with a wider range, must not
  // throw the surface to an unreadable size.
  it('clamps or ignores a stored step it cannot use', () => {
    localStorage.setItem(StorageKeys.fontSizeTerminal, '400')
    expect(loadFontSize('terminal')).toBe(MAX_FONT_STEP)
    localStorage.setItem(StorageKeys.fontSizeTerminal, 'huge')
    expect(loadFontSize('terminal')).toBe(0)
    localStorage.setItem(StorageKeys.fontSizeTerminal, '')
    expect(loadFontSize('terminal')).toBe(0)
  })
})
