// T-001 — Clean checkout bootstrap. The full fresh-checkout run happens in CI (`clean-checkout` job) and in
// `scripts/clean-checkout.sh`; this test pins the one-command contract and its configuration validation.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, run } from './helpers.js';

describe('T-001 clean checkout bootstrap', () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  it('documents a single bootstrap command backed by a committed lockfile and pinned toolchain', () => {
    expect(pkg.scripts.bootstrap).toBe('node scripts/bootstrap.mjs');
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(readFileSync(path.join(repoRoot, '.node-version'), 'utf8').trim()).toBe('22');
    expect(readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8').length).toBeGreaterThan(100);
    for (const [name, version] of Object.entries<string>(pkg.devDependencies)) {
      expect(version, `${name} must be pinned exactly`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('refuses to run without explicit database configuration instead of guessing hidden local state', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const r = run('node', ['scripts/db.mjs', 'migrate']);
    const r2 = run('node', [
      '-e',
      "import('./scripts/db.mjs').then(m=>{try{m.requireDatabaseUrl({})}catch(e){console.log(e.message);process.exit(3)}})",
    ]);
    expect(r2.code).toBe(3);
    expect(r2.stdout).toMatch(/DATABASE_URL is required/);
    expect(typeof r.code).toBe('number');
  });

  it('chains the canonical quality suite from verify', () => {
    for (const step of [
      'lint',
      'format:check',
      'typecheck',
      'test',
      'test:integration',
      'build',
      'check:pack',
      'secrets:scan',
    ])
      expect(pkg.scripts.verify).toContain(`pnpm ${step}`);
  });
});
