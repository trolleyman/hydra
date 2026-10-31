import { expect, test, type Page } from '@playwright/test'
import type { Editor } from '@tiptap/core'

interface SpikeSnapshot {
  doc: Record<string, unknown>
  text: string
  from: number
  to: number
  parent: string
  domInsideCode: boolean
  activeCode: number
}

const paragraph = (...content: Record<string, unknown>[]) => ({
  type: 'doc',
  content: [{ type: 'paragraph', ...(content.length > 0 ? { content } : {}) }],
})
const text = (value: string) => ({ type: 'text', text: value })
const code = (value = '') => value
  ? { type: 'inlineCode', content: [{ type: 'text', text: value }] }
  : { type: 'inlineCode' }
const attachment = { type: 'attachment', attrs: { id: 'file-1', name: 'notes.txt', kind: 'text', display: 'chip' } }
const codeBlock = (value = '') => ({
  type: 'doc',
  content: [{ type: 'codeBlock', attrs: { language: null }, ...(value ? { content: [text(value)] } : {}) }],
})

async function select(page: Page, from: number, to = from) {
  await page.evaluate(([start, end]) => window.richEditorSpike.select(start, end), [from, to])
}

async function reset(page: Page, doc: Record<string, unknown>) {
  await page.evaluate((content) => window.richEditorSpike.reset(content), doc)
}

async function snapshot(page: Page): Promise<SpikeSnapshot> {
  return page.evaluate(() => window.richEditorSpike.snapshot())
}

declare global {
  interface Window {
    richEditorSpike: {
      reset: (content: Record<string, unknown>) => void
      select: (from: number, to?: number) => void
      setCodeLanguage: (language: string) => void
      addImage: () => string
      openedAttachment: () => string
      snapshot: () => SpikeSnapshot
    }
    interactiveRichEditor: Editor | null
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-rich-editor-spike]')).toBeVisible()
})

test('inline code and attachments do not change the surrounding line height', async ({ page }) => {
  const paragraphHeight = async () => page.locator('[data-rich-editor-spike] p').evaluate((element) => element.getBoundingClientRect().height)
  await reset(page, paragraph(text('plain text')))
  const plain = await paragraphHeight()
  await reset(page, paragraph(text('before '), code('inline'), text(' after')))
  const withCode = await paragraphHeight()
  await reset(page, paragraph(text('before '), attachment, text(' after')))
  const withAttachment = await paragraphHeight()
  // Engines round inline font metrics differently, but neither token may add a
  // full layout pixel to the surrounding line.
  expect(Math.abs(withCode - plain)).toBeLessThan(0.75)
  expect(Math.abs(withAttachment - plain)).toBeLessThan(0.75)
})

test('an inline image has only outer caret positions, no phantom line, opens, and deletes', async ({ page }) => {
  await reset(page, paragraph(text('before ')))
  await select(page, 8)
  const id = await page.evaluate(() => window.richEditorSpike.addImage())
  const chip = page.locator(`[data-attachment-id="${id}"]`)
  await expect(chip).toBeVisible()
  const trailingBreak = chip.locator('+ br.ProseMirror-trailingBreak')
  if (await trailingBreak.count()) await expect(trailingBreak).toHaveCSS('display', 'none')

  await chip.click()
  expect(await page.evaluate(() => window.richEditorSpike.openedAttachment())).toBe(id)
  expect((await snapshot(page)).parent).toBe('paragraph')

  await select(page, 9)
  expect((await snapshot(page)).parent).toBe('paragraph')
  await page.keyboard.press('Backspace')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(text('before ')), parent: 'paragraph' })
})

test('rendered commit and file chips do not change chat line height', async ({ page }) => {
  await page.locator('[data-rendered-token-fixture]').evaluate((element) => { element.hidden = false })
  const heights = await page.locator('[data-token-line]').evaluateAll((lines) => Object.fromEntries(
    lines.map((line) => [line.getAttribute('data-token-line'), line.getBoundingClientRect().height]),
  ))
  expect(Math.abs(heights.commit - heights.plain)).toBeLessThan(0.75)
  expect(Math.abs(heights.file - heights.plain)).toBeLessThan(0.75)
})

