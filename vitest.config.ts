import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'tests/**/*.test.ts',
            'packages/*/test/**/*.test.ts',
            'apps/*/test/**/*.test.ts',
            'edge/*/test/**/*.test.ts',
          ],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/**/*.int.test.ts', 'packages/*/test/**/*.int.test.ts', 'apps/*/test/**/*.int.test.ts'],
          exclude: ['**/node_modules/**'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
