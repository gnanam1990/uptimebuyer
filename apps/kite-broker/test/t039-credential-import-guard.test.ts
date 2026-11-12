// T-039 — Credential and paid-egress isolation (code boundary). The credential-bearing broker code — paid adapters,
// secret configuration, the socket server — lives only in apps/kite-broker, exports nothing, and no other workspace
// package (API, workers, providers, planning, the model/SERV path, edge) imports it or its source files. ESLint
// enforces the same rule (no-restricted-imports); this test proves it over the repository as it is.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git']);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(ts|mts|mjs|js|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

describe('T-039 credential-bearing broker code is not importable outside apps/kite-broker', () => {
  it('no other package, app, edge agent, test or script references the broker package or its sources', () => {
    const roots = ['packages', 'apps', 'edge', 'scripts', 'tests', 'spikes'].map((d) => join(root, d));
    const offenders: string[] = [];
    for (const r of roots)
      for (const f of (() => {
        try {
          return files(r);
        } catch {
          return [];
        }
      })()) {
        const rel = relative(root, f);
        if (rel.startsWith(join('apps', 'kite-broker'))) continue;
        const text = readFileSync(f, 'utf8');
        if (/@uptimebuyer\/kite-broker|apps\/kite-broker|kite-broker\/src/.test(text)) offenders.push(rel);
      }
    expect(offenders).toEqual([]);
  });

  it('the broker package exports nothing but its manifest, so resolution fails from any other package', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'apps', 'kite-broker', 'package.json'), 'utf8'));
    expect(manifest.exports).toEqual({ './package.json': './package.json' });
    expect(manifest.main).toBeUndefined();
    const requireFromCommerce = createRequire(join(root, 'packages', 'commerce', 'package.json'));
    expect(() => requireFromCommerce.resolve('@uptimebuyer/kite-broker')).toThrow();
    // Every workspace package directory is checked; stray files such as macOS .DS_Store are not packages.
    const pkgs = readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, 'packages', d.name, 'package.json')))
      .map((d) => d.name);
    expect(pkgs.length).toBeGreaterThan(10);
    for (const pkg of pkgs) {
      const m = JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8'));
      expect(Object.keys({ ...m.dependencies, ...m.devDependencies }), pkg).not.toContain('@uptimebuyer/kite-broker');
    }
  });

  it('the only modules that construct TLS client credentials or spawn the kpass CLI are the broker adapters', () => {
    const hits = files(join(root, 'apps', 'kite-broker', 'src')).filter((f) =>
      /clientKey|kpassBinary/.test(readFileSync(f, 'utf8')),
    );
    expect(hits.map((f) => relative(join(root, 'apps', 'kite-broker', 'src'), f)).sort()).toEqual([
      'adapters/kite-passport.ts',
      'adapters/standin.ts',
      'config.ts',
      'factory.ts',
    ]);
  });
});