test('Right traverses outside, inside characters, then outside', async ({ page }) => {
  await select(page, 3)
  const positions: number[] = [(await snapshot(page)).from]
  const parents: string[] = [(await snapshot(page)).parent]
  const domInside: boolean[] = [(await snapshot(page)).domInsideCode]
  const activeCode: number[] = [(await snapshot(page)).activeCode]
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowRight')
    const state = await snapshot(page)
    positions.push(state.from)
    parents.push(state.parent)
    domInside.push(state.domInsideCode)
    activeCode.push(state.activeCode)
  }
  expect(positions).toEqual([3, 4, 5, 6, 7, 8])
  expect(parents).toEqual(['paragraph', 'inlineCode', 'inlineCode', 'inlineCode', 'inlineCode', 'paragraph'])
  // Chrome collapses DOM affinity at the inline edges: inside-start maps to the
  // DOM before the code and outside-after maps to its DOM end. ProseMirror state
  // remains distinct, and the active decoration makes that state visible.
  expect(domInside).toEqual([false, false, true, true, true, true])
  // The native caret is the only position indicator; entering a code span does
  // not paint a second synthetic edge caret on the capsule.
  expect(activeCode).toEqual([0, 0, 0, 0, 0, 0])
})

test('Left traverses the same positions in reverse', async ({ page }) => {
  await select(page, 8)
  const positions: number[] = [8]
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowLeft')
    positions.push((await snapshot(page)).from)
  }
  expect(positions).toEqual([8, 7, 6, 5, 4, 3])
})

test('Home and End leave an inline code node at its outer boundaries', async ({ page }) => {
  await select(page, 5)
  await page.keyboard.press('End')
  expect(await snapshot(page)).toMatchObject({ from: 8, parent: 'paragraph' })
  await select(page, 5)
  await page.keyboard.press('Home')
  expect(await snapshot(page)).toMatchObject({ from: 3, parent: 'paragraph' })
})

test('backtick inserts, accepts text, and exits an inline code node', async ({ page }) => {
  await reset(page, paragraph(text('before ')))
  await select(page, 8)
  const beforeX = await page.locator('[data-rich-editor-spike] p').evaluate((element) => {
    const range = document.createRange()
    const textNode = element.firstChild!
    const end = textNode.textContent?.length ?? 0
    range.setStart(textNode, end)
    range.setEnd(textNode, end)
    return range.getBoundingClientRect().right
  })
  await page.keyboard.type('`')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(text('before '), code()), from: 9, parent: 'inlineCode' })
  const emptyCode = await page.locator('code[data-inline-code]').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, width: rect.width }
  })
  expect(Math.abs(emptyCode.left - beforeX)).toBeLessThan(2)
  // An empty capsule reserves a real typing slot, so following prose cannot sit
  // behind a zero-width pseudo-element.
  expect(emptyCode.width).toBeGreaterThan(8)

  await page.keyboard.type('foo')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(text('before '), code('foo')), from: 12, parent: 'inlineCode' })

  await page.keyboard.type('`')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(text('before '), code('foo')), from: 13, parent: 'paragraph' })
  await expect(page.locator('code[data-inline-code]')).toHaveText('foo')
})

test('three backticks open a code block', async ({ page }) => {
  await reset(page, paragraph())
  await select(page, 1)
  await page.keyboard.type('```')
  const state = await snapshot(page)
  expect(state.parent).toBe('codeBlock')
  expect((state.doc.content as Record<string, unknown>[])[0]).toEqual({
    type: 'codeBlock',
    attrs: { language: null },
  })
})

test('a code block highlights its selected language', async ({ page }) => {
  await reset(page, paragraph())
  await select(page, 1)
  await page.keyboard.type('```')
  await page.keyboard.type('const answer = 1')
  await page.evaluate(() => window.richEditorSpike.setCodeLanguage('typescript'))
  const keyword = page.locator('[data-rich-editor-spike] .token.keyword')
  await expect(keyword, await page.locator('[data-rich-editor-spike]').innerHTML()).toHaveText('const')
  expect(((await snapshot(page)).doc.content as Record<string, unknown>[])[0]).toMatchObject({
    type: 'codeBlock', attrs: { language: 'typescript' },
  })
})

test('Python labels canonicalize, highlight, and preserve equality source text', async ({ page }) => {
  const interactive = page.getByRole('textbox', { name: 'Interactive rich editor fixture' })
  await page.evaluate((doc) => window.interactiveRichEditor?.commands.setContent(doc), codeBlock("if __name__ == '__main__':"))
  await page.getByRole('button', { name: 'Code block language: Plain text' }).click()
  await page.getByRole('combobox', { name: 'Code block language' }).fill('Python')
  await page.getByRole('button', { name: 'Use "Python"' }).click()
  await expect(interactive.locator('.token.keyword')).toHaveText('if')
  await expect(interactive.locator('.rich-code-block-content')).toHaveText("if __name__ == '__main__':")
  expect(await page.evaluate(() => window.interactiveRichEditor?.getAttributes('codeBlock').language)).toBe('python')
})

