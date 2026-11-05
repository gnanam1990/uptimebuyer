// T-060 (M14) backup/restore verification, database layer. The restore drill compares a restored database with its
// source: applied migrations (names and checksums, against the committed checksum lock and the migration files) and a
// content digest and row count of every table. A faithful copy compares equal; a changed row, a missing table or an
// edited migration checksum is reported. The pg_dump/pg_restore drill itself runs in `pnpm release:smoke`.
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../m00/helpers.js';

const drill = await import(path.join(repoRoot, 'scripts', 'release', 'db-drill.mjs'));
const db = await import(path.join(repoRoot, 'scripts', 'db.mjs'));

const base = process.env.DATABASE_URL;
const stamp = `${process.pid}_${Date.now()}`;
const names = { source: `ub_m14src_${stamp}`, copy: `ub_m14cpy_${stamp}` };
const urlFor = (name: string) => {
  const u = new URL(base!);
  u.pathname = `/${name}`;
  return u.toString();
};
const admin = async (sql: string) => {
  const c = new pg.Client({ connectionString: base });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
};

beforeAll(async () => {
  if (!base) throw new Error('DATABASE_URL must be set for integration tests (CI provides a Postgres service).');
  await admin(`CREATE DATABASE ${names.source}`);
  await db.migrate(urlFor(names.source));
  await db.seed(urlFor(names.source));
  const c = new pg.Client({ connectionString: urlFor(names.source) });
  await c.connect();
  await c.query(`INSERT INTO platform_info(key, value) VALUES ('m14-drill', 'source') ON CONFLICT (key) DO NOTHING`);
  await c.end();
  // A faithful restore stand-in: a template copy (byte-identical database).
  await admin(`CREATE DATABASE ${names.copy} TEMPLATE ${names.source}`);
});
afterAll(async () => {
  for (const n of Object.values(names)) await admin(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`).catch(() => {});
});

describe('T-060 restore verification', () => {
  it('a faithful copy matches its source: same migrations, same table digests, checksums agree with the lock', async () => {
    const a = await drill.snapshotDatabase(urlFor(names.source));
    const b = await drill.snapshotDatabase(urlFor(names.copy));
    expect(a.migrations.length).toBeGreaterThanOrEqual(24);
    expect(Object.keys(a.tables).length).toBeGreaterThan(50);
    expect(drill.compareSnapshots(a, b)).toEqual({ equal: true, differences: [] });
    expect(drill.verifyMigrations(b, repoRoot)).toEqual([]);
  });

  it('reports a changed row, a dropped table and an edited migration checksum', async () => {
    const before = await drill.snapshotDatabase(urlFor(names.source));
    const c = new pg.Client({ connectionString: urlFor(names.copy) });
    await c.connect();
    await c.query(`UPDATE platform_info SET value = 'tampered' WHERE key = 'm14-drill'`);
    await c.query(`CREATE TABLE m14_extra (x int)`);
    await c.query(
      `UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE name = (SELECT min(name) FROM schema_migrations)`,
    );
    await c.end();
    const after = await drill.snapshotDatabase(urlFor(names.copy));
    const cmp = drill.compareSnapshots(before, after);
    expect(cmp.equal).toBe(false);
    const kinds = cmp.differences.map((d: { kind: string; table?: string }) => `${d.kind}:${d.table ?? ''}`);
    expect(kinds).toEqual(
      expect.arrayContaining(['TABLE_CONTENT_DIFFERS:platform_info', 'TABLE_ADDED:m14_extra', 'MIGRATIONS_DIFFER:']),
    );
    const mig = drill.verifyMigrations(after, repoRoot).map((f: { rule: string }) => f.rule);
    expect(mig).toContain('MIGRATION_CHECKSUM_MISMATCH');
  });

  it('a backup manifest pins the dump file by sha256', async () => {
    const m = drill.backupManifest({
      dumpSha256: 'a'.repeat(64),
      snapshot: await drill.snapshotDatabase(urlFor(names.source)),
      sourceSha: 'b'.repeat(40),
      takenAt: new Date().toISOString(),
    });
    expect(m.schema).toBe('backup-manifest.v1');
    expect(m.dump.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.migrations.length).toBeGreaterThanOrEqual(24);
    expect(() => drill.backupManifest({ ...m, dumpSha256: 'nope' })).toThrow();
  });
});
