import { describe, it, expect } from 'vitest'
import {
  effectiveChangeType,
  parseScopedTag,
  fileMediaType,
  collectTags,
  filterIsActive,
  fileMatchesFilter,
  searchFiles,
  computeVisibleFiles,
  computeScopeCounts,
  TYPE_CATEGORY,
  type FilterableArtifact,
} from './artifactFilter'
import { ARTIFACT_CHANGE_CATEGORY, type ArtifactTagFilter } from './artifactPrefs'

// Build an ArtifactTagFilter from a partial - the "empty" filter (nothing hidden)
// is the inactive baseline. Note the real default filter hides 'unchanged', but
// these tests construct explicit filters so the scoped/free semantics are isolated.
function mkFilter(overrides: Partial<ArtifactTagFilter> = {}): ArtifactTagFilter {
  return { scoped: {}, free: [], ...overrides }
}

function file(name: string, tags?: string[], extra?: Partial<FilterableArtifact>): FilterableArtifact {
  return { name, tags, ...extra }
}

describe('parseScopedTag', () => {
  it('splits a category::value tag into its halves', () => {
    expect(parseScopedTag('theme::dark')).toEqual({ cat: 'theme', val: 'dark' })
  })

  it('returns null for a plain (free-form) tag', () => {
    expect(parseScopedTag('important')).toBeNull()
  })

  it('returns null when either half is empty', () => {
    expect(parseScopedTag('::dark')).toBeNull()
    expect(parseScopedTag('theme::')).toBeNull()
  })

  it('splits on the first :: only, keeping later :: in the value', () => {
    expect(parseScopedTag('a::b::c')).toEqual({ cat: 'a', val: 'b::c' })
  })
})

describe('fileMediaType', () => {
  it('classifies .webm as video and everything else as image', () => {
    expect(fileMediaType(file('clip.webm'))).toBe('video')
    expect(fileMediaType(file('shot.png'))).toBe('image')
    expect(fileMediaType(file('anim.webp'))).toBe('image')
  })
})

describe('effectiveChangeType', () => {
  it('is a no-op with threshold 0', () => {
    expect(effectiveChangeType(file('a.png', [], { change_type: 'modified', change_ratio: 0.001 }), 0)).toBe('modified')
  })

  it('downgrades modified to unchanged when the changed fraction is below the threshold', () => {
    // 2% of pixels changed, gate at 5% → does not count as a change.
    expect(effectiveChangeType(file('a.png', [], { change_type: 'modified', change_ratio: 0.02 }), 5)).toBe('unchanged')
  })

  it('keeps modified when the changed fraction meets the threshold', () => {
    expect(effectiveChangeType(file('a.png', [], { change_type: 'modified', change_ratio: 0.1 }), 5)).toBe('modified')
  })

  it('leaves modified files with no change_ratio alone', () => {
    expect(effectiveChangeType(file('a.png', [], { change_type: 'modified', change_ratio: null }), 5)).toBe('modified')
  })

  it('never touches non-modified change types, or files with no change_type', () => {
    expect(effectiveChangeType(file('a.png', [], { change_type: 'added', change_ratio: 0 }), 90)).toBe('added')
    expect(effectiveChangeType(file('a.png'), 90)).toBe('')
  })
})

describe('collectTags', () => {
  it('groups scoped tags by category with sorted distinct values and sorts free tags', () => {
    const files = [
      file('a', ['theme::dark', 'flagged']),
      file('b', ['theme::light', 'theme::dark', 'flagged', 'urgent']),
    ]
    expect(collectTags(files)).toEqual({
      scoped: [{ cat: 'theme', values: ['dark', 'light'] }],
      free: ['flagged', 'urgent'],
    })
  })

  it('ignores the reserved built-in type/change scopes', () => {
    const files = [file('a', [`${TYPE_CATEGORY}::video`, `${ARTIFACT_CHANGE_CATEGORY}::added`, 'real::x'])]
    expect(collectTags(files)).toEqual({
      scoped: [{ cat: 'real', values: ['x'] }],
      free: [],
    })
  })

  it('folds in pending tags from the still-generating side', () => {
    const result = collectTags([file('a', ['theme::dark'])], ['theme::light', 'pendingFree'])
    expect(result.scoped).toEqual([{ cat: 'theme', values: ['dark', 'light'] }])
    expect(result.free).toEqual(['pendingFree'])
  })
})

