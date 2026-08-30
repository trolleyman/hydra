import { expect, test } from '@playwright/test'
import { settleScreenshot } from '../scripts/lib/screenshotReady'

test('screenshot settling cannot capture a theme transition midway', async ({ page }) => {
  await page.setContent(`
    <style>
      #surface { width: 20px; height: 20px; background: rgb(255, 255, 255); transition: background 10s linear; }
      .dark #surface { background: rgb(0, 0, 0); }
    </style>
    <div id="surface"></div>
  `)
  await page.evaluate(() => document.documentElement.classList.add('dark'))

  await settleScreenshot(page)

  await expect(page.locator('#surface')).toHaveCSS('background-color', 'rgb(0, 0, 0)')
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
})
