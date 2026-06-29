import { test, expect } from '@playwright/test'

// Smoke test: just confirm the simulation server boots and the app shell
// renders. Behavioural flow specs build on top of this once the pipeline is
// known-good.
test('app boots and renders the shell', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#root')).not.toBeEmpty()
})
