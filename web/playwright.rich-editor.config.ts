import { defineConfig, devices } from '@playwright/test'
import { proxyLaunchOptions } from './scripts/lib/browserProxy'

const port = process.env.RICH_EDITOR_E2E_PORT ?? '41838'
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './e2e/rich-editor-spike',
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
    launchOptions: proxyLaunchOptions(),
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'], ...proxyLaunchOptions() } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `aubx vite --config e2e/rich-editor-spike/vite.config.ts --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    timeout: 60_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
