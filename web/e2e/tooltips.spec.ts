import { test, expect } from '@playwright/test'

// E2E coverage for the unified Tooltip (PLAN #62), exercised in a real browser
// against the simulation server. Both variants share one component but render
// and behave differently, so each is driven through the actual UI:
//   - dark variant  → the sidebar collapse button's hover hint (__root.tsx).
//   - card variant  → a Settings InfoTooltip (SettingsComponents.tsx), which is
//     hover-interactive: the pointer can travel into the card without it
//     dismissing.
// Both tooltips portal to <body>, so they're asserted as page-level text rather
// than as descendants of their trigger.

test('dark tooltip appears on hover and clears when the pointer leaves', async ({ page }) => {
  await page.goto('/project/sim-project/')

  // The sidebar collapse button. Its aria-label is "Hide sidebar"; the tooltip
  // adds the "(Ctrl+.)" shortcut, so that parenthetical is unique to the hint.
  const button = page.getByRole('button', { name: 'Hide sidebar' })
  await expect(button).toBeVisible()

  const tip = page.getByText('Hide sidebar (Ctrl+.)')
  await expect(tip).toHaveCount(0)

  await button.hover()
  // Shown after the hover delay (Playwright's expect polls past it).
  await expect(tip).toBeVisible()

  // Non-interactive: moving the pointer off the trigger removes the hint.
  await page.mouse.move(10, 400)
  await expect(tip).toHaveCount(0)
})

test('card tooltip shows its info card and stays open while hovered', async ({ page }) => {
  await page.goto('/project/sim-project/settings')

  // The "Sandbox Policy" section header carries an InfoTooltip (title "OS
  // Sandbox"). Its trigger is a real <button> wrapping the lucide Info icon -
  // it needs a 20px hit target and keyboard focus - named "<title> help" by
  // InfoTooltip, which is the stable handle for it.
  await expect(page.locator('h3', { hasText: 'Sandbox Policy' })).toBeVisible()
  const icon = page.getByRole('button', { name: 'OS Sandbox help' })

  const title = page.getByText('OS Sandbox', { exact: true })
  await expect(title).toHaveCount(0)

  await icon.hover()
  await expect(title).toBeVisible()
  // Body content lives in the same card.
  await expect(page.getByText('Agents run on the host inside an OS sandbox', { exact: false })).toBeVisible()

  // Interactive: hovering onto the card itself keeps it open (the grace period +
  // the card's own mouseenter cancel the pending dismiss).
  await title.hover()
  await expect(title).toBeVisible()
})
