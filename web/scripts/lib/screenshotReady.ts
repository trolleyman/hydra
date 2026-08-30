import type { BrowserContext, Page } from 'playwright'

export type ScreenshotTheme = 'light' | 'dark'

// Seed the app's real theme preference before any page code runs. A fresh
// context per theme avoids capturing the CSS transition between two live theme
// states and keeps non-CSS consumers (for example xterm) in sync with the DOM.
export async function seedScreenshotTheme(context: BrowserContext, theme: ScreenshotTheme, storageKey = 'hydra-theme-mode') {
  await context.addInitScript(({ key, mode }) => {
    try {
      localStorage.setItem(key, mode)
    } catch {
      // A screenshot should still render when storage is unavailable.
    }
  }, { key: storageKey, mode: theme })
}

const FROZEN_MOTION_CSS =
  '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'

// Freeze CSS and Web Animations, wait for fonts, then cross two paint frames.
// Use this immediately before any one-off screenshot, especially if the script
// had to change visual state on an already-loaded page.
export async function settleScreenshot(page: Page) {
  await page.addStyleTag({ content: FROZEN_MOTION_CSS })
  await page.evaluate(async () => {
    for (const animation of document.getAnimations()) {
      try {
        animation.finish()
      } catch {
        // Infinite animations have no end state to finish at.
        animation.cancel()
      }
    }
    await document.fonts.ready
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
}
