import { expect, test, type Locator, type Page } from '@playwright/test'

const PROJECT = '/project/sim-project/'

async function openComposer(page: Page): Promise<Locator> {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text())
  })
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
