#!/usr/bin/env node
// T-060 backup / restore / migration verification (M14; OBSERVABILITY-OPERATIONS §9, infra/runbooks). A snapshot of a
// database records its applied migrations (name and checksum), a digest of its column catalogue and, for every table in
// the public schema, a row count and a sha256 over the rows' text in a stable order. A restore is verified by comparing
// the restored database's snapshot with the source's, and by checking the applied migrations against the committed
// checksum lock and the migration files (forward-only: every file applied, none edited, none unknown). The pg_dump /
// pg_restore drill that uses these functions is exercised by scripts/release/smoke.mjs against the compose database.
// This module only reads databases and files.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const HEX64 = /^[0-9a-f]{64}$/;
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

export async function snapshotDatabase(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const migrations = (await c.query(`SELECT name, checksum FROM schema_migrations ORDER BY name`)).rows;
    const cols = (
      await c.query(
        `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
      )
    ).rows;
    const schemaDigest = createHash('sha256').update(JSON.stringify(cols)).digest('hex');
    const names = (
      await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)
    ).rows.map((r) => r.tablename);
    const tables = {};
    for (const t of names) {
      const { rows } = await c.query(
        `SELECT count(*)::bigint AS n,
                encode(sha256(convert_to(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), ''), 'UTF8')), 'hex') AS d
           FROM ${ident(t)} x`,
      );
      tables[t] = { rows: Number(rows[0].n), digest: rows[0].d };
    }
    await c.query('COMMIT');
    return { schema: 'database-snapshot.v1', migrations, schemaDigest, tables };
  } finally {
    await c.end();
  }
}

export function compareSnapshots(a, b) {
  const differences = [];
  if (JSON.stringify(a.migrations) !== JSON.stringify(b.migrations)) differences.push({ kind: 'MIGRATIONS_DIFFER' });
  if (a.schemaDigest !== b.schemaDigest) differences.push({ kind: 'SCHEMA_DIFFERS' });
  for (const t of Object.keys(a.tables))
    if (!(t in b.tables)) differences.push({ kind: 'TABLE_MISSING', table: t });
    else if (a.tables[t].rows !== b.tables[t].rows || a.tables[t].digest !== b.tables[t].digest)
      differences.push({ kind: 'TABLE_CONTENT_DIFFERS', table: t });
  for (const t of Object.keys(b.tables)) if (!(t in a.tables)) differences.push({ kind: 'TABLE_ADDED', table: t });
  return { equal: differences.length === 0, differences };
}

/** Applied migrations against the committed lock and files: forward-only, none edited, none missing, none unknown. */
export function verifyMigrations(snapshot, root) {
  const dir = path.join(root, 'packages', 'data', 'migrations');
  const lock = JSON.parse(
    readFileSync(path.join(root, 'config', 'security', 'migration-checksums.json'), 'utf8'),
  ).migrations;
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const applied = new Map(snapshot.migrations.map((m) => [m.name, m.checksum]));
  const findings = [];
  for (const f of files) {
    const sum = createHash('sha256')
      .update(readFileSync(path.join(dir, f), 'utf8'))
      .digest('hex');
    if (lock[f] !== undefined && lock[f] !== sum) findings.push({ rule: 'MIGRATION_FILE_EDITED', file: f });
    if (!applied.has(f)) findings.push({ rule: 'MIGRATION_NOT_APPLIED', file: f });
    else if (applied.get(f) !== sum) findings.push({ rule: 'MIGRATION_CHECKSUM_MISMATCH', file: f });
  }
  for (const name of applied.keys())
    if (!files.includes(name)) findings.push({ rule: 'MIGRATION_UNKNOWN', file: name });
  return findings;
}

export function backupManifest({ dumpSha256, snapshot, sourceSha, takenAt }) {
  if (!HEX64.test(dumpSha256 ?? '')) throw new Error('dump sha256 required');
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) throw new Error('source sha required');
  return {
    schema: 'backup-manifest.v1',
    takenAt,
    sourceSha,
    dump: { format: 'pg_dump custom', sha256: dumpSha256 },
    migrations: snapshot.migrations,
    schemaDigest: snapshot.schemaDigest,
    tables: snapshot.tables,
  };
}

export const fileSha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// CLI used by the smoke drill inside the compose network (the database publishes no port):
//   node scripts/release/db-drill.mjs snapshot <url> | verify-migrations <url> <repo-root>
if (process.argv[1] && process.argv[1].endsWith('db-drill.mjs')) {
  const [cmd, url, root] = process.argv.slice(2);
  try {
    if (cmd === 'snapshot') console.log(JSON.stringify(await snapshotDatabase(url)));
    else if (cmd === 'verify-migrations') {
      const findings = verifyMigrations(await snapshotDatabase(url), root);
      console.log(JSON.stringify({ findings }));
      if (findings.length) process.exitCode = 1;
    } else {
      console.error('usage: db-drill.mjs snapshot <url> | verify-migrations <url> <repo-root>');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(JSON.stringify({ error: e?.code ?? 'DRILL_FAILED' }));
    process.exitCode = 1;
  }
}
