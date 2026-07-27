import { describe, expect, it } from 'vitest'
import { IMAGE_ICON_RE, firstGlyph, hashHue, isGlyphIcon, projectImageIconSrc } from './projectIconValue'

describe('isGlyphIcon', () => {
  it('is true for emoji, which are drawn as themselves', () => {
    expect(isGlyphIcon('🚀')).toBe(true)
    expect(isGlyphIcon('⚙️')).toBe(true)
  })

  // The case behind the letter-tile fallback: a word rendered at box size spills
  // out of the icon.
  it('is false for a word, including a name that matched no icon', () => {
    expect(isGlyphIcon('FolderDot')).toBe(false)
    expect(isGlyphIcon('hydra')).toBe(false)
  })
})

describe('firstGlyph', () => {
  it('does not slice a multi-codepoint emoji in half', () => {
    expect(firstGlyph('👩‍💻')).toBe('👩')
    expect(firstGlyph('🚀🐍')).toBe('🚀')
    expect(firstGlyph('FolderDot')).toBe('F')
    expect(firstGlyph('')).toBe('')
  })
})

describe('IMAGE_ICON_RE', () => {
  it('matches image values only', () => {
    expect(IMAGE_ICON_RE.test('logo.png')).toBe(true)
    expect(IMAGE_ICON_RE.test('https://example.com/a.SVG')).toBe(true)
    expect(IMAGE_ICON_RE.test('folder-dot')).toBe(false)
  })
})

describe('projectImageIconSrc', () => {
  it('uses a URI verbatim and routes a path through the backend', () => {
    expect(projectImageIconSrc('https://example.com/a.png', 'p')).toBe('https://example.com/a.png')
    expect(projectImageIconSrc('assets/a.png', 'my project')).toBe('/project-icon/projects/my%20project')
  })
})

describe('hashHue', () => {
  it('is deterministic and in range', () => {
    expect(hashHue('hydra')).toBe(hashHue('hydra'))
    for (const id of ['hydra', '_chat', '', 'z']) {
      expect(hashHue(id)).toBeGreaterThanOrEqual(0)
      expect(hashHue(id)).toBeLessThan(360)
    }
  })
})
