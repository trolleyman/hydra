import { test, expect } from '@playwright/test'

// End-to-end coverage for the localStorage persistence that the storage cleanup
// (shared readJSON/writeJSON + createShardedStore) runs through. The unit tests
// in src/lib/storage.test.ts cover the helpers in isolation; these drive the
// real built UI against the simulation server (internal/http/simulation.go) to
// prove the round-trip survives a genuine reload — i.e. writeJSON stores a value
// that readJSON reads back through the app, not just in a test harness.
//
// The sim seeds project "sim-project" (name "simulated-project") with agent-1
// ("Add renameable agent titles") plus a working repository browser.

const PROJECT = '/project/sim-project/'
const PROJECT_VIEW_KEY = 'hydra-project-view-sim-project'
const TRUSTED_KEY = 'hydra-trusted-projects'

test.describe('project-view persistence (readJSON / writeJSON round-trip)', () => {
  // Pre-trust the project (so the Trust modal never intercepts clicks) and seed
  // the selected-project id so landing on "/" restores into this project — both
  // are plain localStorage seeds, exactly as the screenshot harness does.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('hydra-trusted-projects', '["sim-project","mobile-app"]')
        window.localStorage.setItem('hydra-project-id', 'sim-project')
      } catch {
        /* ignore */
      }
    })
  })

  test('persists the opened view as well-formed JSON', async ({ page }) => {
    await page.goto(`${PROJECT}repository`)
    await expect(page).toHaveURL(/\/project\/sim-project\/repository\b/)

    // The stored value must be single-encoded JSON of the documented shape — a
    // direct check that writeJSON didn't double-encode or stash a raw string.
    // (Repository rather than agent view: see the restore test below for why.)
    // The persist effect runs just after the route settles, so poll for it.
    await expect
      .poll(async () => {
        const raw = await page.evaluate((k) => window.localStorage.getItem(k), PROJECT_VIEW_KEY)
        return raw ? JSON.parse(raw) : null
      })
      .toEqual({ kind: 'repository', path: '' })
  })

  test('restores the last-open view after a reload from the root', async ({ page }) => {
    // Open the repository browser — the persist effect writes its project view to
    // localStorage. (The repository view is used rather than an agent view: an
    // agent landed-on directly races the agents-list load against the agent
    // route's one-shot "is this agent gone?" check, which is app behaviour
    // unrelated to the storage round-trip under test. The repository route has no
    // such correction, so it isolates loadProjectView/saveProjectView.)
    await page.goto(`${PROJECT}repository`)
    await expect(page).toHaveURL(/\/project\/sim-project\/repository\b/)

    // Wait until the persist effect has actually written the view: the boot
    // restore below races it, and reloading first would read a stale/empty value
    // and fall back to the bare project page.
    await expect
      .poll(async () => {
        const raw = await page.evaluate((k) => window.localStorage.getItem(k), PROJECT_VIEW_KEY)
        return raw ? JSON.parse(raw) : null
      })
      .toEqual({ kind: 'repository', path: '' })

    // Land on the bare root: the boot restore reads the saved view back and
    // navigates into the remembered view rather than the spawn/landing page.
    await page.goto('/')
    await expect(page).toHaveURL(/\/project\/sim-project\/repository\b/, { timeout: 15_000 })
  })
})

test.describe('trusted-projects persistence (readJSON / writeJSON round-trip)', () => {
  // Seed only the selected-project id here — NOT the trust list — so the Trust
  // modal actually appears and we can drive the trust → persist → read-back path
  // through the real UI.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('hydra-project-id', 'sim-project')
      } catch {
        /* ignore */
      }
    })
  })

  test('trusting a project survives a reload', async ({ page }) => {
    await page.goto(PROJECT)

    // First open: the gate is up because the project isn't trusted yet.
    await expect(page.getByText('Trust this project?')).toBeVisible()
    await page.getByRole('button', { name: 'Trust project' }).click()
    await expect(page.getByText('Trust this project?')).toHaveCount(0)

    // The decision is persisted as a JSON string array containing the project id.
    const stored = await page.evaluate((k) => window.localStorage.getItem(k), TRUSTED_KEY)
    expect(JSON.parse(stored!)).toContain('sim-project')

    // Reload: the trust list is read back, so the gate stays down.
    await page.goto(PROJECT)
    await expect(page.getByText('Trust this project?')).toHaveCount(0)
  })
})