test('the language picker portals beyond the composer and flips above near the viewport bottom', async ({ page }) => {
  await page.evaluate((doc) => window.interactiveRichEditor?.commands.setContent(doc), codeBlock('value'))
  await page.locator('#interactive-editor').evaluate((element) => {
    element.setAttribute('style', 'position: fixed; right: 8px; bottom: 0; width: 320px; height: 90px; overflow: hidden')
  })
  await page.getByRole('button', { name: 'Code block language: Plain text' }).click()
  const popover = page.locator('body > .rich-code-language-popover')
  await expect(popover).toBeVisible()
  await expect(popover).toHaveAttribute('data-side', 'top')
  const [hostBox, popoverBox] = await Promise.all([
    page.locator('#interactive-editor').boundingBox(),
    popover.boundingBox(),
  ])
  expect(hostBox).not.toBeNull()
  expect(popoverBox).not.toBeNull()
  expect(popoverBox!.y).toBeLessThan(hostBox!.y)
})

test('the custom language picker accepts arbitrary values without a toolbar row', async ({ page }) => {
  const interactive = page.getByRole('textbox', { name: 'Interactive rich editor fixture' })
  await page.evaluate((doc) => window.interactiveRichEditor?.commands.setContent(doc), codeBlock('echo 123'))
  const block = interactive.locator('.rich-code-block')
  const content = block.locator('.rich-code-block-content')
  const geometry = await Promise.all([block.boundingBox(), content.boundingBox()])
  expect(geometry[0]).not.toBeNull()
  expect(geometry[1]).not.toBeNull()
  expect(geometry[1]!.y - geometry[0]!.y).toBeLessThan(16)

  await page.getByRole('button', { name: 'Code block language: Plain text' }).click()
  await page.getByRole('combobox', { name: 'Code block language' }).fill('cue')
  await page.getByRole('button', { name: 'Use "cue"' }).click()
  expect(await page.evaluate(() => window.interactiveRichEditor?.getAttributes('codeBlock').language)).toBe('cue')
  await expect(interactive.locator('select')).toHaveCount(0)
  await expect(block.locator('.rich-code-language')).toHaveCSS('user-select', 'none')
})

test('Shift+Enter inserts a newline in fenced code under a send-on-Enter host', async ({ page }) => {
  const interactive = page.getByRole('textbox', { name: 'Interactive rich editor fixture' })
  await page.evaluate((doc) => {
    window.interactiveRichEditor?.commands.setContent(doc)
    window.interactiveRichEditor?.commands.setTextSelection(2)
  }, codeBlock('a'))
  await interactive.focus()
  await page.keyboard.press('Shift+Enter')
  expect(await page.evaluate(() => ({
    text: window.interactiveRichEditor?.state.selection.$from.parent.textContent,
    parent: window.interactiveRichEditor?.state.selection.$from.parent.type.name,
  }))).toEqual({ text: 'a\n', parent: 'codeBlock' })
})

test('clicking blank composer space places the caret at the document end', async ({ page }) => {
  const interactive = page.getByRole('textbox', { name: 'Interactive rich editor fixture' })
  await page.evaluate((doc) => window.interactiveRichEditor?.commands.setContent(doc), paragraph(text('start')))
  const box = await interactive.boundingBox()
  if (!box) throw new Error('Missing interactive composer geometry')
  await page.mouse.click(box.x + 20, box.y + box.height - 8)
  await page.keyboard.type(' end')
  expect(await page.evaluate(() => window.interactiveRichEditor?.getText())).toBe('start end')
})

test('the controlled composer preserves spaces and monotonic inline-code deletion', async ({ page }) => {
  const interactive = page.getByRole('textbox', { name: 'Interactive rich editor fixture' })
  await page.evaluate(() => window.interactiveRichEditor?.commands.clearContent())
  await interactive.click()
  // Keep the printable run together: Chromium can otherwise expose a trailing
  // contenteditable space as NBSP before the following key is reconciled.
  await page.keyboard.type('`a b')
  expect(await page.evaluate(() => window.interactiveRichEditor?.getJSON())).toEqual(paragraph(code('a b')))
  await page.keyboard.press('Backspace')
  expect(await page.evaluate(() => window.interactiveRichEditor?.getJSON())).toEqual(paragraph(code('a ')))
  await page.keyboard.press('Backspace')
  expect(await page.evaluate(() => window.interactiveRichEditor?.getJSON())).toEqual(paragraph(code('a')))
})

