import { test, expect } from '@playwright/test'

// End-to-end coverage for the project settings page, which composes the sections
// split out of SettingsComponents.tsx (#63a) - ThemeSection, TerminalSection,
// ConfigForm (sandbox policy), ArtifactsEditor and ServicesEditor - via the
// SettingsContent barrel. Exercised against the simulation server, whose
// GetConfig (internal/http/simulation.go) seeds a default pre-prompt, a network
// allow-list (api.anthropic.com, ...), one artifact script ("screenshots") and one
// service ("emu-pool"). Asserting each section renders its seeded data proves the
// re-homed components still mount and wire up through the barrel.

// Pre-trust the simulated project so the first-open "Trust this project?" overlay
// (TrustProjectModal) can't intercept clicks - mirrors flows.spec.ts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('hydra-trusted-projects', '["sim-project","mobile-app"]')
    } catch {
      /* ignore */
    }
  })
})

test('the settings page renders every split section with its seeded config', async ({ page }) => {
  await page.goto('/project/sim-project/settings')

  // Theme + Terminal: the two client-only preference sections (shared.tsx
  // SettingSection heading + their own controls).
  await expect(page.getByRole('heading', { name: 'Theme', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible()

  // ConfigForm (defaults / "All agents" tab): the pre-prompt textarea carries the
  // seeded default, and the sandbox policy exposes the allow-listed host.
  await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible()
  await expect(page.getByText('System Pre-Prompt')).toBeVisible()
  await expect(page.getByPlaceholder('Default pre-prompt')).toHaveValue('Default pre-prompt')
  await expect(page.getByRole('heading', { name: 'Sandbox Policy' })).toBeVisible()
  await expect(page.getByPlaceholder('e.g. api.anthropic.com').first()).toHaveValue('api.anthropic.com')

  // ArtifactsEditor + ServicesEditor, each with its one seeded entry.
  await expect(page.getByRole('heading', { name: 'Diff Artifacts' })).toBeVisible()
  await expect(page.getByPlaceholder('e.g. screenshots')).toHaveValue('screenshots')
  await expect(page.getByRole('heading', { name: 'Services', exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('e.g. emu-pool')).toHaveValue('emu-pool')
})

test('switching the agent tab swaps in that agent’s ConfigForm', async ({ page }) => {
  await page.goto('/project/sim-project/settings')

  // The "All agents" defaults are shown first (the pre-prompt is the first textarea).
  await expect(page.getByPlaceholder('Default pre-prompt')).toHaveValue('Default pre-prompt')

  // Pick the Claude agent in the selector (settings/SettingsContent AgentSelector).
  await page.getByRole('button', { name: 'Claude', exact: true }).click()

  // Its override pre-prompt (seeded as "Claude pre-prompt") now fills the form.
  await expect(page.getByPlaceholder('Default pre-prompt')).toHaveValue('Claude pre-prompt')
})
