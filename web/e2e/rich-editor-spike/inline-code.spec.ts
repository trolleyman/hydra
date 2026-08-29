import { expect, test, type Page } from '@playwright/test'

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
      snapshot: () => SpikeSnapshot
    }
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-rich-editor-spike]')).toBeVisible()
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
  expect(activeCode).toEqual([0, 1, 1, 1, 1, 0])
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

test('backtick inserts, accepts text, and exits an inline code node', async ({ page }) => {
  await reset(page, paragraph())
  await select(page, 1)
  await page.keyboard.type('`')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(code()), from: 2, parent: 'inlineCode' })

  await page.keyboard.type('foo')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(code('foo')), from: 5, parent: 'inlineCode' })

  await page.keyboard.type('`')
  expect(await snapshot(page)).toMatchObject({ doc: paragraph(code('foo')), from: 6, parent: 'paragraph' })
  await expect(page.locator('code[data-inline-code]')).toHaveText('foo')
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

test('copying code contents writes literal text', async ({ page, context }) => {
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
  expect(await snapshot(page)).toMatchObject({ from: 4, parent: 'inlineCode', activeCode: 1 })

  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2)
  expect(await snapshot(page)).toMatchObject({ from: 7, parent: 'inlineCode', activeCode: 1 })
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
