// Demo video recording (T-059; scripts/release/demo-video.mjs). Same harness as the browser tests and the local demo
// (seeded throwaway database, test-only OIDC provider, labelled SIMULATOR feed, recorded-contract broker, contract-fake
// CMMS and reasoning; apps/api serving the built web app), with the environment label naming the simulation on every
// page. It renders the video's still frames and records the operator console walk-through as a Playwright video. Runs
// only through `node scripts/release/demo-video.mjs` (UB_VIDEO_WORK names its work directory), never in `pnpm verify`.
import { defineConfig, devices } from '@playwright/test';

process.env.UB_E2E_ENVIRONMENT_LABEL ??= 'LOCAL DEMO - SIMULATED_INPUT + RECORDED_CONTRACT - NOT REAL';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.video\.ts$/,
  globalSetup: './e2e/support/stack.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 600_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: './test-results/video',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.UB_E2E_BASE_URL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