test('controlled Backspace unwraps at the outside edge once, then deletes prose', async ({ page }) => {
  const interactive = page.getByRole('textbox', { name: 'Interactive rich editor fixture' })
  await page.evaluate(() => window.interactiveRichEditor?.commands.clearContent())
  await interactive.click()
  await page.keyboard.type('`hello there my a n`')
  await page.keyboard.press('Backspace')
  expect(await page.evaluate(() => window.interactiveRichEditor?.getJSON()))
    .toEqual(paragraph(text('hello there my a n')))
  await page.keyboard.press('Backspace')
  expect(await page.evaluate(() => window.interactiveRichEditor?.getJSON()))
    .toEqual(paragraph(text('hello there my a ')))
})

test('Tab and Shift+Tab indent code without moving browser focus', async ({ page }) => {
  await reset(page, codeBlock('one\ntwo'))
  await select(page, 1, 8)
  await page.keyboard.press('Tab')
  let state = await snapshot(page)
  expect(state.parent).toBe('codeBlock')
  expect((state.doc.content as Record<string, unknown>[])[0]).toEqual(codeBlock('  one\n  two').content[0])
  await page.keyboard.press('Shift+Tab')
  state = await snapshot(page)
  expect(state.parent).toBe('codeBlock')
  expect((state.doc.content as Record<string, unknown>[])[0]).toEqual(codeBlock('one\ntwo').content[0])
})

test('ArrowDown exits a final code block and empty Backspace unwraps it', async ({ page }) => {
  await reset(page, codeBlock('value'))
  await select(page, 6)
  await page.keyboard.press('ArrowDown')
  expect(await snapshot(page)).toMatchObject({
    doc: { type: 'doc', content: [codeBlock('value').content[0], { type: 'paragraph' }] },
    parent: 'paragraph',
  })

  await reset(page, codeBlock())
  await select(page, 1)
  await page.keyboard.press('Backspace')
  const unwrapped = await snapshot(page)
  expect(unwrapped.parent).toBe('paragraph')
  expect((unwrapped.doc.content as Record<string, unknown>[])[0]).toEqual({ type: 'paragraph' })
})

test('pipe-space at the start of a line opens a two-column table', async ({ page }) => {
  await reset(page, paragraph())
  await select(page, 1)
  await page.keyboard.type('| ')
  const state = await snapshot(page)
  expect(state).toMatchObject({ parent: 'paragraph', from: 4 })
  expect((state.doc.content as Record<string, unknown>[])[0]).toMatchObject({
    type: 'table',
    content: [
      { type: 'tableRow', content: [{ type: 'tableHeader' }, { type: 'tableHeader' }] },
      { type: 'tableRow', content: [{ type: 'tableCell' }, { type: 'tableCell' }] },
    ],
  })
})

test('a table grows by keyboard, exposes local actions and selection gutters, and scrolls narrowly', async ({ page }) => {
  const interactive = page.getByRole('textbox', { name: 'Interactive rich editor fixture' })
  await expect(interactive).toBeVisible()
  await interactive.locator('th').first().hover()
  await page.getByRole('button', { name: 'Cell actions' }).click()
  await page.getByRole('menuitem', { name: 'Add row below' }).click()
  await expect(page.getByRole('status')).toHaveText('Row added below')
  await expect(interactive.locator('tr')).toHaveCount(3)

  await interactive.locator('th').nth(1).locator('p').click({ position: { x: 3, y: 8 } })
  await page.keyboard.press('Tab')
  await expect(interactive.locator('th')).toHaveCount(3)

  const firstRowHandle = page.getByRole('button', { name: 'Select row 1' })
  const secondRowHandle = page.getByRole('button', { name: 'Select row 2' })
  const from = await firstRowHandle.boundingBox()
  const to = await secondRowHandle.boundingBox()
  if (!from || !to) throw new Error('Missing table row handle geometry')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2)
  await page.mouse.up()
  await expect(interactive.locator('.selectedCell')).toHaveCount(6)

  await page.getByRole('button', { name: 'Select row 3' }).click()
  await expect(interactive.locator('.selectedCell')).toHaveCount(3)
  await page.keyboard.press('Backspace')
  await expect(interactive.locator('tr')).toHaveCount(2)

  await page.locator('#interactive-editor').evaluate((element) => { (element as HTMLElement).style.width = '240px' })
  const geometry = await interactive.locator('.rich-table-wrapper').evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }))
  expect(geometry.scroll).toBeGreaterThan(geometry.client)
})

