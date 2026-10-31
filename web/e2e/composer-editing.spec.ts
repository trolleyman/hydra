import { expect, test, type Locator, type Page } from '@playwright/test'

const PROJECT = '/project/sim-project/'

const runtimeErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const errors: string[] = []
  runtimeErrors.set(page, errors)
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const url = message.location().url
    if (/\/uploads\/projects\/.*\/blob|\/folder-picker\/available/.test(url)) return
    errors.push(`${message.text()} (${url})`)
  })
})
test.afterEach(({ page }) => {
  expect(runtimeErrors.get(page), 'production composer runtime errors').toEqual([])
})

async function openComposer(page: Page): Promise<Locator> {
  const pageErrors = runtimeErrors.get(page) ?? []
  await page.goto(PROJECT)
  const showError = page.getByRole('button', { name: 'Show Error' })
  const composer = page.getByRole('textbox', { name: 'Describe a task' })
  await expect(composer.or(showError)).toBeVisible()
  if (await showError.isVisible()) {
    await showError.click()
    throw new Error(`application error before the composer mounted:\n${await page.locator('body').innerText()}\n${pageErrors.join('\n')}`)
  }
  return composer
}

test('the whole spawn prompt surface focuses the rich composer', async ({ page }) => {
  const composer = await openComposer(page)
  const bounds = await composer.boundingBox()
  expect(bounds).not.toBeNull()

  // The editable surface fills the prompt card, so clicking below its first
  // text line still places the caret in the editor.
  await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height - 4)
  await page.keyboard.type('typed from the bottom of the prompt')

  await expect(composer).toHaveText('typed from the bottom of the prompt')
  await expect(composer).toBeFocused()
})

test('Enter creates a new rich-text paragraph in the spawn prompt', async ({ page }) => {
  const composer = await openComposer(page)
  await composer.fill('first line')
  await composer.press('End')
  await composer.press('Enter')
  await page.keyboard.type('second line')

  await expect(composer.locator(':scope > p')).toHaveCount(2)
  await expect(composer.locator(':scope > p').nth(0)).toHaveText('first line')
  await expect(composer.locator(':scope > p').nth(1)).toHaveText('second line')
})

test('the slash menu inserts the default two-by-two header table', async ({ page }) => {
  const composer = await openComposer(page)
  await composer.fill('/table')
  const menu = page.getByRole('listbox', { name: 'Block commands' })
  await expect(menu).toBeVisible()
  await composer.press('Enter')

  await expect(composer.locator('table')).toBeVisible()
  await expect(composer.locator('th')).toHaveCount(2)
  await expect(composer.locator('td')).toHaveCount(2)
})

test('an attached image is an inline preview that opens and can be removed', async ({ page }) => {
  const composer = await openComposer(page)
  await composer.fill('before ')
  await composer.locator('xpath=ancestor::form').locator('input[type="file"]').setInputFiles({
    name: 'inline-preview.png',
    mimeType: 'image/png',
    buffer: Buffer.from('not decoded because the optimistic object URL is used'),
  })

  const chip = composer.locator('[data-composer-attachment]')
  await expect(chip).toContainText('inline-preview.png')
  await expect(chip.locator('img.composer-attachment-preview')).toBeVisible()

  await chip.click({ position: { x: 4, y: 4 } })
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()

  await page.getByRole('button', { name: 'Remove inline-preview.png' }).click()
  await expect(chip).toHaveCount(0)
  await expect(composer).toContainText('before')
})

async function openChatComposer(page: Page): Promise<Locator> {
  await page.goto(`${PROJECT}agent/agent-chat`)
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await expect(composer).toHaveAttribute('contenteditable', 'true')
  return composer
}

test('chat sends rich content once and starts a fresh focused history', async ({ page }) => {
  const composer = await openChatComposer(page)
  await composer.click()
  await page.keyboard.type('Check `editor` now')
  await expect(composer.locator('code')).toHaveText('editor')
  await composer.press('Enter')
  await expect(composer).toHaveText('')
  await expect(composer).toBeFocused()
  await composer.press('ControlOrMeta+z')
  await expect(composer).toHaveText('')
  const transcript = page.locator('[data-chat-scroll]')
  await expect(transcript.getByText('Check editor now', { exact: true })).toHaveCount(1)
})

test('chat multiline Enter can leave an empty list item', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('hydra-enter-sends', '0'))
  const composer = await openChatComposer(page)
  await composer.click()
  await page.keyboard.type('- first')
  await composer.press('Enter')
  await composer.press('Enter')
  await page.keyboard.type('after the list')
  await expect(composer.locator('li')).toHaveCount(1)
  await expect(composer.locator(':scope > p').first()).toHaveText('after the list')
})

test('IME confirmation cannot choose a discovery command', async ({ page }) => {
  const composer = await openComposer(page)
  await composer.fill('/table')
  await expect(page.getByRole('listbox', { name: 'Block commands' })).toBeVisible()
  await composer.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
  await expect(composer).toHaveText('/table')
  await expect(composer.locator('table')).toHaveCount(0)
})

