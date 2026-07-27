import { test, expect } from '@playwright/test'

// End-to-end coverage for the artifacts panel, whose still-image diff renderers
// and embedded xterm build-log viewer were lifted into sibling components
// (#63b: ArtifactImageDiff.tsx and ArtifactLogView.tsx). Driving the real agent
// detail page against the simulation server proves those re-homed components
// still mount and render inside ArtifactsPanel. The sim seeds agent-1 with a
// ready "screenshots" set (image diffs) and a failed "storybook" set whose build
// log auto-opens (see simArtifactSets in internal/http/simulation.go).

const AGENT = '/project/sim-project/agent/agent-1'

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
  // images are attached rather than visible - each mode keeps a visibility:hidden
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

test('a partially failed set colours each side by its own outcome', async ({ page }) => {
  await page.goto(AGENT)

  // The "dashboard" set settled with only its before (left) side failed, so its
  // build log auto-opens with the two sides coloured independently: red for the
  // failure, green for the side that finished clean. The mid-GENERATION variant
  // of this (a failed side whose drained live log + persisted URL make it look
  // like a clean finish) is guarded in src/components/ArtifactLogView.test.tsx -
  // the sim no longer has a set in that transient shape.
  const card = setCard(page, 'dashboard')
  await expect(card).toBeVisible()
  await card.click()

  const boxes = page.locator('div.max-h-64')
  await expect(boxes).toHaveCount(2)
  await expect(boxes.nth(0)).toHaveClass(/border-red-/)
  await expect(boxes.nth(0)).not.toHaveClass(/border-green-/)
  await expect(boxes.nth(1)).toHaveClass(/border-green-/)
})

test('a still-generating set keeps both sides neutral', async ({ page }) => {
  await page.goto(AGENT)

  // "components" is the in-flight set (both sides building while tiles stream
  // in), so neither log box claims an outcome yet - neutral grey, not green.
  const card = setCard(page, 'components')
  await expect(card).toBeVisible()
  await card.click()

  const boxes = page.locator('div.max-h-64')
  await expect(boxes).toHaveCount(2)
  await expect(boxes.nth(0)).not.toHaveClass(/border-(red|green)-/)
  await expect(boxes.nth(1)).not.toHaveClass(/border-(red|green)-/)
})