describe('filterIsActive', () => {
  it('is false for an empty filter', () => {
    expect(filterIsActive(mkFilter())).toBe(false)
    expect(filterIsActive(mkFilter({ scoped: { theme: [] } }))).toBe(false)
  })

  it('is true when a scoped value, a free tag, or a positive threshold is set', () => {
    expect(filterIsActive(mkFilter({ scoped: { theme: ['dark'] } }))).toBe(true)
    expect(filterIsActive(mkFilter({ free: ['flagged'] }))).toBe(true)
    expect(filterIsActive(mkFilter({ changeThreshold: 10 }))).toBe(true)
  })
})

describe('fileMatchesFilter - scoped tags', () => {
  // The filter records the values turned OFF for a category. "Selecting" theme=dark
  // in the UI means turning the other values off; here we exercise that OFF-list.
  const dark = file('dark.png', ['theme::dark'])
  const light = file('light.png', ['theme::light'])
  const untagged = file('plain.png', [])

  it('drops a file whose value for the category is hidden, keeps the others', () => {
    const f = mkFilter({ scoped: { theme: ['light'] } })
    expect(fileMatchesFilter(dark, f)).toBe(true)
    expect(fileMatchesFilter(light, f)).toBe(false)
    // A file lacking the category carries none of the hidden values → unaffected.
    expect(fileMatchesFilter(untagged, f)).toBe(true)
  })

  it('replaces (does not union) within a category when the hidden value changes', () => {
    const hideLight = mkFilter({ scoped: { theme: ['light'] } })
    const hideDark = mkFilter({ scoped: { theme: ['dark'] } })
    // hiding light keeps dark; switching to hide dark keeps light - the surviving
    // set flips entirely, it does not accumulate.
    expect([fileMatchesFilter(dark, hideLight), fileMatchesFilter(light, hideLight)]).toEqual([true, false])
    expect([fileMatchesFilter(dark, hideDark), fileMatchesFilter(light, hideDark)]).toEqual([false, true])
  })
})

describe('fileMatchesFilter - free tags', () => {
  it('drops a file only when every free tag it carries is hidden', () => {
    const onlyHidden = file('a.png', ['flagged'])
    const mixed = file('b.png', ['flagged', 'keep'])
    const untagged = file('c.png', [])
    const f = mkFilter({ free: ['flagged'] })
    expect(fileMatchesFilter(onlyHidden, f)).toBe(false)
    expect(fileMatchesFilter(mixed, f)).toBe(true)
    expect(fileMatchesFilter(untagged, f)).toBe(true)
  })
})

describe('fileMatchesFilter - built-in type and change scopes', () => {
  it('drops by intrinsic media type for the reserved type scope', () => {
    const f = mkFilter({ scoped: { [TYPE_CATEGORY]: ['video'] } })
    expect(fileMatchesFilter(file('clip.webm'), f)).toBe(false)
    expect(fileMatchesFilter(file('shot.png'), f)).toBe(true)
  })

  it('drops by change_type for the reserved change scope, respecting the threshold', () => {
    const f = mkFilter({ scoped: { [ARTIFACT_CHANGE_CATEGORY]: ['unchanged'] } })
    expect(fileMatchesFilter(file('a.png', [], { change_type: 'unchanged' }), f)).toBe(false)
    expect(fileMatchesFilter(file('b.png', [], { change_type: 'added' }), f)).toBe(true)
    // A 1% modified file downgraded to 'unchanged' by the threshold is then hidden.
    const gated = mkFilter({ scoped: { [ARTIFACT_CHANGE_CATEGORY]: ['unchanged'] }, changeThreshold: 5 })
    expect(fileMatchesFilter(file('c.png', [], { change_type: 'modified', change_ratio: 0.01 }), gated)).toBe(false)
  })
})

