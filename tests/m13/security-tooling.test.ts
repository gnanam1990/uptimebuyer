// M13 security tooling (NFR-05, NFR-12; SECURITY.md §11): offline SAST through ESLint security rules, a dependency
// and license check against the committed lockfile, a migration lint (NULL-safe RAISE guards per ADR 0004, applied
// migration checksums, tenant composite keys, no destructive DDL) and the existing secret scan, all wired into
// `pnpm verify`. Nothing is uploaded anywhere; fixtures are temporary directories.
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { repoRoot, run, write } from '../m00/helpers.js';

type Finding = { rule: string; file?: string; detail?: string };
const lint = await import(path.join(repoRoot, 'scripts', 'migration-lint.mjs'));
const deps = await import(path.join(repoRoot, 'scripts', 'deps-check.mjs'));
const migrationsDir = path.join(repoRoot, 'packages', 'data', 'migrations');
const rulesOf = (f: Finding[]) => f.map((x) => x.rule).sort();

describe('M13 migration lint (ADR 0004)', () => {
  it('passes on the committed migrations (CLI exit 0)', () => {
    const r = run('node', ['scripts/migration-lint.mjs']);
    expect(r.stderr + r.stdout).not.toContain('FINDING');
    expect(r.code).toBe(0);
  });

  it('flags NULL-unsafe guard shapes and accepts the NULL-safe ones', () => {
    const f = (sql: string) => rulesOf(lint.lintMigrationSql('9100_m13_probe.sql', sql));
    expect(f(`IF NOT (a = b OR c = d) THEN RAISE EXCEPTION 'x' USING ERRCODE = 'UB001'; END IF;`)).toEqual([
      'NULL_UNSAFE_NEGATED_GUARD',
    ]);
    expect(f(`IF NOT ub_check(NEW.x) THEN RAISE EXCEPTION 'x' USING ERRCODE = 'UB001'; END IF;`)).toEqual([
      'NULL_UNSAFE_NEGATED_GUARD',
    ]);
    expect(f(`IF NEW.x NOT IN (SELECT y FROM t) THEN RAISE EXCEPTION 'x' USING ERRCODE = 'UB001'; END IF;`)).toEqual([
      'NULL_UNSAFE_NOT_IN',
    ]);
    expect(
      f(`IF coalesce(a = b, false) IS NOT TRUE THEN RAISE EXCEPTION 'x' USING ERRCODE = 'UB001'; END IF;`),
    ).toEqual([]);
    expect(f(`IF NOT EXISTS (SELECT 1) THEN RAISE EXCEPTION 'x' USING ERRCODE = 'UB001'; END IF;`)).toEqual([]);
    expect(f(`IF NOT FOUND THEN RAISE EXCEPTION 'x' USING ERRCODE = 'UB001'; END IF;`)).toEqual([]);
    expect(f(`IF a IS DISTINCT FROM b THEN RAISE EXCEPTION 'x' USING ERRCODE = 'UB001'; END IF;`)).toEqual([]);
    expect(f(`-- IF NOT (a = b) THEN\nSELECT 1;`)).toEqual([]);
  });

  it('requires an ERRCODE on every RAISE EXCEPTION, composite tenant keys, and no destructive DDL', () => {
    const f = (sql: string) => rulesOf(lint.lintMigrationSql('9100_m13_probe.sql', sql));
    expect(f(`BEGIN RAISE EXCEPTION 'no code'; END;`)).toEqual(['RAISE_WITHOUT_ERRCODE']);
    expect(f(`CREATE TABLE widgets (tenant_id text NOT NULL, id text NOT NULL, PRIMARY KEY (id));`)).toEqual([
      'TENANT_TABLE_WITHOUT_COMPOSITE_KEY',
    ]);
    expect(f(`CREATE TABLE widgets (tenant_id text NOT NULL, id text NOT NULL, PRIMARY KEY (tenant_id, id));`)).toEqual(
      [],
    );
    expect(f(`DROP TABLE widgets;`)).toEqual(['DESTRUCTIVE_DDL']);
    expect(f(`ALTER TABLE widgets DROP COLUMN note;`)).toEqual(['DESTRUCTIVE_DDL']);
    expect(f(`TRUNCATE widgets;`)).toEqual(['DESTRUCTIVE_DDL']);
    expect(rulesOf(lint.lintMigrationSql('20_bad_name.sql', 'SELECT 1;'))).toEqual(['FILE_NAME']);
  });

  it('detects an edited applied migration and an unlocked new migration through the checksum lock', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ub-m13-mig-'));
    cpSync(migrationsDir, dir, { recursive: true });
    expect(rulesOf(lint.lintMigrations(dir))).toEqual([]);
    const victim = path.join(dir, '0006_m02_privacy_lifecycle.sql');
    writeFileSync(victim, readFileSync(victim, 'utf8') + '\n-- edited after apply\n');
    writeFileSync(path.join(dir, '9999_m13_unlocked.sql'), 'SELECT 1;\n');
    expect(rulesOf(lint.lintMigrations(dir))).toEqual(['CHECKSUM_CHANGED', 'NOT_IN_CHECKSUM_LOCK']);
  });
});

