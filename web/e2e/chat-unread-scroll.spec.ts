import { test, expect, type Page } from '@playwright/test'

// Opening an agent that has unread changes lands on the TOP of its last
// message, clear of the cards floating over the transcript (the sub-agent
// selector, the plan panel) - rather than pinned to the bottom, where a long
// reply shows only its last lines. See alignToLastMessage in AgentChat.tsx.
//
// The simulation's unread agents are terminal-mode ones, so the agents list is
// patched here to mark a CHAT agent unread instead; that is also what keeps the
// two cases (unread vs read) independent of the fixture data.

const CHAT_AGENT = 'agent-chat'
const READ_CHAT_AGENT = 'agent-chat-codex'

// Geometry of the transcript pane: where the last message sits inside it, and
// how far the floating cards reach down over its top edge.
async function transcriptGeometry(page: Page) {
  return await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-chat-message]')] as HTMLElement[]
    const pane = rows[0]?.closest('.overflow-y-auto') as HTMLElement | null
    if (!pane || rows.length === 0) return null
    const paneBox = pane.getBoundingClientRect()
    const lastBox = rows[rows.length - 1].getBoundingClientRect()
    const overlayBottom = [...(pane.parentElement?.querySelectorAll('[data-chat-overlay]') ?? [])].reduce(
      (low, card) => Math.max(low, card.getBoundingClientRect().bottom - paneBox.top),
      0,
    )
    return {
      lastMessageTop: lastBox.top - paneBox.top,
      paneHeight: paneBox.height,
      overlayBottom,
      scrollTop: pane.scrollTop,
      maxScroll: pane.scrollHeight - pane.clientHeight,
    }
  })
}

test.describe('opening an unread chat agent', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('hydra-trusted-projects', '["sim-project"]')
        window.localStorage.setItem('hydra-project-id', 'sim-project')
      } catch {
        /* ignore */
      }
    })
    // Exactly one chat agent carries the unread flag; the read-agent case below
    // uses the other one.
    await page.route('**/api/projects/*/agents', async (route) => {
      const res = await route.fetch()
      const list = await res.json()
      for (const a of list) a.has_unread_changes = a.id === CHAT_AGENT
      await route.fulfill({ response: res, json: list })
    })
    // The page marks the agent read on open; the sim doesn't implement it.
    await page.route('**/api/projects/*/agents/*/read', (route) => route.fulfill({ status: 200, body: '{}' }))
  })

  test('lands on the top of the last message, below the floating cards', async ({ page }) => {
    await page.goto(`/project/sim-project/agent/${CHAT_AGENT}`)

    await expect
      .poll(async () => (await transcriptGeometry(page))?.lastMessageTop ?? null, { timeout: 15_000 })
      .not.toBeNull()
    // Settle: markdown/highlighting land over the frames after the replay and
    // the alignment keeps up with them for a second.
    await page.waitForTimeout(1500)

    const geo = (await transcriptGeometry(page))!
    // The message starts just below whatever floats over the pane's top edge...
    expect(geo.lastMessageTop).toBeGreaterThanOrEqual(geo.overlayBottom)
    // ...and close to it, not somewhere down the middle of the pane.
    expect(geo.lastMessageTop).toBeLessThanOrEqual(geo.overlayBottom + 24)
    // Which, for this fixture's long reply, means NOT pinned to the bottom.
    expect(geo.maxScroll - geo.scrollTop).toBeGreaterThan(4)
    await expect(page.getByLabel('Jump to bottom')).toBeVisible()
  })

  test('an agent without unread changes still opens pinned to the bottom', async ({ page }) => {
    await page.goto(`/project/sim-project/agent/${READ_CHAT_AGENT}`)

    await expect
      .poll(async () => (await transcriptGeometry(page))?.lastMessageTop ?? null, { timeout: 15_000 })
      .not.toBeNull()
    await page.waitForTimeout(1500)

    const geo = (await transcriptGeometry(page))!
    expect(geo.maxScroll - geo.scrollTop).toBeLessThanOrEqual(4)
  })
})
