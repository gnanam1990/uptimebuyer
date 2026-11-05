#!/usr/bin/env node
// Migration lint (M13; ADR 0004, ADR 0008). Offline static checks over packages/data/migrations:
// - FILE_NAME / DUPLICATE_NUMBER: forward-only NNNN_<module>_<topic>.sql naming with unique numbers;
// - CHECKSUM_CHANGED / NOT_IN_CHECKSUM_LOCK / MISSING_LOCKED_MIGRATION: applied migrations are immutable — every file
//   is pinned in config/security/migration-checksums.json and a new file must be added there deliberately
//   (`--update-lock`, reviewed in the same change);
// - NULL_UNSAFE_NEGATED_GUARD / NULL_UNSAFE_NOT_IN: RAISE guards must be NULL-safe (ADR 0004);
// - RAISE_WITHOUT_ERRCODE: every RAISE EXCEPTION carries a stable SQLSTATE;
// - TENANT_TABLE_WITHOUT_COMPOSITE_KEY: a tenant-owned table is keyed (tenant_id, ...);
// - DESTRUCTIVE_DDL: no DROP TABLE / DROP COLUMN / TRUNCATE / DROP SCHEMA in a migration.
// Findings in files audited before M13 are listed with a reason in config/security/migration-lint-baseline.json;
// anything else fails. Exit 1 on any finding. Nothing leaves the machine.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = path.join(repo, 'packages', 'data', 'migrations');
const LOCK = path.join(repo, 'config', 'security', 'migration-checksums.json');
const BASELINE = path.join(repo, 'config', 'security', 'migration-lint-baseline.json');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** Remove `--` line comments and block comments (string literals containing `--` are rare in DDL and only loosen). */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
}

/** The text of each `CREATE TABLE name (...)` body, balanced on parentheses. */
function tableBodies(code) {
  const out = [];
  const re = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let m;
  while ((m = re.exec(code))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
    }
    out.push({ name: m[1], body: code.slice(re.lastIndex, i - 1) });
  }
  return out;
}

