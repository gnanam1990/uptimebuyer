# Backup, restore and rollback runbook (M14, T-060)

Status: exercised **locally** by `pnpm release:smoke` against the compose database (results in
`docs/release/evidence/t057-release-smoke.json`). Point-in-time recovery, encrypted off-site backups, retention tests
and a production restore drill are `NOT_RUN`.

## Principles

- Migrations are **forward-only** and checksum-locked (`config/security/migration-checksums.json`). Rollback never
  runs down-migrations: code is rolled back to the previous image, which must run against the newer schema (every
  migration is additive), and a defect in a migration is corrected by a new forward migration.
- Durable rows are never deleted to recover: outbox events, ledger entries, external attempts and receipts are
  append-only evidence. Unknown external outcomes stay `UNKNOWN` through any rollback and reconcile afterwards.
- Every backup is pinned by the sha256 of its dump file plus a snapshot manifest (applied migrations, schema digest,
  per-table row counts and content digests) produced by `scripts/release/db-drill.mjs`.

## Backup

1. `pg_dump --format=custom --no-owner --dbname <database>` from the database host or the postgres container
   (compose: `docker compose -p <project> exec -T postgres pg_dump -U uptimebuyer -Fc uptimebuyer > backup.dump`).
2. Record `sha256(backup.dump)`, the source git SHA and `snapshotDatabase(<source>)` in a `backup-manifest.v1`
   (`backupManifest()`).
3. Store dump and manifest encrypted and access-controlled (not done locally; `NOT_RUN`).

## Restore and verify

1. Verify the dump checksum against its manifest before using it.
2. Create a fresh database and `pg_restore --no-owner --exit-on-error --dbname <fresh> backup.dump`.
3. `snapshotDatabase(<fresh>)` and `compareSnapshots(manifest, restored)` must report `equal: true`.
4. `verifyMigrations(restored, repo)` compares the restored `schema_migrations` rows with the files and must report
   no finding: every committed migration applied, no checksum
   mismatch with the files or the lock, no unknown migration.
5. Run the migrate job against the restored database: it must apply nothing (`{"applied":[]}`).
6. Point a stack at it and run the smoke checks before promoting it.

## Rollback to the previous image

1. Keep the previous release's image IDs (recorded with every release; `docs/release/evidence/`).
2. Set `UB_IMAGE_TAG` to the previous tag and `docker compose up -d --no-deps api worker sensor-gateway`
   (the broker is rolled back separately and only with its own review).
3. Wait for readiness; re-run the smoke checks. The schema stays at the newer version; the previous code must accept it.
4. Roll forward the same way once the fix is released. If the previous code cannot run against the new schema, do not
   roll back: ship a forward fix.

## Pre-release gate

`RELEASE_TAG` and `DEPLOY` preflight require `backup-taken`, `backup-restore-verified` and `rollback-exercised`
(`config/release/gates.json`).
