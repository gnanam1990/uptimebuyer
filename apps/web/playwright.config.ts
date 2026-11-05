// Playwright configuration for the M12 browser tests (T-049..T-052 and the bundle secret scan). One Chromium worker,
// serial, against the stack started by e2e/support/stack.ts (seeded throwaway database + apps/api serving the built
// bundle). Exact-pinned @playwright/test and @axe-core/playwright; Chromium is installed with
// `pnpm exec playwright install chromium` (CI: `--with-deps`).
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './e2e/support/stack.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.UB_E2E_BASE_URL,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
