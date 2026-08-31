import { test, expect } from '@playwright/test'

// End-to-end coverage for the project settings page, which composes the sections
// split out of SettingsComponents.tsx (#63a) - ThemeSection, TerminalSection,
// ConfigForm (sandbox policy), ArtifactsEditor and ServicesEditor - via the
// SettingsContent barrel. Exercised against the simulation server, whose
// GetConfig (internal/http/simulation.go) seeds a default pre-prompt, a network
// allow-list (api.anthropic.com, ...), one artifact script ("screenshots") and one
// service ("emu-pool"). Asserting each section renders its seeded data proves the
// re-homed components still mount and wire up through the barrel.

test('the settings page renders every split section with its seeded config', async ({ page }) => {
  await page.goto('/project/sim-project/settings')

  // The page splits its config across layer tabs (role="tab"): Project / Local /
  // User hold the config.toml layers, Browser the client-only preferences. The
  // Project tab is the default one, so the config sections below need no click.

  // ConfigForm (defaults / "All agents" tab): the pre-prompt textarea carries the
  // seeded default, and the sandbox policy exposes the allow-listed host.
  await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible()
  await expect(page.getByText('System Pre-Prompt')).toBeVisible()
  await expect(page.getByPlaceholder('Default pre-prompt')).toHaveValue('Default pre-prompt')
  await expect(page.getByRole('heading', { name: 'Sandbox Policy' })).toBeVisible()
  // The network allow-list, seeded with the sim's two hosts (simulation.go
  // AllowedHosts); the block-list below it has its own placeholder.
  await expect(page.getByPlaceholder('e.g. api.internal.example.com').first()).toHaveValue('api.internal.example.com')
  await expect(page.getByPlaceholder('e.g. *.tracker.io').first()).toHaveValue('*.tracker.io')

  // ArtifactsEditor + ServicesEditor, each with its one seeded entry.
  await expect(page.getByRole('heading', { name: 'Diff Artifacts' })).toBeVisible()
  await expect(page.getByPlaceholder('e.g. screenshots')).toHaveValue('screenshots')
  await expect(page.getByRole('heading', { name: 'Services', exact: true })).toBeVisible()
  await expect(page.getByPlaceholder('e.g. emu-pool')).toHaveValue('emu-pool')

  // Theme + Terminal: the client-only preference sections (shared.tsx
  // SettingSection heading + their own controls), which live on the Browser tab
  // - they are per-device, not part of any config.toml layer.
  await page.getByRole('tab', { name: 'Browser', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Theme', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible()

  // Experimental scroll behavior is isolated on its own default-off tab so it
  // can be tested independently from ordinary browser preferences.
  await page.getByRole('tab', { name: 'Feature flags', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Smooth chat wheel scrolling' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Custom scrollbars' })).toBeVisible()
  await expect(page.getByRole('checkbox')).toHaveCount(2)
  await expect(page.getByRole('checkbox').nth(0)).not.toBeChecked()
  await expect(page.getByRole('checkbox').nth(1)).not.toBeChecked()
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