test('removing a Spawn attachment stays removed after a reload', async ({ page }) => {
  const composer = await openComposer(page)
  await composer.fill('Keep this draft')
  await composer.press('End')
  await composer.locator('xpath=ancestor::form').locator('input[type="file"]').setInputFiles({
    name: 'draft-note.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment text'),
  })
  await expect(composer.locator('[data-composer-attachment]')).toBeVisible()
  await page.getByRole('button', { name: 'Remove draft-note.txt' }).click()
  await expect(composer.locator('[data-composer-attachment]')).toHaveCount(0)
  await page.reload()
  await expect(composer).toHaveText('Keep this draft')
  await expect(composer.locator('[data-composer-attachment]')).toHaveCount(0)
})

test('agent slash commands take precedence over block discovery', async ({ page }) => {
  const composer = await openChatComposer(page)
  await composer.fill('/co')
  await expect(page.getByRole('button', { name: '/compact', exact: true })).toBeVisible()
  await expect(page.getByRole('listbox', { name: 'Block commands' })).toHaveCount(0)
  await composer.press('Enter')
  await expect(composer).toHaveText('/compact ')
})

test('chat switches between the rich draft and shell source without losing input', async ({ page }) => {
  const composer = await openChatComposer(page)
  await composer.click()
  await page.keyboard.type('!pwd')
  const shell = page.locator('textarea[placeholder="Run a shell command..."]')
  await expect(shell).toHaveValue('!pwd')
  await shell.fill('')
  await expect(composer).toHaveAttribute('contenteditable', 'true')
  await expect(composer).toBeFocused()
  await page.keyboard.type('back to prose')
  await expect(composer).toHaveText('back to prose')
})

test('the Browser editor switch applies on reload and retains drafts and uploads', async ({ page }) => {
  const composer = await openComposer(page)
  await composer.fill('Keep this editor draft')
  await composer.press('End')
  await composer.locator('xpath=ancestor::form').locator('input[type=file]').setInputFiles({ name: 'toggle-note.txt', mimeType: 'text/plain', buffer: Buffer.from('saved upload') })
  await expect(composer.locator('[data-upload-state="uploaded"]')).toBeVisible()
  await page.goto('/project/sim-project/settings')
  await page.getByRole('tab', { name: 'Browser', exact: true }).click()
  const section = page.getByRole('heading', { name: 'Rich text editor', exact: true }).locator('xpath=../..')
  const toggle = section.getByRole('checkbox')
  await expect(toggle).toBeChecked()
  await section.getByText('Enabled', { exact: true }).click()
  await expect(toggle).not.toBeChecked()
  await expect(composer).toHaveAttribute('contenteditable', 'true')
  await page.reload()
  await expect(composer).toHaveJSProperty('tagName', 'TEXTAREA')
  await expect(composer).toHaveValue(/Keep this editor draft/)
  await expect(page.getByRole('button', { name: 'Remove toggle-note.txt' })).toBeVisible()
  await page.getByRole('tab', { name: 'Browser', exact: true }).click()
  await section.getByText('Disabled', { exact: true }).click()
  await expect(toggle).toBeChecked()
  await page.reload()
  await expect(composer).toHaveAttribute('contenteditable', 'true')
  await expect(composer).toContainText('Keep this editor draft')
  await expect(composer.locator('[data-composer-attachment]')).toHaveCount(1)
})

test('source-mode chat submits literal Markdown with native editing and a clean console', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('hydra-rich-text-editor', '0'))
  await page.goto(`${PROJECT}agent/agent-chat`)
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await expect(composer).toHaveJSProperty('tagName', 'TEXTAREA')
  await composer.fill('**source mode** with `code`')
  await composer.press('Enter')
  await expect(composer).toHaveValue('')
  await expect(page.locator('[data-chat-scroll]').getByText('source mode with code', { exact: true })).toHaveCount(1)
  await composer.press('ControlOrMeta+z')
  await expect(composer).toHaveValue('')
})

test('question notes use a visible source textarea when rich editing is disabled', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('hydra-rich-text-editor', '0'))
  await page.goto(`${PROJECT}agent/agent-ask`)
  await page.getByRole('button', { name: 'Add a note', exact: true }).first().click()
  const note = page.getByRole('textbox', { name: 'Note to go with your answer', exact: true }).first()
  await expect(note).toHaveJSProperty('tagName', 'TEXTAREA')
  await expect(note).toBeVisible()
  await note.fill('**Keep this note** in Markdown')
  await expect(note).toHaveValue('**Keep this note** in Markdown')
  expect((await note.boundingBox())!.height).toBeGreaterThan(12)
})


test.describe('phone composers', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  })

  for (const draft of ['', '## Saved task']) {
    test(`opens and edits a project task on iPhone with ${draft ? 'a saved' : 'an empty'} draft`, async ({ page }) => {
      await page.addInitScript((value) => {
        Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' })
        localStorage.setItem('hydra-prompt-draft-full-sim-project', value)
      }, draft)
      await page.goto(PROJECT)
      const composer = page.getByRole('textbox', { name: 'Describe what you need' })
      await expect(composer).toBeVisible()
      await expect(composer).toHaveText(draft.replace(/^## /, ''))
      await composer.tap()
      await page.keyboard.type(' edited')
      await expect(composer).toContainText('edited')
      await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0)
      await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /maximum-scale=1.0, user-scalable=no/)
    })
  }
})
