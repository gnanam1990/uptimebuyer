// M14 (INV-06, T-057) — the platform worker's per-tenant context issuer is not part of the general @uptimebuyer/data
// surface. It lives behind the `@uptimebuyer/data/worker` subpath, which ESLint lets only the worker application source
// import, and a structural scan proves no other source file reaches it. Like the broker subpath (M13), a general
// @uptimebuyer/data consumer can therefore not mint a worker context for an arbitrary tenant.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import * as data from '../src/index.js';
import { repoRoot } from './helpers.js';

const WORKER_SRC = 'apps/worker/src';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'test-results', 'playwright-report'].includes(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('M14 worker tenant context is narrowed to the worker (INV-06)', () => {
  it('is not exported from the general @uptimebuyer/data entry point', () => {
    expect(Object.keys(data)).not.toContain('forEachActiveTenant');
    expect(Object.keys(data)).not.toContain('issueWorkerContext');
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'packages/data/package.json'), 'utf8'));
    expect(pkg.exports['./worker']).toBe('./src/worker-context.ts');
  });

  it('is imported only by the worker application source', () => {
    const offenders: string[] = [];
    for (const root of ['apps', 'packages', 'edge', 'scripts', 'tests'])
      for (const f of sourceFiles(path.join(repoRoot, root))) {
        const rel = path.relative(repoRoot, f);
        const text = readFileSync(f, 'utf8');
        const reaches = /@uptimebuyer\/data\/worker\b/.test(text) || /worker-context(\.js|\.ts)?['"]/.test(text);
        const allowed =
          rel.startsWith(`${WORKER_SRC}/`) ||
          rel === 'packages/data/src/worker-context.ts' ||
          rel === 'packages/data/test/m14-worker-context-subpath.test.ts';
        if (reaches && !allowed) offenders.push(rel);
      }
    expect(offenders).toEqual([]);
  });

  it('ESLint refuses the subpath outside the worker and allows it inside', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const code = "import { forEachActiveTenant } from '@uptimebuyer/data/worker';\nexport { forEachActiveTenant };\n";
    for (const file of [
      'apps/api/src/__probe.ts',
      'packages/orders/src/__probe.ts',
      'apps/sensor-gateway/src/__probe.ts',
    ]) {
      const [r] = await eslint.lintText(code, { filePath: path.join(repoRoot, file) });
      expect(
        r!.messages.map((m) => m.ruleId),
        file,
      ).toContain('no-restricted-imports');
    }
    const [inside] = await eslint.lintText(code, { filePath: path.join(repoRoot, `${WORKER_SRC}/__probe.ts`) });
    expect(inside!.messages.filter((m) => m.ruleId === 'no-restricted-imports')).toEqual([]);
  });
});
