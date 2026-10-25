import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Retries are OFF. A quality-records app must not have its acceptance
  // evidence laundered by a retry: a test that passes only on attempt 2 is a
  // flaky test, and that is a finding, not a pass.
  retries: 0,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    // Plant operators use small Android phones and tablets (PRD NFR-004).
    { name: 'plant-tablet', use: { ...devices['Galaxy Tab S4'] } },
    { name: 'small-phone', use: { ...devices['Galaxy S9+'] } },
  ],
  webServer: {
    // Preview the real production build, including the GitHub Pages base path,
    // so UAT exercises what actually ships (Master Prompt §10).
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { VITE_BASE_PATH: process.env.VITE_BASE_PATH ?? '/' },
  },
});
