import { test, expect } from '@playwright/test'
import { shotSelectors } from '../scripts/screenshots/pages.ts'

// Preflight for the screenshot generator's click/hover targets.
//
// These selectors are the one part of the artifact pipeline that rots silently.
// A UI change moves a control, the selector matches nothing, Playwright waits its
// full 30s, and the shot is dropped with a single "✗" line in a build log. It has
// happened twice: `button[title="..."]` died when the tooltip convention moved
// native titles off interactive controls, and `svg.lucide-git-compare` died when
// the icon became GitCompareArrows - weeks apart, both silent, both only noticed
// when someone read the log.
//
// This runs the same interactions against the same simulation server the
// generator uses, and asserts each control RESOLVES. It deliberately does not
// screenshot anything: the question is only "does the thing we click still
// exist", which is exactly what breaks.
//
// The selector list is imported, never copied - a duplicate here would rot in the
// same way, one step removed.
//
// Failures are fast by design: FIND_TIMEOUT is short, so a stale selector costs
// a couple of seconds rather than the generator's 30s, and the whole preflight
// stays cheap enough to run on every e2e pass.
//
// The FIRST selector in a chain gets a much longer budget than the rest, and the
// difference is not a fudge - the two waits are for different things. Selector 1
// races the app's first paint AND its opening data fetch (the tests panel has to
// have its verdict before there is an "eslint" button to click), so its wait is
// bounded by how fast the machine is. Every selector after it waits only for a
// dropdown to open in a page that has already loaded, which is fast on any
// machine or genuinely broken. Two shots (tests-panel-running-indeterminate,
// tests-merge-gate) failed on a loaded build box at 2500ms and passed in 300-900ms
// unloaded: a single short budget was measuring the machine, not the selector.
const FIND_TIMEOUT = 2500
const FIRST_FIND_TIMEOUT = 15_000

const shots = shotSelectors()

test.describe('screenshot generator selectors', () => {
  // One test per shot so a failure names the shot AND the selector, rather than
  // one giant test that stops at the first break and hides the rest.
  for (const shot of shots) {
    test(`${shot.name} can find what it clicks`, async ({ page }) => {
      // Head-room for the longest chain (4) at its own budgets, plus the boot.
      test.setTimeout(40_000)
      // Match the shot's own viewport: a mobile shot's hamburger simply does not
      // exist in the desktop layout, so checking it at the default width would
      // fail for a reason that has nothing to do with the selector rotting.
      if (shot.viewport) await page.setViewportSize(shot.viewport)
      await page.goto(shot.path)
      // The selectors are a CHAIN: the second only exists once the first has been
      // clicked (open a dropdown, then pick from it). So walk them in order,
      // asserting each resolves before acting on it - the same order the
      // generator uses, minus the capture.
      for (const [i, selector] of shot.selectors.entries()) {
        const timeout = i === 0 ? FIRST_FIND_TIMEOUT : FIND_TIMEOUT
        const target = page.locator(selector).first()
        await expect(target, `selector ${i + 1}/${shot.selectors.length} (${selector}) matched nothing - the control it names has moved or been renamed`)
          .toBeVisible({ timeout })
        // Act on it so the next selector in the chain has something to find.
        // Hover-only shots name a hover target; clicking one is harmless here
        // (nothing is captured), and it keeps this loop uniform.
        // Same budget as the find: a click that times out here is swallowed, and
        // the chain's NEXT selector then fails for a reason that is not its own.
        await target.click({ timeout }).catch(() => { /* the assertion above is the check */ })
      }
    })
  }

  // A guard on the guard: if the import ever yields nothing (the list moved, the
  // shape changed), every test above silently vanishes and this suite would pass
  // by doing nothing at all.
  test('the shot list is non-empty', () => {
    expect(shots.length).toBeGreaterThan(20)
  })
})
