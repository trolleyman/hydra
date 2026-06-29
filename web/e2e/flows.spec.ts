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

test('a failed API mutation surfaces an error toast', async ({ page }) => {
  // Exercises the standardized error path (PLAN #61): the rename handler runs
  // through runWithToast, so a failing updateAgent must raise an error toast
  // prefixed "Failed to rename agent". The simulation server returns 501 for
  // updateAgent (UpdateAgent → WriteError "Not implemented in simulation mode"),
  // so any real rename attempt fails — exactly the case we want to assert on.
  await page.goto(PROJECT)
  await agentRow(page, 'Add renameable agent titles').click()
  await expect(page).toHaveURL(/\/project\/sim-project\/agent\/agent-1\b/)

  // The title is an always-mounted input (AgentTopBar) — read-only until focused.
  // Clicking enters edit mode; changing the text and pressing Enter calls
  // saveTitle → updateAgent (→ 501). Located by its stable aria-label (the
  // "Rename" tooltip drops off once editing starts).
  const titleInput = page.getByRole('textbox', { name: 'Agent title' })
  await expect(titleInput).toBeVisible()
  await titleInput.click()
  await titleInput.fill('Renamed during an e2e test')
  await titleInput.press('Enter')

  // The toast (Toaster renders each as role="status") carries the errorPrefix
  // from runWithToast, regardless of how the underlying message is formatted.
  const toast = page.getByRole('status').filter({ hasText: 'Failed to rename agent' })
  await expect(toast).toBeVisible()
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
