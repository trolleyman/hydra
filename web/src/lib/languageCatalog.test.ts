import { describe, expect, it } from 'vitest'
import { languageDisplayName, searchLanguages } from './languageCatalog'

describe('language catalog', () => {
  it('uses readable names for common grammar codenames', () => {
    expect(languageDisplayName('typescript')).toBe('TypeScript')
    expect(languageDisplayName('jsonnet')).toBe('Jsonnet')
  })

  it('searches names, codenames, aliases and extensions', () => {
    expect(searchLanguages('TypeScript').map((item) => item.id)).toContain('typescript')
    expect(searchLanguages('ts').map((item) => item.id)).toContain('typescript')
    expect(searchLanguages('.libsonnet').map((item) => item.id)).toContain('jsonnet')
    expect(searchLanguages('objc').map((item) => item.id)).toContain('objectivec')
  })
})
