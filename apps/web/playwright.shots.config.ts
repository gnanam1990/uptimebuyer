// Design review screenshots (docs/design/before and docs/design/after). Same harness as the browser tests (seeded
// throwaway database, test-only OIDC provider, labelled SIMULATOR feed, apps/api serving the built web app) with the
// local-demo environment label, so every capture shows the simulation label. Runs only through
// `pnpm --filter @uptimebuyer/web exec playwright test -c playwright.shots.config.ts`, never in `pnpm verify`.
// UB_SHOTS_DIR names the output folder under docs/design (default: after).
import { defineConfig, devices } from '@playwright/test';

process.env.UB_E2E_ENVIRONMENT_LABEL ??= 'LOCAL DEMO - SIMULATED_INPUT + RECORDED_CONTRACT - NOT REAL';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.shots\.ts$/,
  globalSetup: './e2e/support/stack.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 600_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: './test-results/shots',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.UB_E2E_BASE_URL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