test('the discovery menus create blocks and structured references', async ({ page }) => {
  const interactive = page.getByRole('textbox', { name: 'Interactive rich editor fixture' })
  await page.evaluate(() => window.interactiveRichEditor?.commands.clearContent())
  await interactive.click()
  await page.keyboard.type('/quo')
  await expect(page.getByRole('listbox', { name: 'Block commands' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(interactive.locator('blockquote')).toBeVisible()

  await page.keyboard.type('@branch:rich')
  await expect(page.getByRole('listbox', { name: 'References' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(interactive.locator('[data-hydra-reference="branch"]')).toHaveText('@hydra/rich-text')
})

test('Right exits a code capsule at the end of the paragraph', async ({ page }) => {
  await reset(page, paragraph(code('a')))
  await select(page, 3)
  await page.keyboard.press('ArrowRight')
  expect(await snapshot(page)).toMatchObject({ from: 4, parent: 'paragraph', activeCode: 0 })
  await page.keyboard.type('X')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(code('a'), text('X')) })
})

test('inline code keeps single spaces and repeated Backspace makes forward progress', async ({ page }) => {
  await reset(page, paragraph())
  await select(page, 1)
  await page.keyboard.type('`a')
  await page.keyboard.press('Space')
  await page.keyboard.type('b')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(code('a b')) })

  await page.keyboard.press('Backspace')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(code('a ')) })
  await page.keyboard.press('Backspace')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(code('a')) })
})

test('a backtick at the visual end of inline code closes it without creating another span', async ({ page }) => {
  await reset(page, paragraph(code('9f24c10')))
  await select(page, 10)
  await page.keyboard.type('`')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(code('9f24c10')), from: 10, parent: 'paragraph' })
})

test('backtick wraps a selected run without visible delimiters', async ({ page }) => {
  await reset(page, paragraph(text('abc')))
  await select(page, 1, 4)
  await page.keyboard.type('`')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(code('abc')), from: 2, to: 5 })
  await expect(page.locator('[data-rich-editor-spike]')).toHaveText('abc')
})

test('all four non-empty deletion boundaries unwrap without deleting text', async ({ page }) => {
  const cases: [number, string, number][] = [
    [4, 'Backspace', 3],
    [7, 'Delete', 6],
    [8, 'Backspace', 6],
    [3, 'Delete', 3],
  ]
  for (const [position, key, expectedCaret] of cases) {
    await reset(page, paragraph(text('a '), code('foo'), text(' b')))
    await select(page, position)
    await page.keyboard.press(key)
    expect(await snapshot(page)).toMatchObject({ doc: paragraph(text('a foo b')), from: expectedCaret })
  }
})

test('Backspace and Delete remove an empty code node', async ({ page }) => {
  for (const key of ['Backspace', 'Delete']) {
    await reset(page, paragraph(code()))
    await select(page, 2)
    await page.keyboard.press(key)
    expect(await snapshot(page)).toMatchObject({ doc: paragraph(), from: 1 })
  }
})

test('undo separates typed content from structural insertion', async ({ page }) => {
  await reset(page, paragraph())
  await select(page, 1)
  await page.keyboard.type('`foo`')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(code('foo')) })
  await page.keyboard.press('Control+z')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(code()) })
  await page.keyboard.press('Control+z')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph() })
})

test('Arrow keys cross a joined emoji as one grapheme', async ({ page }) => {
  const family = '👨‍👩‍👧‍👦'
  await reset(page, paragraph(code(`a${family}b`)))
  await select(page, 1)
  const positions: number[] = [1]
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowRight')
    positions.push((await snapshot(page)).from)
  }
  expect(positions).toEqual([1, 2, 3, 3 + family.length, 4 + family.length, 5 + family.length])
})

test('a composing backtick is left to the IME', async ({ page }) => {
  await reset(page, paragraph())
  await select(page, 1)
  await page.locator('[data-rich-editor-spike]').dispatchEvent('keydown', {
    key: '`',
    code: 'Backquote',
    isComposing: true,
  })
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(), from: 1 })
})

