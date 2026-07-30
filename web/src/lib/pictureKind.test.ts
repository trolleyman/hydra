import { describe, it, expect } from 'vitest'
import { agentFilePath, pictureKind, uploadName } from './pictureKind'

describe('pictureKind', () => {
  it.each([
    ['/artifacts/projects/p/blob?script=s&key=commit%2Fa&file=x.png', 'artifact'],
    ['/agent-files/projects/p/agents/a1/blob?path=%2Ftmp%2Fshot.png', 'agent-file'],
    ['/uploads/projects/p/blob?name=1699-shot.png', 'upload'],
    ['data:image/png;base64,AAAA', 'other'],
    ['https://example.com/x.png', 'other'],
    ['', 'other'],
  ])('classifies %s as %s', (url, want) => {
    expect(pictureKind(url)).toBe(want)
  })

  // The route is matched as a path PREFIX, not searched for as a substring: an
  // upload whose filename happens to contain another route's path would
  // otherwise be misfiled, and misfiling decides where a remark goes.
  it('is not fooled by a route name inside a filename', () => {
    expect(pictureKind('/uploads/projects/p/blob?name=%2Fartifacts%2Fprojects%2Fx.png')).toBe('upload')
  })

  it('does not throw on a malformed URL', () => {
    expect(pictureKind('ht!tp://[[[')).toBe('other')
  })
})

describe('agentFilePath / uploadName', () => {
  it('recovers what the agent would open', () => {
    expect(agentFilePath('/agent-files/projects/p/agents/a1/blob?path=%2Ftmp%2Fshot.png')).toBe('/tmp/shot.png')
  })

  it('recovers the stored name of an upload', () => {
    expect(uploadName('/uploads/projects/p/blob?name=1699-shot.png')).toBe('1699-shot.png')
  })

  // Each only answers for its OWN kind, so a caller cannot accidentally treat an
  // artifact as an attachment by asking the wrong question.
  it('refuses to answer for another kind', () => {
    expect(agentFilePath('/uploads/projects/p/blob?name=x.png')).toBeNull()
    expect(uploadName('/agent-files/projects/p/agents/a/blob?path=%2Fx.png')).toBeNull()
  })
})
