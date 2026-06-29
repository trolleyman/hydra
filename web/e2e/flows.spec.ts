import { test, expect } from '@playwright/test'

// Behavioural smokes for the load-bearing sidebar flows, exercised against the
// simulation server (internal/http/simulation.go). The sim seeds a project
// "sim-project" (name "simulated-project") plus a second project "mobile-app",
// and a handful of agents — agent-1 ("Add renameable agent titles", which
// carries the blue unread-changes dot), agent-2 ("Migrate auth providers to
// OAuth", which is needs_input → red needs-input dot), agent-md, agent-3,
// agent-approval. Selectors mirror the real markup:
//   - sidebar agent rows are <button>s whose accessible name starts with the
//     agent title (web/src/components/AgentComponents.tsx AgentSidebarItem)
//   - the blue unread dot is <span aria-label="unread changes"> on that row;
//     the red needs-input dot is <span aria-label="needs your input">
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

  // agent-1 is the one seeded with has_unread_changes (and a non-needs_input
  // status) → exactly one blue unread dot.
  const dot = page.getByLabel('unread changes')
  await expect(dot).toHaveCount(1)
  await expect(dot).toBeVisible()

  await agentRow(page, 'Add renameable agent titles').click()
  await expect(page).toHaveURL(/\/project\/sim-project\/agent\/agent-1\b/)

  // Opening the agent optimistically marks it read, so the sidebar dot is gone.
  await expect(page.getByLabel('unread changes')).toHaveCount(0)
})

test('the red needs-input dot stays lit when its agent is opened', async ({ page }) => {
  // Unlike the blue unread dot, the red needs-input marker is driven by the live
  // status (agent-2 is needs_input), so it is NOT cleared by opening the agent —
  // it clears on its own once the agent is answered. Two agents need input
  // (agent-2 + agent-approval), so the dot count holds across the open.
  await page.bringToFront()
  await page.goto(PROJECT)

  // agent-2's sidebar row carries the red needs-input dot before it's opened…
  const row = agentRow(page, 'Migrate auth providers to OAuth')
  await expect(row.getByLabel('needs your input')).toBeVisible()

  await row.click()
  await expect(page).toHaveURL(/\/project\/sim-project\/agent\/agent-2\b/)

  // …and it's still there after opening (the dot is status-driven, so opening
  // doesn't clear it — only answering the agent does).
  await expect(row.getByLabel('needs your input')).toBeVisible()
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
