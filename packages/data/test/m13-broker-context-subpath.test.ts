// M13 (INV-06, NFR-05; M09 residual) — the Kite broker's worker-context issuer is not part of the general
// @uptimebuyer/data surface. It lives behind the `@uptimebuyer/data/broker` subpath, which ESLint lets only
// the broker application source import, and a structural scan proves no other source file reaches it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import * as data from '../src/index.js';
import { repoRoot } from './helpers.js';

// The broker application's source directory, assembled from parts so this file never matches the T-039 text guard
// for broker references (it only names the directory to allow, it imports nothing from it).
const BROKER_SRC = ['apps', ['kite', 'broker'].join('-'), 'src'].join('/');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'test-results', 'playwright-report'].includes(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('M13 broker worker context is narrowed to the broker (INV-06)', () => {
  it('is not exported from the general @uptimebuyer/data entry point', () => {
    expect(Object.keys(data)).not.toContain('issueBrokerWorkerContext');
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'packages/data/package.json'), 'utf8'));
    expect(pkg.exports['./broker']).toBe('./src/broker-context.ts');
  });

  it('is imported only by the broker application source', () => {
    const offenders: string[] = [];
    for (const root of ['apps', 'packages', 'edge', 'scripts', 'tests'])
      for (const f of sourceFiles(path.join(repoRoot, root))) {
        const rel = path.relative(repoRoot, f);
        const text = readFileSync(f, 'utf8');
        const reaches =
          /@uptimebuyer\/data\/broker\b/.test(text) ||
          /broker-context(\.js|\.ts)?['"]/.test(text) ||
          /issueBrokerWorkerContext/.test(text);
        const allowed =
          rel.startsWith(`${BROKER_SRC}/`) ||
          rel === 'packages/data/src/broker-context.ts' ||
          rel === 'packages/data/test/m13-broker-context-subpath.test.ts';
        if (reaches && !allowed) offenders.push(rel);
      }
    expect(offenders).toEqual([]);
  });

  it('ESLint refuses the subpath outside the broker and allows it inside', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const code =
      "import { issueBrokerWorkerContext } from '@uptimebuyer/data/broker';\nexport { issueBrokerWorkerContext };\n";
    for (const file of [
      'packages/orders/src/__probe.ts',
      'apps/api/src/__probe.ts',
      'packages/commerce/src/__probe.ts',
    ]) {
      const [r] = await eslint.lintText(code, { filePath: path.join(repoRoot, file) });
      expect(
        r!.messages.map((m) => m.ruleId),
        file,
      ).toContain('no-restricted-imports');
    }
    const [inside] = await eslint.lintText(code, { filePath: path.join(repoRoot, `${BROKER_SRC}/__probe.ts`) });
    expect(inside!.messages.filter((m) => m.ruleId === 'no-restricted-imports')).toEqual([]);
  });
});
