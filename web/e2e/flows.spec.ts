import { test, expect } from '@playwright/test'

// Behavioural smokes for the load-bearing sidebar flows, exercised against the
// simulation server (internal/http/simulation.go). The sim seeds a project
// "sim-project" (name "simulated-project") plus a second project "mobile-app",
// and a handful of agents — agent-1 ("Add renameable agent titles"), agent-2
// ("Migrate auth providers to OAuth", which carries the unread-changes dot),
// agent-md, agent-3, agent-approval. Selectors mirror the real markup:
//   - sidebar agent rows are <button>s whose accessible name starts with the
//     agent title (web/src/components/AgentComponents.tsx AgentSidebarItem)
//   - the unread dot is <span aria-label="unread changes"> on that row
//   - the project switcher is <button aria-label="Select project"> (__root.tsx)

const PROJECT = '/project/sim-project/'

// Pre-trust the simulated projects so the first-open "Trust this project?" modal
// (TrustProjectModal) — a fixed full-screen overlay that intercepts clicks —
// never blocks these flows. Trust is client-side localStorage keyed by project
// id (lib/storage StorageKeys.trustedProjects), so seeding it before the app
// boots dismisses the gate, exactly as the screenshot harness does.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('hydra-trusted-projects', '["sim-project","mobile-app"]')
    } catch {
      /* ignore */
    }
  })
})

// Locate a sidebar agent row by its (unique) title text. getByRole matches the
// regex against the row button's full accessible name, so the leading title is
// enough — no dependency on the trailing status/activity text.
function agentRow(page: import('@playwright/test').Page, title: string) {
  return page.locator('aside').getByRole('button', { name: new RegExp(title) })
}

test('opening an agent from the sidebar navigates to its detail view', async ({ page }) => {
  await page.goto(PROJECT)

  const row = agentRow(page, 'Add renameable agent titles')
  await expect(row).toBeVisible()
  await row.click()

  // URL reflects the opened agent…
  await expect(page).toHaveURL(/\/project\/sim-project\/agent\/agent-1\b/)
  // …and the detail view renders agent-1's seeded prompt (unique to the detail
  // page; the sidebar only shows the title + activity line).
  await expect(
    page.getByText('Let agents be renamed with a human-friendly title', { exact: false }),
  ).toBeVisible()
})

test('opening an unread agent clears its unread-changes dot', async ({ page }) => {
  // The auto-clear is gated on the page being foreground + focused
  // (usePageActive → document.hasFocus()), so make sure this page holds focus.
  await page.bringToFront()
  await page.goto(PROJECT)

  // agent-2 is the one seeded with has_unread_changes → exactly one unread dot.
  const dot = page.getByLabel('unread changes')
  await expect(dot).toHaveCount(1)
  await expect(dot).toBeVisible()

  await agentRow(page, 'Migrate auth providers to OAuth').click()
  await expect(page).toHaveURL(/\/project\/sim-project\/agent\/agent-2\b/)

  // Opening the agent optimistically marks it read, so the sidebar dot is gone.
  await expect(page.getByLabel('unread changes')).toHaveCount(0)
})

// ServiceHealthWarning (a useServerData site, PLAN #57) polls the selected
// project's service status and raises an amber warning when one has failed. The
// sim seeds mobile-app's "emu-pool" service as failed and every other project's
// as healthy (internal/http/simulation.go GetServices), so the warning's
// presence is a direct, per-project assertion on that data path.
test("a failed service raises the project's health warning", async ({ page }) => {
  await page.goto('/project/mobile-app/')
  await expect(page.getByLabel('service failure')).toBeVisible()
})

test('a healthy project shows no service-health warning', async ({ page }) => {
  await page.goto(PROJECT) // sim-project — its service pool is healthy
  // Wait for the agent list to paint so the project's data has loaded, then
  // assert the warning never appears for the healthy project.
  await expect(agentRow(page, 'Add renameable agent titles')).toBeVisible()
  await expect(page.getByLabel('service failure')).toHaveCount(0)
})

// Switching projects must re-key the warning: useServerData drops the previous
// project's data on a key change, so the failed-service warning seen on
// mobile-app must NOT linger after switching to the healthy sim-project.
test('the service-health warning is re-keyed when switching projects', async ({ page }) => {
  await page.goto('/project/mobile-app/')
  await expect(page.getByLabel('service failure')).toBeVisible()

  await page.getByRole('button', { name: 'Select project' }).click()
  await page.getByText('simulated-project', { exact: true }).click()

  await expect(page).toHaveURL(/\/project\/sim-project\b/)
  await expect(page.getByLabel('service failure')).toHaveCount(0)
})

// Integration coverage for PLAN #64b: the sidebar status dot is coloured by
// agentDotClass off the modern agent_status.status (AgentComponents.tsx). This
// drives the real simulated agents end-to-end and asserts the rendered dot class
// per status — guarding that the agent_status path (not the removed Docker
// session-state normaliser) is what reaches the DOM. The dot is the first
// rounded-full span inside the agent's sidebar row.
test('sidebar status dots are coloured from agent_status', async ({ page }) => {
  await page.goto(PROJECT)

  const dot = (title: string) =>
    agentRow(page, title).locator('span.rounded-full').first()

  // agent-md is running → green, agent-1 finished → violet, agent-2 needs_input
  // → red (see internal/http/simulation.go seeds).
  await expect(dot('Add inline markdown rendering')).toHaveClass(/bg-green-500/)
  await expect(dot('Add renameable agent titles')).toHaveClass(/bg-violet-500/)
  await expect(dot('Migrate auth providers to OAuth')).toHaveClass(/bg-red-500/)
})

test('the project switcher opens and lists the projects', async ({ page }) => {
  await page.goto(PROJECT)

  await page.getByRole('button', { name: 'Select project' }).click()

  // The sim seeds two projects; the dropdown lists each by name + path. The
  // second project's name and the first project's path appear only inside the
  // open dropdown (the trigger shows just the selected name), so asserting them
  // confirms the menu opened and is populated.
  await expect(page.getByText('mobile-app', { exact: true })).toBeVisible()
  await expect(page.getByText('/simulated/project', { exact: true })).toBeVisible()
})
