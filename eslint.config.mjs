import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Import boundaries (INV-06, INV-01/INV-14) shared by every block below. In flat config a later block replaces the
// whole rule for the files it matches, so each block lists every boundary that applies to it.
const BROKER = [
  {
    group: ['@uptimebuyer/kite-broker', '@uptimebuyer/kite-broker/*'],
    message: 'The Kite broker is not importable (INV-06).',
  },
  {
    group: ['**/apps/kite-broker/**', '**/kite-broker/src/**'],
    message: 'The Kite broker is not importable (INV-06).',
  },
];
const RECOVERY_HOOK = [
  {
    group: ['**/incidents/src/recovery', '**/incidents/src/recovery.js', '**/incidents/src/recovery.ts'],
    message:
      "M04's recovery hook is not importable (INV-01, INV-14): RECOVERED is reached only through packages/recovery/src/closeout.ts.",
  },
];
// M13: the broker's worker-context issuer is importable only by apps/kite-broker/src (INV-06, NFR-05).
const BROKER_CONTEXT = [
  {
    group: [
      '@uptimebuyer/data/broker',
      '**/data/src/broker-context',
      '**/data/src/broker-context.js',
      '**/data/src/broker-context.ts',
    ],
    message: 'The broker worker context is importable only by apps/kite-broker/src (INV-06).',
  },
];
// M13 SAST: product source never spawns processes or evaluates code (the Kite adapter's execFile is the one
// sanctioned exception, below).
const PROCESS_AND_VM = [
  { name: 'child_process', message: 'Product source may not spawn processes (M13 SAST).' },
  { name: 'node:child_process', message: 'Product source may not spawn processes (M13 SAST).' },
  { name: 'vm', message: 'Product source may not evaluate code (M13 SAST).' },
  { name: 'node:vm', message: 'Product source may not evaluate code (M13 SAST).' },
];
const imports = (patterns, paths = []) => ['error', { patterns, paths }];
const PRODUCT_SOURCE = [
  'apps/*/src/**/*.{ts,tsx,mts,mjs}',
  'packages/*/src/**/*.{ts,tsx,mts,mjs}',
  'edge/*/src/**/*.{ts,tsx,mts,mjs}',
];

export default tseslint.config(
  {
    ignores: [
      'tmp-t004-*/**',
      '**/dist/**',
      '**/coverage/**',
      'docs/spec/**',
      '**/node_modules/**',
      '**/test-results/**',
      '**/playwright-report/**',
    ],
  },
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
      'no-restricted-imports': imports([...BROKER, ...RECOVERY_HOOK, ...BROKER_CONTEXT]),
    },
  },
  // M13 SAST rules over product source (offline; ADR 0008 failure policy).
  {
    files: PRODUCT_SOURCE,
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-restricted-imports': imports([...BROKER, ...RECOVERY_HOOK, ...BROKER_CONTEXT], PROCESS_AND_VM),
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use node:crypto randomness in product source (M13 SAST).' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='rejectUnauthorized'][value.value=false]",
          message: 'TLS certificate verification may not be disabled (M13 SAST).',
        },
        {
          selector: "AssignmentExpression[left.property.name='NODE_TLS_REJECT_UNAUTHORIZED']",
          message: 'TLS certificate verification may not be disabled (M13 SAST).',
        },
        {
          selector: "CallExpression[callee.property.name='createHash'][arguments.0.value=/^(md5|sha1)$/i]",
          message: 'Weak hash algorithms are not allowed (M13 SAST).',
        },
        {
          selector: "CallExpression[callee.name='createHash'][arguments.0.value=/^(md5|sha1)$/i]",
          message: 'Weak hash algorithms are not allowed (M13 SAST).',
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Raw HTML sinks are not allowed (M13 SAST).',
        },
        {
          selector: 'AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]',
          message: 'Raw HTML sinks are not allowed (M13 SAST).',
        },
      ],
    },
  },
  // The broker may import itself and its worker context; it is still not allowed to reach M04's recovery hook.
  {
    files: ['apps/kite-broker/**'],
    rules: { 'no-restricted-imports': imports([...RECOVERY_HOOK, ...BROKER_CONTEXT]) },
  },
  {
    files: ['apps/kite-broker/src/**'],
    rules: { 'no-restricted-imports': imports([...RECOVERY_HOOK], PROCESS_AND_VM) },
  },
  // The Kite Passport adapter drives the provider CLI with execFile (argument vector, no shell): the one sanctioned
  // process spawn in product source.
  {
    files: ['apps/kite-broker/src/adapters/kite-passport.ts'],
    rules: { 'no-restricted-imports': imports([...RECOVERY_HOOK]) },
  },
  // The hook's home (M04 source and its test-only fake evaluator) and its single sanctioned caller keep only the
  // INV-06 broker boundaries.
  {
    files: ['packages/incidents/**', 'packages/recovery/src/closeout.ts'],
    rules: { 'no-restricted-imports': imports([...BROKER, ...BROKER_CONTEXT]) },
  },
  {
    files: ['packages/incidents/src/**', 'packages/recovery/src/closeout.ts'],
    rules: { 'no-restricted-imports': imports([...BROKER, ...BROKER_CONTEXT], PROCESS_AND_VM) },
  },
  // The operator web app runs in the browser (M12); it reaches the API only through @uptimebuyer/api-client.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
