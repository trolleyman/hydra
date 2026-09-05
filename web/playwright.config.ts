import { defineConfig, devices } from '@playwright/test'
import { platform } from 'node:os'
import { proxyLaunchOptions } from './scripts/lib/browserProxy'

// Smoke-test config. The webServer boots a real hydra binary in --simulation
// mode (mock data, no daemon) via e2e/serve.ts and the specs drive the actual
// built UI. Requires the frontend built first (web/dist) - see e2e/serve.ts.
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
    // launches inside Hydra's bwrap sandbox and in CI containers. The proxy makes
    // the specs render with the real webfonts inside a head, instead of silently
    // falling back (see scripts/lib/browserProxy.ts); the loopback bypass it
    // carries keeps the simulation server reachable directly.
    launchOptions: proxyLaunchOptions(),
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'], ...proxyLaunchOptions() },
      },
    },
    // The Linux desktop shell embeds WebKitGTK. Playwright's Linux WebKit build
    // is not the packaged shell, but it gives the composer a second WebKit
    // layout/editing engine in normal CI without adding a project on macOS or
    // Windows. Keep it focused on the engine-sensitive editor regressions; the
    // broader application flow suite remains Chromium's job.
    ...(platform() === 'linux'
      ? [{
          name: 'linux-webkit',
          testMatch: '**/composer-editing.spec.ts',
          use: { ...devices['Desktop Safari'] },
        }]
      : []),
  ],
  webServer: {
    command: 'node e2e/serve.ts',
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
