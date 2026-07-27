import { describe, expect, it } from 'vitest'
import { icons } from 'lucide-react'
import {
  EAGER_LUCIDE_ICONS,
  LUCIDE_ALIASES,
  kebabIconName,
  loadLucideIcons,
  looksLikeIconName,
  lucideIconsLoaded,
  lucideIcon,
  normalizeIconName,
} from './lucideIcons'

const normalizedLucideNames = new Set(Object.keys(icons).map(normalizeIconName))

describe('normalizeIconName', () => {
  it('collapses every spelling of a name onto one key', () => {
    const forms = ['FolderDot', 'folder-dot', 'folder_dot', 'Folder Dot', 'FOLDERDOT']
    for (const f of forms) expect(normalizeIconName(f)).toBe('folderdot')
  })

  // The whole scheme rests on this: if two lucide icons collapsed onto the same
  // key, a typed name would be ambiguous.
  it('keeps every lucide icon name distinct', () => {
    expect(normalizedLucideNames.size).toBe(Object.keys(icons).length)
  })
})

describe('kebabIconName', () => {
  it('spells a PascalCase export the way lucide.dev does', () => {
    expect(kebabIconName('FolderDot')).toBe('folder-dot')
    expect(kebabIconName('ALargeSmall')).toBe('a-large-small')
    expect(kebabIconName('Building2')).toBe('building-2')
  })

  it('round-trips through normalization for every icon', () => {
    for (const name of Object.keys(icons)) {
      expect(normalizeIconName(kebabIconName(name))).toBe(normalizeIconName(name))
    }
  })
})

describe('the eager icon set', () => {
  it('only uses real lucide names', () => {
    for (const name of Object.keys(EAGER_LUCIDE_ICONS)) {
      expect(normalizedLucideNames, `${name} is not a lucide icon`).toContain(name)
    }
  })

  // A bundled icon that disagreed with the lazily-loaded one would change glyph
  // the moment the full set arrived.
  it('agrees with the full set', () => {
    for (const [name, icon] of Object.entries(EAGER_LUCIDE_ICONS)) {
      const full = Object.entries(icons).find(([pascal]) => normalizeIconName(pascal) === name)
      expect(icon, name).toBe(full?.[1])
    }
  })
})

describe('aliases', () => {
  // Aliases are consulted after real names, so one that shadowed a real icon
  // would resolve differently before and after the full set loads.
  it('never shadow a real lucide icon', () => {
    for (const alias of Object.keys(LUCIDE_ALIASES)) {
      expect(normalizedLucideNames, `${alias} is a real lucide icon`).not.toContain(alias)
    }
  })

  it('point at real lucide icons', () => {
    for (const target of Object.values(LUCIDE_ALIASES)) {
      expect(normalizedLucideNames).toContain(target)
    }
  })
})

describe('lucideIcon', () => {
  it('resolves a bundled icon synchronously in any spelling', () => {
    expect(lucideIcon('FolderDot')).toBe(icons.FolderDot)
    expect(lucideIcon('folder-dot')).toBe(icons.FolderDot)
    expect(lucideIcon('folder dot')).toBe(icons.FolderDot)
  })

  it('resolves an alias', () => {
    expect(lucideIcon('fire')).toBe(icons.Flame)
  })

  it('returns nothing for an emoji or unknown label', () => {
    expect(lucideIcon('🚀')).toBeUndefined()
    expect(lucideIcon('')).toBeUndefined()
    expect(lucideIcon('not-an-icon-at-all')).toBeUndefined()
  })

  it('resolves a non-bundled icon once the full set loads', async () => {
    // Deliberately outside EAGER_LUCIDE_ICONS.
    expect(EAGER_LUCIDE_ICONS['popcorn']).toBeUndefined()
    expect(lucideIconsLoaded()).toBe(false)
    await loadLucideIcons()
    expect(lucideIconsLoaded()).toBe(true)
    expect(lucideIcon('popcorn')).toBe(icons.Popcorn)
    expect(lucideIcon('Popcorn')).toBe(icons.Popcorn)
    // A name-shaped value that is still unresolved after the load is settled -
    // it is not an icon, and nothing should keep waiting on it.
    expect(lucideIcon('not-an-icon-at-all')).toBeUndefined()
  })
})

describe('looksLikeIconName', () => {
  it('accepts icon-name-shaped values only', () => {
    expect(looksLikeIconName('folder-dot')).toBe(true)
    expect(looksLikeIconName('FolderDot')).toBe(true)
    expect(looksLikeIconName('🚀')).toBe(false)
    expect(looksLikeIconName('🐍 py')).toBe(false)
    expect(looksLikeIconName('icon.png')).toBe(false)
  })
})
