// T-001 (integration half) — the documented migrate/seed path works against an isolated real PostgreSQL database
// and refuses an edited, already-applied migration.
import { mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './helpers.js';

const base = process.env.DATABASE_URL;
const dbName = `ub_t001_${process.pid}_${Date.now()}`;
let url = '';

describe('T-001 migrate and seed an isolated database', () => {
  beforeAll(async () => {
    if (!base) throw new Error('DATABASE_URL must be set for integration tests (CI provides a Postgres service).');
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(base);
    u.pathname = `/${dbName}`;
    url = u.toString();
  });
  afterAll(async () => {
    if (!base) return;
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('applies every migration once, seeds idempotently, and rejects an edited applied migration', async () => {
    const { migrate, seed } = await import(path.join(repoRoot, 'scripts/db.mjs'));
    const first: string[] = await migrate(url);
    expect(first).toContain('0000_bootstrap.sql');
    expect(await migrate(url)).toEqual([]);
    await seed(url);
    await seed(url);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const { rows } = await c.query("SELECT value FROM platform_info WHERE key='seeded'");
    await c.end();
    expect(rows).toEqual([{ value: 'true' }]);

    const dir = mkdtempSync(path.join(tmpdir(), 'ub-mig-'));
    cpSync(path.join(repoRoot, 'packages/data/migrations'), dir, { recursive: true });
    writeFileSync(path.join(dir, '0000_bootstrap.sql'), '-- edited after apply\nSELECT 1;\n');
    await expect(migrate(url, dir)).rejects.toThrow(/Applied migration was edited/);
  });
});
