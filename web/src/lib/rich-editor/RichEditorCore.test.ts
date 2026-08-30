import { describe, expect, it } from 'vitest'
import { createRichEditor, parseRichMarkdown, serializeRichMarkdown } from './RichEditorCore'
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

  it('round trips GFM tables with header cells and alignment', () => {
    const markdown = '| Name | Value |\n| :--- | ---: |\n| alpha | 1 |\n| beta | 2 |'
    const document = parseRichMarkdown(markdown)
    expect(document.content?.[0]).toMatchObject({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', attrs: { align: 'left' } },
            { type: 'tableHeader', attrs: { align: 'right' } },
          ],
        },
        { type: 'tableRow', content: [{ type: 'tableCell' }, { type: 'tableCell' }] },
        { type: 'tableRow', content: [{ type: 'tableCell' }, { type: 'tableCell' }] },
      ],
    })
    const serialized = serializeRichMarkdown(document)
    // TableKit canonicalizes column widths; the semantic Markdown boundary is
    // stable even though rich edits are not byte-for-byte source preserving.
    expect(serialized).toContain('| Name  | Value |')
    expect(serialized).toContain('| :----- | -----: |')
    expect(roundTrip(serialized)).toBe(serialized)
  })

  it('inserts and reshapes a table through editor commands', () => {
    const editor = createRichEditor()
    expect(editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })).toBe(true)
    expect(editor.commands.addRowAfter()).toBe(true)
    expect(editor.commands.addColumnAfter()).toBe(true)
    const table = editor.getJSON().content?.[0]
    expect(table?.type).toBe('table')
    expect(table?.content).toHaveLength(3)
    expect(table?.content?.every((row) => row.content?.length === 3)).toBe(true)
    editor.destroy()
  })

  it('represents inline code as a content-bearing node', () => {
    const document = parseRichMarkdown('Run `some_tool` now')
    expect(document.content?.[0].content?.[1]).toEqual({
      type: 'inlineCode',
      content: [{ type: 'text', text: 'some_tool' }],
    })
    expect(serializeRichMarkdown(document)).toBe('Run `some_tool` now')
  })

  it('round trips Hydra references through readable Markdown', () => {
    const markdown = 'Review [web/src/App.tsx](hydra://file/web/src/App.tsx) on [main](hydra://branch/main) with [reviewer](hydra://agent/reviewer).'
    const document = parseRichMarkdown(markdown)
    expect(document.content?.[0].content?.filter((node) => node.type === 'hydraReference')).toEqual([
      expect.objectContaining({ attrs: expect.objectContaining({ kind: 'file', value: 'web/src/App.tsx' }) }),
      expect.objectContaining({ attrs: expect.objectContaining({ kind: 'branch', value: 'main' }) }),
      expect.objectContaining({ attrs: expect.objectContaining({ kind: 'agent', value: 'reviewer' }) }),
    ])
    expect(serializeRichMarkdown(document)).toBe(markdown)
  })

  it('reads legacy Hydra references and writes the canonical link form', () => {
    const document = parseRichMarkdown('@file[web/src/App.tsx]')
    expect(document.content?.[0].content?.[0]).toMatchObject({
      type: 'hydraReference',
      attrs: { kind: 'file', value: 'web/src/App.tsx' },
    })
    expect(serializeRichMarkdown(document)).toBe('[web/src/App.tsx](hydra://file/web/src/App.tsx)')
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
