import { test, expect, type Page } from '@playwright/test'

// End-to-end coverage for the localStorage persistence that the storage cleanup
// (shared readJSON/writeJSON + createShardedStore) runs through. The unit tests
// in src/lib/storage.test.ts cover the helpers in isolation; these drive the
// real built UI against the simulation server (internal/http/simulation.go) to
// prove the round-trip survives a genuine reload - i.e. writeJSON stores a value
// that readJSON reads back through the app, not just in a test harness.
//
// The sim seeds project "sim-project" (name "simulated-project") with agent-1
// ("Add renameable agent titles") plus a working repository browser.

const PROJECT = '/project/sim-project/'
const PROJECT_VIEW_KEY = 'hydra-project-view-sim-project'

test.describe('project-view persistence (readJSON / writeJSON round-trip)', () => {
  // Seed the selected-project id so landing on "/" restores into this project,
  // exactly as the screenshot harness does. (No trust seeding: trust is decided
  // at add time now, so an already-added project never raises the gate.)
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('hydra-project-id', 'sim-project')
      } catch {
        /* ignore */
      }
    })
  })

  test('persists the opened view as well-formed JSON', async ({ page }) => {
    await page.goto(`${PROJECT}repository`)
    await expect(page).toHaveURL(/\/project\/sim-project\/repository\b/)

    // The stored value must be single-encoded JSON of the documented shape - a
    // direct check that writeJSON didn't double-encode or stash a raw string.
    // (Repository rather than agent view: see the restore test below for why.)
    // The persist effect runs just after the route settles, so poll for it.
    await expect
      .poll(async () => {
        const raw = await page.evaluate((k) => window.localStorage.getItem(k), PROJECT_VIEW_KEY)
        return raw ? JSON.parse(raw) : null
      })
      .toEqual({ view: '/repository' })
  })

  test('restores the last-open view after a reload from the root', async ({ page }) => {
    // Open the repository browser - the persist effect writes its project view to
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
      .toEqual({ view: '/repository' })

    // Land on the bare root: the boot restore reads the saved view back and
    // navigates into the remembered view rather than the spawn/landing page.
    await page.goto('/')
    await expect(page).toHaveURL(/\/project\/sim-project\/repository\b/, { timeout: 15_000 })
  })

  // Regression guard: switching projects used to persist the *new* project's
  // path under the *old* project's id (route params lag the location by a
  // render), wiping the memory of the project being left - so switching back
  // always dropped you on its spawn page. Non-agent views are used here because
  // a remembered agent with unread changes is deliberately deflected to the
  // project page (see restoreProjectView).
  for (const [what, path, expected] of [
    ['a deep repository file', 'repository/main/src/App.tsx', /\/project\/sim-project\/repository\/main\/src\/App\.tsx$/],
    ['the settings page', 'settings', /\/project\/sim-project\/settings$/],
  ] as const) {
    test(`restores ${what} after switching to another project and back`, async ({ page }) => {
      await page.goto(PROJECT + path)
      await expect(page).toHaveURL(expected)

      await switchProject(page, 'mobile-app')
      await expect(page).toHaveURL(/\/project\/mobile-app\b/)

      await switchProject(page, 'simulated-project')
      await expect(page).toHaveURL(expected)
    })
  }
})

// Pick a project from the header dropdown by its displayed name.
async function switchProject(page: Page, name: string): Promise<void> {
  await page.getByLabel('Select project').click()
  await page.getByText(name, { exact: true }).first().click()
}

test.describe('project trust gate (decided at add time)', () => {
  // Trust is no longer a persisted client-side list. __root.tsx decides it ONCE,
  // when a project is ADDED (handleAddProject reviews its .hydra/config.toml
  // before registering it, since registering starts its [[services]]), and
  // declining leaves nothing registered. So there is no trusted-projects entry
  // to round-trip, and an already-added project never re-prompts.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('hydra-project-id', 'sim-project')
      } catch {
        /* ignore */
      }
    })
  })

  test('an already-added project is never re-prompted', async ({ page }) => {
    await page.goto(PROJECT)
    await expect(page.getByRole('link', { name: /Add renameable agent titles/ })).toBeVisible()
    await expect(page.getByText('Trust this project?')).toHaveCount(0)

    // Still down after a reload - nothing is remembered because nothing is asked.
    await page.goto(PROJECT)
    await expect(page.getByText('Trust this project?')).toHaveCount(0)
  })

  test('adding a project raises the gate, and declining registers nothing', async ({ page }) => {
    // Any POST would be the registration (addProject); there must be none.
    const posts: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST') posts.push(r.url())
    })

    await page.goto(PROJECT)
    await page.getByLabel('Select project').click()
    // The native folder dialog isn't available headless, so ProjectDropdown
    // falls back to its manual absolute-path form.
    await page.getByRole('button', { name: 'Open folder...', exact: true }).click()
    const path = page.getByPlaceholder('/absolute/path')
    await path.fill('/tmp/an-untrusted-project')
    await path.press('Enter')

    // The gate comes up for the path being added, naming both choices.
    await expect(page.getByText('Trust this project?')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Trust project' })).toBeVisible()

    // Declining closes it and registers nothing.
    await page.getByRole('button', { name: "Don't trust" }).click()
    await expect(page.getByText('Trust this project?')).toHaveCount(0)
    expect(posts).toEqual([])
  })

  // A hand-typed path is shorthand: "~/x" (and a bare relative "x") mean
  // something only the server can work out, so the UI resolves it through
  // /api/resolve-path and shows - and trusts - the absolute result.
  test('a typed ~ path is expanded before the gate names it', async ({ page }) => {
    await page.goto(PROJECT)
    await page.getByLabel('Select project').click()
    await page.getByRole('button', { name: 'Open folder...', exact: true }).click()
    const path = page.getByPlaceholder('/absolute/path')
    await path.fill('~/an-untrusted-project')

    // The live preview under the input shows where that lands: an absolute
    // path, whatever this machine's home directory happens to be.
    const resolved = /^\/.+\/an-untrusted-project$/
    await expect(page.getByText(resolved)).toBeVisible()

    // ...and so does the trust prompt, rather than the "~/..." that was typed.
    await path.press('Enter')
    await expect(page.getByText('Trust this project?')).toBeVisible()
    await expect(page.getByRole('dialog').getByText(resolved)).toBeVisible()

    await page.getByRole('button', { name: "Don't trust" }).click()
    await expect(page.getByText('Trust this project?')).toHaveCount(0)
  })
})
