import { test, expect } from '@playwright/test'

// End-to-end coverage for the shared status colors (PLAN #65), exercised against
// the simulation server (internal/http/simulation.go). These confirm the <Badge>
// primitive + the consolidated tone tables actually paint the real DOM, not just
// the unit-tested helpers. The sim seeds, among others:
//   - agent-1 "Add renameable agent titles"      (claude, finished)
//   - agent-2 "Migrate auth providers to OAuth"   (gemini, needs_input, unread)
// Sidebar rows are <button>s (AgentSidebarItem); the status dot is the row's
// first rounded-full <span> and the status chip is the <Badge> carrying the label.

const PROJECT = '/project/sim-project/'

// Sidebar agent rows are real links to the agent page (AgentSidebarItem), not
// buttons - middle-click has to open them in a new tab.
function agentRow(page: import('@playwright/test').Page, title: string) {
  return page.locator('aside').getByRole('link', { name: new RegExp(title) })
}

test('sidebar status chips + dots take their status color', async ({ page }) => {
  await page.goto(PROJECT)

  // needs_input is the strong-red alert state: red-500 dot, red-100 chip.
  const needsInput = agentRow(page, 'Migrate auth providers to OAuth')
  await expect(needsInput).toBeVisible()
  await expect(needsInput.getByText('needs_input', { exact: true })).toHaveClass(/bg-red-100/)
  // The dot is the first rounded-full span (the unread dot, if any, comes after).
  await expect(needsInput.locator('span.rounded-full').first()).toHaveClass(/bg-red-500/)

  // finished is the violet end-of-run state: violet-500 dot, violet-100 chip.
  const finished = agentRow(page, 'Add renameable agent titles')
  await expect(finished.getByText('finished', { exact: true })).toHaveClass(/bg-violet-100/)
  await expect(finished.locator('span.rounded-full').first()).toHaveClass(/bg-violet-500/)
})

test('the agent detail header renders the brand-colored type pill', async ({ page }) => {
  await page.goto(PROJECT)
  await agentRow(page, 'Migrate auth providers to OAuth').click()
  await expect(page).toHaveURL(/\/project\/sim-project\/agent\/agent-2\b/)

  // The type pill is detail-only (the sidebar uses bare colored text for the
  // type) and ICON-ONLY - the label moved into its tooltip, so there is no
  // "gemini" text to match on. It is the first badge in the header meta strip
  // (AgentDetail MetaStrip, [data-meta-strip]); this asserts the
  // <Badge variant="pill"> + custom className path still paints the gemini
  // brand palette.
  const pill = page.locator('[data-meta-strip] span.rounded-full').first()
  await expect(pill).toBeVisible()
  await expect(pill).toHaveClass(/bg-violet-100/)
  // ...and the type it stands for is still reachable, via that tooltip.
  await pill.hover()
  await expect(page.getByRole('tooltip').filter({ hasText: 'gemini' })).toBeVisible()
})
