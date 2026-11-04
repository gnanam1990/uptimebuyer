#!/usr/bin/env node
// Forward-only, checksum-verified SQL migration runner. Each module adds numbered files under
// packages/data/migrations through the M02 owner; an edited, already-applied migration is a hard error.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'packages', 'data');

export function requireDatabaseUrl(env = process.env) {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (see .env.example); refusing to guess a database.');
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('DATABASE_URL must be a postgres:// URL');
  return url;
}

const sqlFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();

export async function migrate(url, dir = path.join(dataDir, 'migrations')) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
    const done = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const file of sqlFiles(dir)) {
      const sql = readFileSync(path.join(dir, file), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      if (done.has(file)) {
        if (done.get(file) !== sum) throw new Error(`Applied migration was edited: ${file}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [file, sum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${error.message}`, { cause: error });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    await client.end();
  }
  return applied;
}

export async function seed(url, dir = path.join(dataDir, 'seeds')) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const file of sqlFiles(dir)) await client.query(readFileSync(path.join(dir, file), 'utf8'));
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith('db.mjs')) {
  const cmd = process.argv[2];
  try {
    const url = requireDatabaseUrl();
    if (cmd === 'migrate') console.log(JSON.stringify({ applied: await migrate(url) }));
    else if (cmd === 'seed') {
      await seed(url);
      console.log(JSON.stringify({ seeded: true }));
    } else throw new Error('usage: db.mjs migrate|seed');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