export function lintMigrationSql(file, sql) {
  const findings = [];
  const add = (rule, detail) => findings.push({ rule, file, detail: norm(detail).slice(0, 300) });
  if (!/^\d{4}_[a-z0-9]+(_[a-z0-9]+)*\.sql$/.test(file)) add('FILE_NAME', file);
  const code = stripComments(sql);

  for (const m of code.matchAll(/\bIF\s+NOT\s*\(([\s\S]*?)\bTHEN\b/gi))
    if (!/\bcoalesce\s*\(|\bIS\s+(NOT\s+)?DISTINCT\s+FROM\b/i.test(m[1]))
      add('NULL_UNSAFE_NEGATED_GUARD', `IF NOT (${m[1]}`);
  for (const m of code.matchAll(/\bIF\s+NOT\s+(?!EXISTS\b|FOUND\b|\()([A-Za-z_][\w.]*)\s*(\([\s\S]*?)?\bTHEN\b/gi))
    if (!/\bcoalesce\s*\(/i.test(m[0])) add('NULL_UNSAFE_NEGATED_GUARD', m[0]);
  for (const m of code.matchAll(/\bIF\b([^;]*?)\bNOT\s+IN\s*\(\s*SELECT\b[\s\S]*?\bTHEN\b/gi))
    add('NULL_UNSAFE_NOT_IN', m[0]);

  // A RAISE statement runs to the first semicolon outside a string literal.
  for (const m of code.matchAll(/\bRAISE\s+EXCEPTION\b(?:'(?:[^']|'')*'|[^;'])*;/gi))
    if (!/\bERRCODE\b/i.test(m[0])) add('RAISE_WITHOUT_ERRCODE', m[0]);

  for (const t of tableBodies(code))
    if (/(^|,)\s*tenant_id\s+text\b/i.test(t.body) && !/\bPRIMARY\s+KEY\s*\(\s*tenant_id\b/i.test(t.body))
      add('TENANT_TABLE_WITHOUT_COMPOSITE_KEY', `CREATE TABLE ${t.name}`);

  for (const m of code.matchAll(/(?:^|;)\s*(DROP\s+(?:TABLE|SCHEMA|DATABASE)\b[^;]*|TRUNCATE\b[^;]*)/gim))
    add('DESTRUCTIVE_DDL', m[1]);
  for (const m of code.matchAll(/\bALTER\s+TABLE\b[^;]*?\bDROP\s+COLUMN\b[^;]*/gi)) add('DESTRUCTIVE_DDL', m[0]);
  return findings;
}

const loadJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const fingerprint = (f) => sha256(`${f.file}|${f.rule}|${f.detail}`).slice(0, 16);

export function lintMigrations(dir = DEFAULT_DIR, opts = {}) {
  const lock = opts.lock ?? loadJson(LOCK, { migrations: {} }).migrations;
  const baseline = opts.baseline ?? loadJson(BASELINE, { accepted: [] }).accepted;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const findings = [];
  const numbers = new Map();
  for (const f of files) {
    const text = readFileSync(path.join(dir, f), 'utf8');
    findings.push(...lintMigrationSql(f, text));
    const n = f.slice(0, 4);
    if (numbers.has(n)) findings.push({ rule: 'DUPLICATE_NUMBER', file: f, detail: `${n} also ${numbers.get(n)}` });
    numbers.set(n, f);
    if (!(f in lock)) findings.push({ rule: 'NOT_IN_CHECKSUM_LOCK', file: f, detail: f });
    else if (lock[f] !== sha256(text)) findings.push({ rule: 'CHECKSUM_CHANGED', file: f, detail: f });
  }
  for (const f of Object.keys(lock))
    if (!files.includes(f)) findings.push({ rule: 'MISSING_LOCKED_MIGRATION', file: f, detail: f });
  const accepted = new Set(baseline.map((b) => b.fingerprint));
  return findings.filter((f) => !accepted.has(fingerprint(f)));
}

export function writeLock(dir = DEFAULT_DIR) {
  const migrations = {};
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.sql'))
    .sort())
    migrations[f] = sha256(readFileSync(path.join(dir, f), 'utf8'));
  writeFileSync(
    LOCK,
    `${JSON.stringify({ schema: 'migration-checksums.v1', note: 'sha256 of each applied migration file; update only by adding a new migration (pnpm exec node scripts/migration-lint.mjs --update-lock).', migrations }, null, 2)}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dirArg = args.indexOf('--dir');
  const dir = dirArg >= 0 ? path.resolve(args[dirArg + 1]) : DEFAULT_DIR;
  if (args.includes('--update-lock')) {
    const before = loadJson(LOCK, { migrations: {} }).migrations;
    const changed = Object.entries(before).filter(
      ([f, h]) => existsSync(path.join(dir, f)) && sha256(readFileSync(path.join(dir, f), 'utf8')) !== h,
    );
    if (changed.length) {
      for (const [f] of changed)
        console.error(`FINDING CHECKSUM_CHANGED ${f}: an applied migration was edited; refusing to re-lock`);
      process.exit(1);
    }
    writeLock(dir);
  }
  if (args.includes('--fingerprints')) {
    for (const f of lintMigrations(dir, { baseline: [] }))
      console.log(JSON.stringify({ ...f, fingerprint: fingerprint(f) }));
    process.exit(0);
  }
  const findings = lintMigrations(dir);
  for (const f of findings) console.error(`FINDING ${f.rule} ${f.file}: ${f.detail}`);
  console.log(
    JSON.stringify({
      migrationsChecked: readdirSync(dir).filter((f) => f.endsWith('.sql')).length,
      findings: findings.length,
    }),
  );
  process.exit(findings.length ? 1 : 0);
}
