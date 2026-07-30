import { describe, it, expect } from 'vitest'
import { parseReviewCommentsText, savedCommentNumber } from './reviewCommentsText'

// The exact text reviewstore.RenderForAgent writes for a narrowed read: one
// comment, anchored, with its frozen diff excerpt.
const ONE = [
  '#19 internal/cli/runtime.go:585 - user, on main -> latest commit',
  '```diff',
  '--- internal/cli/runtime.go',
  '+++ internal/cli/runtime.go',
  '@@ -1,725 +1,729 @@',
  '+\tmux.HandleFunc("/review-crops/...", server.HandleReviewCropBlob)',
  '# ^ Comment',
  ' \tmux.HandleFunc("/artifacts/...", server.HandleArtifactLog)',
  '```',
  'What is this and why does it need a new path btw?',
].join('\n')

describe('parseReviewCommentsText', () => {
  it('reads the anchor, author and comparison off the header', () => {
    const parsed = parseReviewCommentsText(ONE)!
    expect(parsed.comments).toHaveLength(1)
    expect(parsed.comments[0]).toMatchObject({
      number: 19,
      path: 'internal/cli/runtime.go',
      line: 585,
      author: 'user',
      diff: 'main -> latest commit',
      replyTo: 0,
      resolved: false,
      body: 'What is this and why does it need a new path btw?',
    })
    expect(parsed.comments[0].context.split('\n')[0]).toBe('--- internal/cli/runtime.go')
    expect(parsed.preamble).toBe('')
    expect(parsed.trailer).toBe('')
  })

  it('reads a thread: replies, resolution, and a comment anchored to nothing', () => {
    const parsed = parseReviewCommentsText([
      '#3 web/src/DiffViewer.tsx (reply to #2) [resolved] - reviewer, on main -> abc1234',
      'Fixed in the follow-up.',
      '',
      '#4 - agent',
      'No file for this one.',
    ].join('\n'))!
    expect(parsed.comments.map((c) => [c.number, c.path, c.line, c.replyTo, c.resolved, c.author])).toEqual([
      [3, 'web/src/DiffViewer.tsx', 0, 2, true, 'reviewer'],
      [4, '', 0, 0, false, 'agent'],
    ])
  })

  it('keeps the heading and the forge half out of the comments', () => {
    const parsed = parseReviewCommentsText([
      'Review comments left in Hydra:',
      '',
      '#7 main.go:1 - user',
      'Rename this.',
      '',
      '---',
      '',
      'Unresolved discussions on https://github.com/x/y/pull/3',
    ].join('\n'))!
    expect(parsed.preamble).toBe('Review comments left in Hydra:')
    expect(parsed.comments).toHaveLength(1)
    expect(parsed.comments[0].body).toBe('Rename this.')
    expect(parsed.trailer).toBe('Unresolved discussions on https://github.com/x/y/pull/3')
  })

  it('leaves a body alone: a rule, a fence and a line that looks like a header', () => {
    const parsed = parseReviewCommentsText([
      '#7 main.go:1 - user',
      'Before.',
      '',
      '---',
      '',
      '#8 is the one I meant',
      '```go',
      'func main() {}',
      '```',
    ].join('\n'))!
    expect(parsed.comments).toHaveLength(1)
    expect(parsed.comments[0].context).toBe('')
    expect(parsed.comments[0].body).toBe('Before.\n\n---\n\n#8 is the one I meant\n```go\nfunc main() {}\n```')
    expect(parsed.trailer).toBe('')
  })

  it('declines anything that is not a list of comments', () => {
    expect(parseReviewCommentsText('No review comments on this head yet.')).toBeNull()
    expect(parseReviewCommentsText('This head is not linked to a merge/pull request: ...')).toBeNull()
  })
})

describe('savedCommentNumber', () => {
  it('takes the new number off the tool confirmation', () => {
    expect(savedCommentNumber('Saved as #20, threaded under #19. The user can see it.')).toBe(20)
    expect(savedCommentNumber('Saved as #21 on main.go:4. The user can see it.')).toBe(21)
    expect(savedCommentNumber('Saved as a local note on the thread holding #19.')).toBe(0)
    expect(savedCommentNumber('The reply was empty, so nothing was recorded.')).toBe(0)
  })
})