describe('searchFiles', () => {
  const files = [
    file('alpha.png', ['theme::dark']),
    file('beta.png', ['theme::light']),
    file('gamma.webm', ['theme::dark']),
  ]

  it('returns the list unchanged for an empty/blank query', () => {
    expect(searchFiles(files, '')).toBe(files)
    expect(searchFiles(files, '   ')).toBe(files)
  })

  it('narrows by filename', () => {
    expect(searchFiles(files, 'beta').map((f) => f.name)).toEqual(['beta.png'])
  })

  it('also matches against a file tag, not just the name', () => {
    expect(searchFiles(files, 'dark').map((f) => f.name).sort()).toEqual(['alpha.png', 'gamma.webm'])
  })

  it('returns empty when nothing matches', () => {
    expect(searchFiles(files, 'zzzzz')).toEqual([])
  })

  it('requires every whitespace-separated word to match', () => {
    // "alpha" matches the name but "zzzzz" matches nothing → excluded.
    expect(searchFiles(files, 'alpha zzzzz')).toEqual([])
  })
})

describe('computeVisibleFiles', () => {
  const files = [
    file('alpha.png', ['theme::dark']),
    file('beta.png', ['theme::light']),
    file('gamma.webm', ['theme::dark']),
  ]

  it('returns everything with no active filter and no search', () => {
    expect(computeVisibleFiles(files, mkFilter(), '')).toBe(files)
  })

  it('applies only the tag filter when there is no search', () => {
    const f = mkFilter({ scoped: { theme: ['light'] } })
    expect(computeVisibleFiles(files, f, '').map((x) => x.name).sort()).toEqual(['alpha.png', 'gamma.webm'])
  })

  it('ANDs the tag filter and the search query', () => {
    const f = mkFilter({ scoped: { theme: ['light'] } }) // keeps alpha + gamma
    // search 'alpha' then narrows the survivors to just alpha.
    expect(computeVisibleFiles(files, f, 'alpha').map((x) => x.name)).toEqual(['alpha.png'])
    // gamma survives the filter but is excluded by the search → not shown.
    expect(computeVisibleFiles(files, f, 'gamma').map((x) => x.name)).toEqual(['gamma.webm'])
  })

  it('returns empty when the filter hides every file', () => {
    const f = mkFilter({ scoped: { theme: ['dark', 'light'] } })
    expect(computeVisibleFiles(files, f, '')).toEqual([])
  })
})

describe('computeScopeCounts', () => {
  it('tallies how many shown files carry each value, ignoring this scope itself', () => {
    const files = [
      file('a.png', ['theme::dark', 'flagged']),
      file('b.png', ['theme::light', 'flagged']),
      file('c.png', ['theme::dark']),
    ]
    const hasValue = (f: FilterableArtifact, v: string) => (f.tags ?? []).includes(`theme::${v}`)
    // 'flagged' is hidden, so b/a... a and b both carry flagged → both dropped,
    // leaving only c, which is theme::dark.
    const counts = computeScopeCounts(files, ['dark', 'light'], hasValue, mkFilter({ free: ['flagged'] }))
    expect(counts).toEqual({ dark: 1, light: 0 })
  })

  it('counts all files when the shown-filter is inactive', () => {
    const files = [file('a.png', ['theme::dark']), file('b.png', ['theme::light']), file('c.png', ['theme::dark'])]
    const hasValue = (f: FilterableArtifact, v: string) => (f.tags ?? []).includes(`theme::${v}`)
    expect(computeScopeCounts(files, ['dark', 'light'], hasValue, mkFilter())).toEqual({ dark: 2, light: 1 })
  })
})
