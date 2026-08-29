import { describe, expect, it } from 'vitest'
import { parseRichMarkdown, serializeRichMarkdown } from './RichEditorCore'
import { serializeInlineCode } from './InlineCode'

function roundTrip(markdown: string): string {
  return serializeRichMarkdown(parseRichMarkdown(markdown))
}

describe('rich editor Markdown interchange', () => {
  it('round trips the supported prose marks and links', () => {
    const markdown = '**bold** and *italic* and ~~strike~~ and [Hydra](https://example.com)'
    expect(roundTrip(markdown)).toBe(markdown)
  })

  it('round trips headings, quotes, lists and fenced code', () => {
    const markdown = '# Heading\n\n> quote\n\n- one\n- two\n\n```ts\nconst value = 1\n```'
    expect(roundTrip(markdown)).toBe(markdown)
  })

  it('round trips task lists with checked state', () => {
    const markdown = '- [ ] pending\n- [x] complete'
    const document = parseRichMarkdown(markdown)
    expect(document.content?.[0]).toMatchObject({
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: false } },
        { type: 'taskItem', attrs: { checked: true } },
      ],
    })
    expect(serializeRichMarkdown(document)).toBe(markdown)
  })

  it('represents inline code as a content-bearing node', () => {
    const document = parseRichMarkdown('Run `some_tool` now')
    expect(document.content?.[0].content?.[1]).toEqual({
      type: 'inlineCode',
      content: [{ type: 'text', text: 'some_tool' }],
    })
    expect(serializeRichMarkdown(document)).toBe('Run `some_tool` now')
  })

  it('chooses a safe variable-length code delimiter', () => {
    expect(serializeInlineCode('a ` b')).toBe('``a ` b``')
    expect(serializeInlineCode('`edge`')).toBe('`` `edge` ``')
    expect(roundTrip('``a ` b``')).toBe('``a ` b``')
  })

  it('keeps identifier underscores literal', () => {
    const document = parseRichMarkdown('some_foo bar_thing snake_case')
    const text = document.content?.[0].content
    expect(text).toHaveLength(1)
    expect(text?.[0]).toMatchObject({ type: 'text', text: 'some_foo bar_thing snake_case' })
    expect(text?.[0].marks).toBeUndefined()
    expect(serializeRichMarkdown(document)).toBe('some\\_foo bar\\_thing snake\\_case')
  })
})
