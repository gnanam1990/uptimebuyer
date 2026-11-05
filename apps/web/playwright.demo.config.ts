// Local SIMULATED demo (M14, T-059 screenshots). Same harness as the browser tests (seeded throwaway database, test-only
// OIDC provider, labelled SIMULATOR feed, recorded-contract broker, contract-fake CMMS; apps/api serving the built web
// app), with an environment label that names the simulation on every page. Runs only through `pnpm demo:local`, never
// in `pnpm verify`. Its screenshots are registered as simulated artifacts so the real-input journey gate refuses them.
import { defineConfig, devices } from '@playwright/test';

process.env.UB_E2E_ENVIRONMENT_LABEL ??= 'LOCAL DEMO - SIMULATED_INPUT + RECORDED_CONTRACT - NOT REAL';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.demo\.ts$/,
  globalSetup: './e2e/support/stack.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: './test-results/demo',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 860 },
    baseURL: process.env.UB_E2E_BASE_URL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
