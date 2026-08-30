import { expect, test } from '@playwright/test'

test('the rich-text lab edits a GFM table and keeps Markdown synchronized', async ({ page }) => {
  await page.goto('/project/sim-project/settings')
  await page.getByRole('tab', { name: 'Rich text lab' }).click()

  const editor = page.getByLabel('Rich text editor demo')
  const table = editor.locator('table')
  await expect(table).toBeVisible()
  await expect(table.locator('tr')).toHaveCount(3)
  await expect(table.locator('tr').first().locator('th')).toHaveCount(2)

  await table.locator('td').first().click()
  await page.getByRole('button', { name: 'Add row below' }).click()
  await expect(table.locator('tr')).toHaveCount(4)
  await page.getByRole('button', { name: 'Add column right' }).click()
  await expect(table.locator('tr').first().locator('th')).toHaveCount(3)

  await expect(page.getByLabel('Current Markdown composer demo')).toHaveValue(/\| Surface\s+\|.*Format/)
})
