import { describe, it, expect } from 'vitest'
import { ReviewImageAnchor } from '../api'
import {
  anchorPositionLabel, anchorVersionLabel, artifactBlobUrl, artifactRefFromUrl, buildImageAnchor,
  formatTimecode, sameArtifactPicture, sideOfUrl,
} from './artifactAnchor'

const BLOB = '/api/projects/p1/artifacts/blob?script=screenshots&key=commit%2Fabc1234def0567&file=home-dark.png'

describe('artifactRefFromUrl', () => {
  it('recovers the triple that addresses an artifact blob', () => {
    expect(artifactRefFromUrl(BLOB)).toEqual({
      script: 'screenshots',
      key: 'commit/abc1234def0567',
      file: 'home-dark.png',
    })
  })

  // Everything that is NOT an artifact has no identity to pin a comment to, and
  // must fail closed rather than produce a half-filled anchor: a comment stored
  // against a missing script/key could never be resolved back to a picture.
  it.each([
    ['a data URL', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['an upload', '/api/projects/p1/uploads/blob?name=1699-shot.png'],
    ['an agent file', '/api/projects/p1/agents/a1/files/blob?path=%2Ftmp%2Fx.png'],
    ['a blob URL missing the file', '/api/projects/p1/artifacts/blob?script=s&key=commit%2Fa'],
    ['nothing at all', ''],
  ])('returns null for %s', (_label, url) => {
    expect(artifactRefFromUrl(url)).toBeNull()
  })

  it('returns null rather than throwing on a malformed URL', () => {
    expect(artifactRefFromUrl('ht!tp://[[[')).toBeNull()
  })
})

describe('buildImageAnchor', () => {
  it('carries the natural size through, so the pin can be read back in pixels', () => {
    const a = buildImageAnchor({ url: BLOB, x: 0.34, y: 0.71, natural: { w: 1512, h: 982 } })
    expect(a).toMatchObject({ script: 'screenshots', file: 'home-dark.png', x: 0.34, y: 0.71, natural_w: 1512, natural_h: 982 })
    expect(anchorPositionLabel(a!)).toBe('514,697 px')
  })

  // A guessed size would produce confidently wrong coordinates, which is worse
  // than none: the percentage is still true.
  it('omits the natural size when it is unknown, and says so in percentages', () => {
    const a = buildImageAnchor({ url: BLOB, x: 0.5, y: 0.25, natural: null })!
    expect(a.natural_w).toBeUndefined()
    expect(anchorPositionLabel(a)).toBe('50%,25%')
  })

  it('records a box only when it has both dimensions', () => {
    expect(buildImageAnchor({ url: BLOB, x: 0.1, y: 0.1, w: 0.2, h: 0.3 })).toMatchObject({ w: 0.2, h: 0.3 })
    expect(buildImageAnchor({ url: BLOB, x: 0.1, y: 0.1, w: 0.2 })!.w).toBeUndefined()
  })

  // The server refuses an out-of-range pin, so clamping here means a rounding
  // slip at the very edge of a picture is not a failed comment.
  it('clamps a position to the picture', () => {
    const a = buildImageAnchor({ url: BLOB, x: 1.4, y: -0.2 })!
    expect(a.x).toBe(1)
    expect(a.y).toBe(0)
  })

  it('is null for a picture with no artifact identity', () => {
    expect(buildImageAnchor({ url: 'data:image/png;base64,AAAA', x: 0.5, y: 0.5 })).toBeNull()
  })
})

describe('sideOfUrl', () => {
  it('names the side a URL is', () => {
    expect(sideOfUrl('R', 'L', 'R')).toBe(ReviewImageAnchor.side.RIGHT)
    expect(sideOfUrl('L', 'L', 'R')).toBe(ReviewImageAnchor.side.LEFT)
  })

  // A single-sided picture (the repository view) has no side, and claiming one
  // would be a fiction that later filters a pin out of its own picture.
  it('is undefined when the picture is not part of a comparison', () => {
    expect(sideOfUrl('X', null, null)).toBeUndefined()
  })
})

describe('sameArtifactPicture', () => {
  const ref = { script: 'screenshots', key: 'commit/abc', file: 'home.png' }
  const at = (o: Partial<ReviewImageAnchor>): ReviewImageAnchor =>
    ({ file: 'home.png', script: 'screenshots', key: 'commit/abc', x: 0, y: 0, ...o })

  it('matches the same file of the same script at the same version', () => {
    expect(sameArtifactPicture(at({}), ref)).toBe(true)
  })

  // The key is what dates the picture. A pin placed on last commit's render is
  // not about the pixels showing now, so it must not be drawn over them.
  it('does not match a different version of the same file', () => {
    expect(sameArtifactPicture(at({ key: 'commit/def' }), ref)).toBe(false)
    expect(sameArtifactPicture(at({ key: 'worktree/9f3a' }), ref)).toBe(false)
  })

  it('does not match a different file or script', () => {
    expect(sameArtifactPicture(at({ file: 'login.png' }), ref)).toBe(false)
    expect(sameArtifactPicture(at({ script: 'other' }), ref)).toBe(false)
  })

  // A remark left on "before" is about the before pixels; drawing it over
  // "after" would point it at something it was never about.
  it('keeps the sides apart', () => {
    expect(sameArtifactPicture(at({ side: ReviewImageAnchor.side.LEFT }), ref, ReviewImageAnchor.side.RIGHT)).toBe(false)
    expect(sameArtifactPicture(at({ side: ReviewImageAnchor.side.RIGHT }), ref, ReviewImageAnchor.side.RIGHT)).toBe(true)
  })

  // A pin with no side recorded is shown rather than hidden: the alternative is
  // a comment nobody can find again.
  it('shows a side-less pin on either side', () => {
    expect(sameArtifactPicture(at({}), ref, ReviewImageAnchor.side.LEFT)).toBe(true)
  })

  it('is false with nothing to compare against', () => {
    expect(sameArtifactPicture(undefined, ref)).toBe(false)
    expect(sameArtifactPicture(at({}), null)).toBe(false)
  })
})

describe('anchorVersionLabel', () => {
  it('names a commit', () => {
    expect(anchorVersionLabel({ file: 'f', key: 'commit/abc1234def0567890', x: 0, y: 0 })).toBe('abc1234def05')
  })

  // The whole point of keeping the key verbatim: a working-tree render never had
  // a sha, and reporting one sends the reader to code that was not on screen.
  it('never reports a working-tree render as a commit', () => {
    const label = anchorVersionLabel({ file: 'f', key: 'worktree/9f3a1b2c', x: 0, y: 0 })
    expect(label).toContain('uncommitted working tree')
    expect(label).toContain('9f3a1b2c')
  })

  it('passes an unrecognised key through rather than inventing a reading', () => {
    expect(anchorVersionLabel({ file: 'f', key: 'weird', x: 0, y: 0 })).toBe('weird')
  })
})

// A recording has a time axis as well as two spatial ones, and "34%,71%" of a
// clip means nothing without the frame it is 34%,71% of.
describe('video timestamps', () => {
  it('carries the moment into the anchor and the label', () => {
    const a = buildImageAnchor({ url: BLOB, x: 0.5, y: 0.5, natural: { w: 800, h: 600 }, t: 12.44 })!
    expect(a.t).toBe(12.44)
    expect(anchorPositionLabel(a)).toBe('400,300 px @ 0:12.4')
  })

  it('leaves the moment out for a still, where it would be meaningless', () => {
    const a = buildImageAnchor({ url: BLOB, x: 0.5, y: 0.5 })!
    expect(a.t).toBeUndefined()
    expect(anchorPositionLabel(a)).not.toContain('@')
  })

  // Padded to a fixed width so a column of timecodes lines up, and minutes roll
  // over rather than counting seconds forever. Values are deliberately not exact
  // .x5 ties: Go's %04.1f and JS's toFixed round those the other way from each
  // other, and a tenth of a second either way is not worth pinning down.
  it('formats a moment the way the agent is told it', () => {
    expect(formatTimecode(0)).toBe('0:00.0')
    expect(formatTimecode(9.28)).toBe('0:09.3')
    expect(formatTimecode(75.52)).toBe('1:15.5')
    expect(formatTimecode(-3)).toBe('0:00.0')
    // The carry must reach the MINUTE, or 59.96s reads as "0:60.0".
    expect(formatTimecode(59.96)).toBe('1:00.0')
    expect(formatTimecode(119.99)).toBe('2:00.0')
  })
})

// The card shows the pinned spot from the LIVE file rather than a stored copy, so
// this URL has to round-trip with the parser that produced the anchor - if the two
// ever disagreed, a comment would render against the wrong picture.
describe('artifactBlobUrl', () => {
  it('round-trips with artifactRefFromUrl', () => {
    const anchor = buildImageAnchor({ url: BLOB, x: 0.1, y: 0.2 })!
    const url = artifactBlobUrl('p1', anchor)!
    expect(artifactRefFromUrl(url)).toEqual({
      script: 'screenshots',
      key: 'commit/abc1234def0567',
      file: 'home-dark.png',
    })
  })

  it('is null without everything it needs to address a blob', () => {
    const anchor = buildImageAnchor({ url: BLOB, x: 0, y: 0 })!
    expect(artifactBlobUrl(null, anchor)).toBeNull()
    expect(artifactBlobUrl('p1', { file: 'x.png', x: 0, y: 0 })).toBeNull()
  })
})
