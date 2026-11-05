# Migrations runbook

Owner: M02 (`packages/data`). Runner: `scripts/db.mjs` (`pnpm db:migrate`). Proof: T-009
(`packages/data/test/t009-migration-forward-fix.int.test.ts`).

## Rules

- Migrations are **forward-only** SQL files named `NNNN_<module>_<topic>.sql`, applied in lexical order. Later modules add
  their own numbered files here through the M02 owner; numbers are never reused.
- Each file runs in its own transaction together with its `schema_migrations` row. A file that fails is **rolled back**
  completely (no partial schema, no recorded checksum) and the runner stops.
- An applied file is checksum-locked: editing it makes every later `migrate` fail with `Applied migration was edited`.
  History is never rewritten to "undo" a change.
- Every tenant-owned table has `tenant_id`, a `(tenant_id, id)` key and composite tenant foreign keys. Append-only tables
  call `ub_make_append_only(...)` so the database rejects `UPDATE`/`DELETE`/`TRUNCATE` (SQLSTATE `UB001`).
- Every trigger guard that raises must be **NULL-safe** (`docs/adr/0004-sql-guard-null-safety.md`): a NULL condition
  must refuse, never skip the `RAISE`. Prefer `IF coalesce(<allowed>, false) IS NOT TRUE THEN RAISE`, `IF NOT EXISTS`
  or `IS [NOT] DISTINCT FROM`; a guard fix ships as a new `CREATE OR REPLACE FUNCTION` migration.
- Changes must be safe for rolling deployment: additive first (nullable or defaulted columns, `NOT VALID` constraints
  then `VALIDATE`), destructive steps only in a later release once no running code reads the old shape.

## When a migration fails before it is applied

The transaction is rolled back, so the database is still at the previous version and no data changed. Fix the file
(it was never recorded, so editing it is allowed) or withdraw it, then re-run `pnpm db:migrate`.

## Forward fix after a migration was applied

Schema rollback is not promised once data shape may have changed. Ship a **forward fix**: a new, higher-numbered
migration that repairs the schema or data (for example re-adding a column with a backfill, or relaxing a constraint),
and deploy it like any other change. T-009 exercises this path: a broken `9002_*` file fails and rolls back, is
withdrawn, and a corrected `9002_*_forward_fix.sql` applies with the seeded dataset unchanged.

## Destructive transformations and restore

Before any destructive transformation (dropping a column/table, rewriting rows), take a verified backup and record a
restore point; the transformation must be preceded by a release in which nothing reads the old shape. If a destructive
step goes wrong, restore from that backup (PostgreSQL point-in-time recovery) into a fresh instance, verify tenant,
evidence, approval, outbox and job consistency, then roll forward with a corrected migration. Immutable evidence and
audit rows are never "fixed" by editing them; corrections are new linked revisions.

## Release gate

Both a clean database and an upgrade from the prior release's seeded dataset must migrate successfully (`pnpm verify`
runs T-001 for the clean path and T-009 for the seeded upgrade path).
