import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['tmp-t004-*/**', '**/dist/**', '**/coverage/**', 'docs/spec/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      // INV-06: the credential-bearing broker (adapters, secret config) is importable only inside apps/kite-broker.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@uptimebuyer/kite-broker', '@uptimebuyer/kite-broker/*'],
              message: 'The Kite broker is not importable (INV-06).',
            },
            {
              group: ['**/apps/kite-broker/**', '**/kite-broker/src/**'],
              message: 'The Kite broker is not importable (INV-06).',
            },
            {
              group: ['**/incidents/src/recovery', '**/incidents/src/recovery.js', '**/incidents/src/recovery.ts'],
              message:
                "M04's recovery hook is not importable (INV-01, INV-14): RECOVERED is reached only through packages/recovery/src/closeout.ts.",
            },
          ],
        },
      ],
    },
  },
  // The broker may import itself; it is still not allowed to reach M04's recovery hook.
  {
    files: ['apps/kite-broker/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/incidents/src/recovery', '**/incidents/src/recovery.js', '**/incidents/src/recovery.ts'],
              message: "M04's recovery hook is not importable (INV-01, INV-14).",
            },
          ],
        },
      ],
    },
  },
  // The hook's home (M04 source and its test-only fake evaluator) and its single sanctioned caller keep only the
  // INV-06 broker boundary.
  {
    files: ['packages/incidents/**', 'packages/recovery/src/closeout.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@uptimebuyer/kite-broker', '@uptimebuyer/kite-broker/*'],
              message: 'The Kite broker is not importable (INV-06).',
            },
            {
              group: ['**/apps/kite-broker/**', '**/kite-broker/src/**'],
              message: 'The Kite broker is not importable (INV-06).',
            },
          ],
        },
      ],
    },
  },
);
