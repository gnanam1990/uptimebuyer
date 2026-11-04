// Spike-only vitest config; the root vitest projects intentionally do not include spikes/.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { root: import.meta.dirname, include: ['test/**/*.test.mjs'], testTimeout: 30_000 },
});