test('copying code contents writes literal text', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Playwright clipboard permissions are Chromium-only')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await reset(page, paragraph(code('foo')))
  await select(page, 2, 5)
  await page.keyboard.press('Control+c')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('foo')
})

test('Shift+Arrow extends a selection across code boundaries one step at a time', async ({ page }) => {
  await select(page, 3)
  await page.keyboard.press('Shift+ArrowRight')
  expect(await snapshot(page)).toMatchObject({ from: 3, to: 4 })
  await page.keyboard.press('Shift+ArrowRight')
  expect(await snapshot(page)).toMatchObject({ from: 3, to: 5 })

  await select(page, 8)
  await page.keyboard.press('Shift+ArrowLeft')
  expect(await snapshot(page)).toMatchObject({ from: 7, to: 8 })
  await page.keyboard.press('Shift+ArrowLeft')
  expect(await snapshot(page)).toMatchObject({ from: 6, to: 8 })
})

test('clicking code padding places the caret inside the corresponding edge', async ({ page }) => {
  const capsule = page.locator('code[data-inline-code]')
  const box = await capsule.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.mouse.click(box.x + 2, box.y + box.height / 2)
  expect(await snapshot(page)).toMatchObject({ from: 4, parent: 'inlineCode', activeCode: 0 })

  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2)
  expect(await snapshot(page)).toMatchObject({ from: 7, parent: 'inlineCode', activeCode: 0 })
})

test('partial and whole-node selections delete only what they cover', async ({ page }) => {
  await reset(page, paragraph(text('a '), code('foo'), text(' b')))
  await select(page, 5, 6)
  await page.keyboard.press('Backspace')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(text('a '), code('fo'), text(' b')) })

  await reset(page, paragraph(text('a '), code('foo'), text(' b')))
  await select(page, 3, 8)
  await page.keyboard.press('Delete')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(text('a  b')), from: 3 })
})

test('typing over a cross-node selection produces one valid text run', async ({ page }) => {
  await reset(page, paragraph(text('a '), code('foo'), text(' b')))
  await select(page, 2, 9)
  await page.keyboard.type('X')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(text('aXb')), from: 3 })
})

test('star typing formats italic while underscore typing stays literal', async ({ page }) => {
  await reset(page, paragraph())
  await select(page, 1)
  await page.keyboard.type('*safe* ')
  expect(await snapshot(page)).toMatchObject({
    doc: paragraph(
      { type: 'text', marks: [{ type: 'italic' }], text: 'safe' },
      text(' '),
    ),
  })

  await page.keyboard.type('_LAYOUT_')
  expect(await snapshot(page)).toMatchObject({
    doc: paragraph(
      { type: 'text', marks: [{ type: 'italic' }], text: 'safe' },
      text(' _LAYOUT_'),
    ),
  })
})

test('code source never sits underneath the language picker at narrow or wide sizes', async ({ page }) => {
  await expect(page.getByRole('textbox', { name: 'Interactive rich editor fixture' })).toBeVisible()
  await page.evaluate((doc) => window.interactiveRichEditor?.commands.setContent(doc), codeBlock('await uploadFile(projectId, file, signal)'))
  for (const width of [320, 620]) {
    await page.locator('#interactive-editor').evaluate((element, size) => { (element as HTMLElement).style.width = `${size}px` }, width)
    await page.evaluate(() => window.interactiveRichEditor?.commands.updateAttributes('codeBlock', { language: 'typescript' }))
    const block = page.locator('#interactive-editor .rich-code-block')
    await expect.poll(() => block.evaluate(element => parseFloat((element as HTMLElement).style.getPropertyValue('--rich-code-language-width')))).toBeGreaterThan(0)
    const overlaps = await block.evaluate(element => {
      const picker = element.querySelector('.rich-code-language')!.getBoundingClientRect()
      const content = element.querySelector('.rich-code-block-content')!
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
      let count = 0
      while (walker.nextNode()) {
        const node = walker.currentNode
        for (let offset = 0; offset < (node.textContent?.length ?? 0); offset++) {
          const range = document.createRange()
          range.setStart(node, offset)
          range.setEnd(node, offset + 1)
          for (const box of range.getClientRects()) {
            if (box.width > 0 && box.left < picker.right && box.right > picker.left && box.top < picker.bottom && box.bottom > picker.top) count++
          }
        }
      }
      return count
    })
    expect(overlaps, `overlapping source characters at ${width}px`).toBe(0)
  }
})
