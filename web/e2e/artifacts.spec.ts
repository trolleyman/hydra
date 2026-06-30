import { test, expect } from '@playwright/test'

// End-to-end coverage for the artifacts panel, whose still-image diff renderers
// and embedded xterm build-log viewer were lifted into sibling components
// (#63b: ArtifactImageDiff.tsx and ArtifactLogView.tsx). Driving the real agent
// detail page against the simulation server proves those re-homed components
// still mount and render inside ArtifactsPanel. The sim seeds agent-1 with a
// ready "screenshots" set (image diffs) and a failed "storybook" set whose build
// log auto-opens (see simArtifactSets in internal/http/simulation.go).

const AGENT = '/project/sim-project/agent/agent-1'

// Pre-trust the simulated project so the "Trust this project?" overlay can't
// intercept clicks — mirrors flows.spec.ts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('hydra-trusted-projects', '["sim-project","mobile-app"]')
    } catch {
      /* ignore */
    }
  })
})

// The artifact set cards default to collapsed and only appear once the artifacts
// WS/poll snapshot has populated the panel, so wait for the named header button
// then click it to expand. Mirrors the screenshot harness's showArtifacts step.
function setCard(page: import('@playwright/test').Page, name: string) {
  return page.locator('button', { hasText: name }).first()
}

test('the screenshots card expands to show the image diff renderers', async ({ page }) => {
  await page.goto(AGENT)

  const card = setCard(page, 'screenshots')
  await expect(card).toBeVisible()
  await card.click()

  // FileGrid → FileRow → ImageDiffView renders the seeded before/after files: a
  // filename label plus the actual tile <img>s (tiles carry data-mkey). Assert the
  // images are attached rather than visible — each mode keeps a visibility:hidden
  // sizer <img>, and tiles below the fold lazy-load, so attachment is the stable
  // signal that the renderer produced image elements.
  await expect(page.getByText('home.png', { exact: false })).toBeVisible()
  await expect(page.locator('[data-mkey] img').first()).toBeAttached()
})

test('a failed set surfaces its xterm build-log viewer', async ({ page }) => {
  await page.goto(AGENT)

  // storybook failed on both sides, so expanding the card auto-opens the build
  // log (PersistedLogView → LogView), which mounts an xterm.js terminal.
  const card = setCard(page, 'storybook')
  await expect(card).toBeVisible()
  await card.click()

  await expect(page.locator('.xterm').first()).toBeVisible()
})

test('a side that fails mid-generation gets the red border, not green', async ({ page }) => {
  await page.goto(AGENT)

  // The "components" set is still generating: its before (left) side already
  // exited 1 while the after (right) side keeps rendering (see simArtifactSets).
  // The failed side's live-log box must read as failed (red border + faint red
  // wash), NOT clean-finish green — the bug was that a drained live log with a
  // persisted URL but no error was mistaken for success.
  const card = setCard(page, 'components')
  await expect(card).toBeVisible()
  await card.click()

  // Only the expanded components card renders log boxes (collapsed cards render no
  // body), so the two LogView terminals (max-h-64) are its Before/After panes in
  // order. The failed before side is red; the still-generating after side stays
  // neutral grey (not green — it hasn't finished).
  const boxes = page.locator('div.max-h-64')
  await expect(boxes).toHaveCount(2)
  await expect(boxes.nth(0)).toHaveClass(/border-red-/)
  await expect(boxes.nth(0)).not.toHaveClass(/border-green-/)
  await expect(boxes.nth(1)).not.toHaveClass(/border-(red|green)-/)
})
