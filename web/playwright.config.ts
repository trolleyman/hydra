import { defineConfig, devices } from '@playwright/test'

// Smoke-test config. The webServer boots a real hydra binary in --simulation
// mode (mock data, no daemon) via e2e/serve.ts and the specs drive the actual
// built UI. Requires the frontend built first (web/dist) — see e2e/serve.ts.
const port = process.env.E2E_PORT ?? '41825'
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL,
    headless: true,
    // Chromium's own sandbox needs user namespaces; disable it so the browser
    // launches inside Hydra's bwrap sandbox and in CI containers.
    launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun e2e/serve.ts',
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
