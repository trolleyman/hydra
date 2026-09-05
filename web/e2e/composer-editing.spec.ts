import { test, expect, type Locator, type Page } from '@playwright/test'

const PROJECT = '/project/sim-project/'

async function openComposer(page: Page): Promise<Locator> {
  await page.goto(PROJECT)
  const textarea = page.getByPlaceholder('Describe a task...')
  await expect(textarea).toBeVisible()
  // Give every engine the same narrow wrapping surface, independent of the
  // outer browser viewport or sidebar width.
  await textarea.evaluate((el) => {
    const wrapper = el.parentElement
    if (wrapper) wrapper.style.width = '360px'
  })
  return textarea
}

type GlyphRect = { left: number; right: number; top: number; bottom: number }

// Return the visible backdrop rectangle for one source character. The backdrop
// may split markdown into several spans, so walk text nodes rather than assuming
// the value is one node. Its final synthetic newline is deliberately ignored.
async function backdropGlyph(textarea: Locator, offset: number): Promise<GlyphRect> {
  return textarea.evaluate((el, wanted) => {
    const backdrop = el.previousElementSibling as HTMLElement
    const walker = document.createTreeWalker(backdrop, NodeFilter.SHOW_TEXT)
    let remaining = wanted
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (remaining < length) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.setEnd(node, remaining + 1)
        const rect = range.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      }
      remaining -= length
    }
    throw new Error(`backdrop has no glyph at source offset ${wanted}`)
  }, offset)
}

async function visualLineStarts(textarea: Locator, length: number): Promise<number[]> {
  const starts = [0]
  let previous = await backdropGlyph(textarea, 0)
  for (let offset = 1; offset < length; offset++) {
    const current = await backdropGlyph(textarea, offset)
    if (current.top > previous.top + 1) starts.push(offset)
    previous = current
  }
  return starts
}

async function openPersistedScrollableDraft(page: Page, value: string): Promise<Locator> {
  let textarea = await openComposer(page)
  await textarea.fill(value)
  // Reload the saved draft so it becomes the field's initial value, outside the
  // native undo stack. A later Ctrl+Z then targets only the user edit under test.
  await expect.poll(() => page.evaluate(() => {
    return Object.entries(localStorage).some(([, stored]) => stored.includes('line 40'))
  })).toBe(true)
  await page.reload()
  textarea = page.getByPlaceholder('Describe a task...')
  await expect(textarea).toHaveValue(value)
  await expect.poll(() => textarea.evaluate((el: HTMLTextAreaElement) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(100)
  await textarea.evaluate((el: HTMLTextAreaElement) => {
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.scrollTop = el.scrollHeight
  })
  await expect.poll(() => textarea.evaluate((el: HTMLTextAreaElement) => el.scrollTop)).toBeGreaterThan(100)
  return textarea
}

test('Home lands at the first character of the current wrapped line', async ({ page }) => {
  const textarea = await openComposer(page)
  const value = 'a'.repeat(180)
  await textarea.fill(value)
  const starts = await visualLineStarts(textarea, value.length)
  expect(starts.length).toBeGreaterThan(2)

  const secondStart = starts[1]
  await textarea.evaluate((el: HTMLTextAreaElement, caret) => {
    el.focus()
    el.setSelectionRange(caret, caret)
  }, secondStart + 5)
  await textarea.press('Home')

  await expect.poll(() => textarea.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(secondStart)
})

test('repeated End advances across wrapped segments of an unbroken token', async ({ page }) => {
  test.fail(true, 'Known regression: repeated End stalls at an unbroken-token wrap')
  const textarea = await openComposer(page)
  const value = 'a'.repeat(180)
  await textarea.fill(value)
  const starts = await visualLineStarts(textarea, value.length)
  expect(starts.length).toBeGreaterThan(2)

  await textarea.evaluate((el: HTMLTextAreaElement) => {
    el.focus()
    el.setSelectionRange(5, 5)
  })
  await textarea.press('End')
  const firstEnd = await textarea.evaluate((el: HTMLTextAreaElement) => el.selectionStart)
  await textarea.press('End')
  const secondEnd = await textarea.evaluate((el: HTMLTextAreaElement) => el.selectionStart)

  expect(firstEnd).toBeGreaterThan(5)
  expect(secondEnd).toBeGreaterThan(firstEnd)
})

test('clicking the highlighted glyph edits that source character at a wrap', async ({ page }) => {
  const textarea = await openComposer(page)
  const value = '1. pressing end from any line goes to the end of that line, but then it does not go to t'
  await textarea.fill(value)
  const target = value.length - 1
  const rect = await backdropGlyph(textarea, target)

  await page.mouse.click(rect.right - 1, (rect.top + rect.bottom) / 2)
  await expect.poll(() => textarea.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(target + 1)
})

test('paste preserves the composer scroll position', async ({ page, context, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright cannot seed the Linux WebKit system clipboard')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const value = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
  const textarea = await openPersistedScrollableDraft(page, value)
  await page.evaluate(() => navigator.clipboard.writeText(' pasted'))
  const before = await textarea.evaluate((el: HTMLTextAreaElement) => el.scrollTop)

  await textarea.press('Control+v')
  await expect(textarea).toHaveValue(value + ' pasted')
  const afterPaste = await textarea.evaluate((el: HTMLTextAreaElement) => el.scrollTop)
  expect(afterPaste).toBeGreaterThanOrEqual(before - 2)
})

test('undo preserves the composer scroll position', async ({ page, browserName }) => {
  test.fail(browserName === 'webkit', 'Known Linux WebKit regression: undo resets textarea scrollTop to zero')
  const value = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
  const textarea = await openPersistedScrollableDraft(page, value)
  await textarea.press('x')
  await expect(textarea).toHaveValue(value + 'x')
  const before = await textarea.evaluate((el: HTMLTextAreaElement) => el.scrollTop)

  await textarea.press('Control+z')
  await expect(textarea).toHaveValue(value)
  const afterUndo = await textarea.evaluate((el: HTMLTextAreaElement) => el.scrollTop)
  expect(afterUndo).toBeGreaterThanOrEqual(before - 2)
})
