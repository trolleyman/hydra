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

test.beforeEach(async ({ page }) => {
  // Pre-trust the sim projects so the Trust modal doesn't intercept clicks (see
  // flows.spec.ts for the rationale).
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('hydra-trusted-projects', '["sim-project","mobile-app"]')
    } catch {
      /* ignore */
    }
  })
})

function agentRow(page: import('@playwright/test').Page, title: string) {
  return page.locator('aside').getByRole('button', { name: new RegExp(title) })
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

  // The rounded-full pill is detail-only (the sidebar uses bare colored text for
  // the type), so this uniquely targets the <Badge variant="pill"> with its
  // gemini brand palette - proving the pill + custom className path renders.
  const pill = page.locator('span.rounded-full', { hasText: 'gemini' })
  await expect(pill).toBeVisible()
  await expect(pill).toHaveClass(/bg-violet-100/)
})