describe('M13 dependency and license check (offline, lockfile)', () => {
  it('passes on the repository (CLI exit 0)', () => {
    const r = run('node', ['scripts/deps-check.mjs']);
    expect(r.stderr + r.stdout).not.toContain('FINDING');
    expect(r.code).toBe(0);
  });

  it('flags range specifiers, lockfile drift, disallowed licenses and advisories', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ub-m13-deps-'));
    write(dir, 'package.json', JSON.stringify({ name: 'root', private: true, dependencies: { left: '^1.0.0' } }));
    write(dir, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    write(
      dir,
      'packages/a/package.json',
      JSON.stringify({ name: '@fx/a', dependencies: { right: '2.0.0', drift: '1.0.0' } }),
    );
    write(
      dir,
      'pnpm-lock.yaml',
      [
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      left:',
        '        specifier: ^1.0.0',
        '        version: 1.2.0',
        '',
        '  packages/a:',
        '    dependencies:',
        '      right:',
        '        specifier: 2.0.0',
        '        version: 2.0.0',
        '      drift:',
        '        specifier: 0.9.0',
        '        version: 0.9.0',
        '',
        'packages:',
        '',
        "  'left@1.2.0':",
        '    resolution: {integrity: sha512-x}',
        '',
        "  'right@2.0.0':",
        '    resolution: {integrity: sha512-y}',
        '',
        "  'drift@0.9.0':",
        '    resolution: {integrity: sha512-z}',
        '',
      ].join('\n'),
    );
    write(dir, 'node_modules/.pnpm/left@1.2.0/node_modules/left/package.json', JSON.stringify({ license: 'MIT' }));
    write(
      dir,
      'node_modules/.pnpm/right@2.0.0/node_modules/right/package.json',
      JSON.stringify({ license: 'AGPL-3.0' }),
    );
    write(dir, 'node_modules/.pnpm/drift@0.9.0/node_modules/drift/package.json', JSON.stringify({ license: 'MIT' }));
    const findings: Finding[] = deps.checkDependencies(dir, {
      licensePolicy: { allowed: ['MIT'], reviewedExceptions: [] },
      advisories: [{ id: 'FIXTURE-1', package: 'left', versions: ['1.2.0'], severity: 'high' }],
    });
    expect(rulesOf(findings)).toEqual(['ADVISORY_MATCH', 'LICENSE_NOT_ALLOWED', 'LOCKFILE_DRIFT', 'RANGE_SPECIFIER']);
  });
});

describe('M13 SAST through ESLint security rules', () => {
  const probe = async (code: string, filePath = 'packages/data/src/__sast_probe.ts') => {
    const eslint = new ESLint({ cwd: repoRoot });
    const [res] = await eslint.lintText(code, { filePath: path.join(repoRoot, filePath) });
    return res!.messages.map((m) => m.ruleId ?? 'fatal');
  };

  it.each([
    ['eval', 'export const f = (s: string) => eval(s);', 'no-eval'],
    ['Function constructor', "export const f = new Function('return 1');", 'no-new-func'],
    ['implied eval', "setTimeout('alert(1)', 1);", 'no-implied-eval'],
    ['child_process', "import { exec } from 'node:child_process';\nexport { exec };", 'no-restricted-imports'],
    ['vm', "import vm from 'node:vm';\nexport { vm };", 'no-restricted-imports'],
    ['TLS verification off', 'export const o = { rejectUnauthorized: false };', 'no-restricted-syntax'],
    [
      'weak hash',
      "import { createHash } from 'node:crypto';\nexport const h = createHash('md5');",
      'no-restricted-syntax',
    ],
    ['Math.random', 'export const n = Math.random();', 'no-restricted-properties'],
    ['TLS env override', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';", 'no-restricted-syntax'],
  ])('flags %s in product source', async (_name, code, rule) => {
    expect(await probe(code)).toContain(rule);
  });

  it('keeps the INV-06 broker import boundary and the sanctioned child_process use in the Kite adapter', async () => {
    expect(await probe("import '@uptimebuyer/kite-broker';")).toContain('no-restricted-imports');
    const adapter = readFileSync(path.join(repoRoot, 'apps/kite-broker/src/adapters/kite-passport.ts'), 'utf8');
    expect(await probe(adapter, 'apps/kite-broker/src/adapters/kite-passport.ts')).toEqual([]);
  });
});

describe('M13 security gates are wired into verify and CI', () => {
  it('runs lint (SAST), the security checks and the secret scan in pnpm verify', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts['security:check']).toBe('node scripts/migration-lint.mjs && node scripts/deps-check.mjs');
    const steps = String(pkg.scripts.verify)
      .split('&&')
      .map((s: string) => s.trim());
    for (const s of ['pnpm lint', 'pnpm security:check', 'pnpm secrets:scan']) expect(steps).toContain(s);
    const ci = readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('pnpm bootstrap');
    const adr = readFileSync(path.join(repoRoot, 'docs/adr/0008-testing-security-observability.md'), 'utf8');
    expect(adr).toContain('## Security tooling failure policy');
    expect(readdirSync(path.join(repoRoot, 'config', 'security')).sort()).toEqual(
      ['advisories.json', 'license-policy.json', 'migration-checksums.json', 'migration-lint-baseline.json'].sort(),
    );
  });
});
