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
          ],
        },
      ],
    },
  },
  { files: ['apps/kite-broker/**'], rules: { 'no-restricted-imports': 'off' } },
);
