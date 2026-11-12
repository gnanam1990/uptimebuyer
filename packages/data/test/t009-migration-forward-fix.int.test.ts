// T-009 — Migration and rollback on seeded tenant (FR-01, INV-10, NFR-02).
// Forward migration preserves a representative tenant dataset; the documented failure-rollback plus forward-fix path
// is exercised without silent data loss; registry edits append versioned revisions with actor/source/time provenance
// while prior revisions stay readable; and the database itself rejects UPDATE/DELETE/TRUNCATE on append-only tables.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getApprovalStatus,
  getAsset,
  getAssetRevision,
  getSite,
  listAssetRevisions,
  listDeviceAssignments,
  listRegistryRevisions,
  listSensorChannelRevisions,
  readEvidenceLedger,
  recordRegistryEdit,
  updateSite,
  updateTenantProfile,
} from '../src/index.js';
import { seedRepresentativeDataset, type RepresentativeDataset } from './dataset.js';
import {
  createTestDatabase,
  dbScripts,
  migrationsDir,
  seedTenant,
  TestIdentityProvider,
  type SeededTenant,
  type TestDatabase,
} from './helpers.js';

const M02_MIGRATIONS = [
  '0001_m02_identity_tenancy.sql',
  '0002_m02_registry_assets_devices.sql',
  '0003_m02_policy_approvals_evidence.sql',
  '0004_m02_outbox_jobs_audit.sql',
  '0005_m02_provider_accounts.sql',
  '0006_m02_privacy_lifecycle.sql',
  '0007_m02_security_hardening.sql',
];
const M03_MIGRATIONS = ['0008_m03_telemetry.sql'];
const M04_MIGRATIONS = ['0009_m04_incidents.sql'];
const M05_MIGRATIONS = ['0010_m05_evidence_reasoning.sql'];
const M06_MIGRATIONS = ['0011_m06_compatibility_policy.sql'];
const M07_MIGRATIONS = ['0012_m07_provider_comms.sql', '0013_m07_contact_point_review.sql'];
const M08_MIGRATIONS = ['0014_m08_planning.sql', '0015_m08_plan_hash_open_scope.sql'];
const M09_MIGRATIONS = ['0016_m09_kite_broker.sql'];
// Forward fixes that land after later modules keep their own module prefix and their lexical position.
const FORWARD_FIX_MIGRATIONS = ['0017_m07_contact_point_guard_null_safe.sql'];
const M10_MIGRATIONS = ['0018_m10_orders_jobs.sql'];
const M11_MIGRATIONS = ['0019_m11_recovery_verification_cmms.sql'];
const M13_MIGRATIONS = [
  '0020_m13_data_lifecycle.sql',
  '0021_m13_separation_of_duties.sql',
  '0022_m13_policy_governance.sql',
  '0023_m13_adjustment_separation.sql',
];
// M05 forward change after the release modules: parser re-derivation (uptimebuyer-parser.v3, T-058 journey finding).
const M05_REDERIVATION_MIGRATIONS = ['0024_m05_parser_rederivation.sql', '0025_m05_rederivation_lineage.sql'];

// Tables whose rows are immutable once written (full append-only) and the column used to attempt a mutation.
const APPEND_ONLY: Record<string, string> = {
  registry_revisions: 'body_digest',
  asset_revisions: 'serial',
  device_asset_assignments: 'asset_revision_id',
  sensor_channel_revisions: 'calibration_revision',
  policy_revisions: 'body_digest',
  approvals: 'max_amount_minor',
  approval_events: 'reason_code',
  evidence_blobs: 'sha256',
  evidence_revisions: 'manifest_sha256',
  evidence_revision_items: 'role',
  evidence_ledger_entries: 'payload_digest',
  audit_entries: 'result',
  security_audit_entries: 'result',
  provider_account_revisions: 'credential_ref',
  webhook_deliveries: 'body_digest',
};

let db: TestDatabase;
let idp: TestIdentityProvider;
let a: SeededTenant;
let b: SeededTenant;
let dataA: RepresentativeDataset;
let dataB: RepresentativeDataset;
let scratch: string;

/** Deterministic content digest of every tenant-owned table, ignoring columns a later migration may add. */
async function datasetDigest(ignoreColumns: string[] = []): Promise<Record<string, string>> {
  const { rows: tables } = await db.admin(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name`,
  );
  const out: Record<string, string> = {};
  const drop = ignoreColumns.map((c) => ` - '${c}'`).join('');
  for (const { table_name } of tables as { table_name: string }[]) {
    const { rows } = await db.admin(
      `SELECT count(*)::int AS n, coalesce(md5(string_agg((to_jsonb(t)${drop})::text, '|' ORDER BY (to_jsonb(t)${drop})::text)), '') AS d FROM ${table_name} t`,
    );
    out[table_name] = `${rows[0].n}:${rows[0].d}`;
  }
  return out;
}

describe('T-009 migration and rollback on seeded tenant', () => {
  beforeAll(async () => {
    db = await createTestDatabase('t009');
    idp = await TestIdentityProvider.create();
    scratch = mkdtempSync(path.join(tmpdir(), 'ub-t009-'));
  });
  afterAll(async () => {
    rmSync(scratch, { recursive: true, force: true });
    await db?.drop();
  });

  it('applies every M02 (and later module) migration forward once, then is a checksum-stable no-op', async () => {
    const { migrate } = await dbScripts();
    const applied = await migrate(db.url);
    expect(applied).toEqual([
      '0000_bootstrap.sql',
      ...M02_MIGRATIONS,
      ...M03_MIGRATIONS,
      ...M04_MIGRATIONS,
      ...M05_MIGRATIONS,
      ...M06_MIGRATIONS,
      ...M07_MIGRATIONS,
      ...M08_MIGRATIONS,
      ...M09_MIGRATIONS,
      ...FORWARD_FIX_MIGRATIONS,
      ...M10_MIGRATIONS,
      ...M11_MIGRATIONS,
      ...M13_MIGRATIONS,
      ...M05_REDERIVATION_MIGRATIONS,
    ]);
    expect(await migrate(db.url)).toEqual([]);
    const { rows } = await db.admin(`SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`);
    expect(rows).toHaveLength(1);
  });

  it('seeds a representative dataset for two tenants through the repository layer', async () => {
    a = await seedTenant(db.pool, idp, 'alpha');
    b = await seedTenant(db.pool, idp, 'beta');
    dataA = await seedRepresentativeDataset(db.pool, idp, a, 'alpha');
    dataB = await seedRepresentativeDataset(db.pool, idp, b, 'beta');
    const digest = await datasetDigest();
    for (const t of ['assets', 'asset_revisions', 'device_asset_assignments', 'approvals', 'outbox_events'])
      expect(digest[t]?.startsWith('0:')).toBe(false);
  });

  it('a later forward migration preserves the seeded dataset exactly', async () => {
    const before = await datasetDigest();
    const dir = path.join(scratch, 'forward');
    cpSync(migrationsDir, dir, { recursive: true });
    writeFileSync(
      path.join(dir, '9001_t009_forward_change.sql'),
      [
        '-- Representative later-release change: additive column, backfill, validated constraint, index.',
        'ALTER TABLE assets ADD COLUMN t009_note text;',
        "UPDATE assets SET t009_note = 'migrated';",
        "ALTER TABLE assets ADD CONSTRAINT assets_t009_note_ck CHECK (t009_note IN ('migrated')) NOT VALID;",
        'ALTER TABLE assets VALIDATE CONSTRAINT assets_t009_note_ck;',
        'CREATE INDEX assets_t009_note_ix ON assets (tenant_id, t009_note);',
        '',
      ].join('\n'),
    );
    const { migrate } = await dbScripts();
    expect(await migrate(db.url, dir)).toEqual(['9001_t009_forward_change.sql']);
    expect(await datasetDigest(['t009_note'])).toEqual(before);

    // Reads through the repository still resolve the same revision-bound history.
    const asset = await getAsset(db.pool, dataA.admin, dataA.asset.assetId);
    expect(asset.currentRevisionId).toBe(dataA.revised.assetRevisionId);
    const old = await getAssetRevision(db.pool, dataA.admin, dataA.asset.assetRevisionId);
    expect(old.serial).toBe('alpha-SN-0001');
    const ledger = await readEvidenceLedger(db.pool, dataB.admin);
    // The two seeded material entries, then (since M13, FR-18) exactly one APPROVAL record for the seeded approval.
    expect(ledger.slice(0, 2).map((e) => e.evidenceId)).toEqual([
      dataB.ledger.first.evidenceId,
      dataB.ledger.correction.evidenceId,
    ]);
    expect(ledger.slice(2).map((e) => [e.kind, e.subject.aggregateId])).toEqual([
      ['APPROVAL', dataB.approval.approvalId],
    ]);
  });

  it('a failing migration rolls back atomically and is repaired by a forward fix without data loss', async () => {
    const before = await datasetDigest(['t009_note']);
    const dir = path.join(scratch, 'forward');
    const broken = path.join(dir, '9002_t009_broken_change.sql');
    writeFileSync(
      broken,
      [
        'ALTER TABLE sites ADD COLUMN t009_region text;',
        '-- Defect: violates sites.name NOT NULL, so the whole migration must roll back.',
        'UPDATE sites SET name = NULL;',
        '',
      ].join('\n'),
    );
    const { migrate } = await dbScripts();
    await expect(migrate(db.url, dir)).rejects.toThrow(/Migration 9002_t009_broken_change\.sql failed/);
    const col = await db.admin(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'sites' AND column_name = 't009_region'`,
    );
    expect(col.rows).toHaveLength(0);
    const applied = await db.admin(`SELECT name FROM schema_migrations WHERE name LIKE '9002%'`);
    expect(applied.rows).toHaveLength(0);
    expect(await datasetDigest(['t009_note'])).toEqual(before);

    // Documented forward fix: the never-applied broken file is withdrawn and a corrected migration ships instead.
    rmSync(broken);
    writeFileSync(
      path.join(dir, '9002_t009_forward_fix.sql'),
      "ALTER TABLE sites ADD COLUMN t009_region text NOT NULL DEFAULT 'UNASSIGNED';\n",
    );
    expect(await migrate(db.url, dir)).toEqual(['9002_t009_forward_fix.sql']);
    expect(await datasetDigest(['t009_note', 't009_region'])).toEqual(before);

    // An applied migration can never be edited to "roll back" history.
    writeFileSync(path.join(dir, '9002_t009_forward_fix.sql'), 'ALTER TABLE sites DROP COLUMN t009_region;\n');
    await expect(migrate(db.url, dir)).rejects.toThrow(/Applied migration was edited: 9002_t009_forward_fix\.sql/);

    const runbook = readFileSync(path.join(migrationsDir, 'README.md'), 'utf8');
    for (const phrase of ['forward-only', 'forward fix', 'rolled back', 'restore'])
      expect(runbook.toLowerCase()).toContain(phrase);
  });

  it('registry edits append versioned revisions with actor, source and time provenance; prior revisions stay readable', async () => {
    const ctx = dataA.admin;
    const actorId = a.adminUserId;

    await updateTenantProfile(db.pool, ctx, { name: 'alpha holdings' }, { expectedVersion: 1, source: 'API' });
    const site = await getSite(db.pool, ctx, dataA.site.siteId);
    await updateSite(
      db.pool,
      ctx,
      dataA.site.siteId,
      { name: 'alpha flagship' },
      {
        expectedVersion: site.version,
        source: 'IMPORT',
      },
    );
    await recordRegistryEdit(db.pool, ctx, {
      entityKind: 'WARRANTY',
      entityId: dataA.asset.assetId,
      body: { provider: 'True Manufacturing', expiresOn: '2029-06-30', termsBlobId: dataA.blob.blobId },
      source: 'CMMS_SYNC',
    });
    await recordRegistryEdit(db.pool, ctx, {
      entityKind: 'APPROVED_VENDOR',
      entityId: dataA.vendor.entityId,
      body: { vendorName: 'alpha Refrigeration Co', status: 'SUSPENDED', siteIds: [dataA.site.siteId] },
      source: 'API',
    });
    await recordRegistryEdit(db.pool, ctx, {
      entityKind: 'FOOD_AT_RISK',
      entityId: dataA.asset.assetId,
      body: { value: { amountMinor: 990_000n, currency: 'USD' }, basis: 'INVENTORY_COUNT' },
      source: 'API',
    });

    const cases = [
      ['TENANT', a.tenantId, 2],
      ['SITE', dataA.site.siteId, 2],
      ['ASSET', dataA.asset.assetId, 2],
      ['DEVICE', dataA.device.deviceId, 1],
      ['SENSOR_CHANNEL', dataA.channel.channelId, 2],
      ['WARRANTY', dataA.asset.assetId, 2],
      ['APPROVED_VENDOR', dataA.vendor.entityId, 2],
      ['FOOD_AT_RISK', dataA.asset.assetId, 2],
    ] as const;
    for (const [kind, id, count] of cases) {
      const revs = await listRegistryRevisions(db.pool, ctx, kind, id);
      expect(
        revs.map((r) => r.revision),
        kind,
      ).toEqual(Array.from({ length: count }, (_, i) => i + 1));
      for (const r of revs) {
        const provisioning = kind === 'TENANT' && r.revision === 1;
        expect(r.actor, kind).toEqual(provisioning ? { kind: 'PLATFORM', id: null } : { kind: 'HUMAN', id: actorId });
        expect(['API', 'IMPORT', 'CMMS_SYNC', 'PROVISIONING']).toContain(r.source);
        expect(Number.isNaN(Date.parse(r.recordedAt))).toBe(false);
        expect(r.bodyDigest).toMatch(/^registry\.v1:sha256:[0-9a-f]{64}$/);
      }
      for (let i = 1; i < revs.length; i++)
        expect(Date.parse(revs[i]!.recordedAt)).toBeGreaterThanOrEqual(Date.parse(revs[i - 1]!.recordedAt));
    }
    const siteRevs = await listRegistryRevisions(db.pool, ctx, 'SITE', dataA.site.siteId);
    expect(siteRevs[0]!.body).toMatchObject({ name: 'alpha store 1' });
    expect(siteRevs[1]!.body).toMatchObject({ name: 'alpha flagship' });
    expect(siteRevs[1]!.source).toBe('IMPORT');
    const tenantRevs = await listRegistryRevisions(db.pool, ctx, 'TENANT', a.tenantId);
    expect(tenantRevs[0]!.source).toBe('PROVISIONING');
    const food = await listRegistryRevisions(db.pool, ctx, 'FOOD_AT_RISK', dataA.asset.assetId);
    expect(food[0]!.body).toMatchObject({ value: { amountMinor: '1250000', currency: 'USD' } });
    expect(food[1]!.body).toMatchObject({ value: { amountMinor: '990000', currency: 'USD' } });
    const warranty = await listRegistryRevisions(db.pool, ctx, 'WARRANTY', dataA.asset.assetId);
    expect(warranty[0]!.source).toBe('API');
    expect(warranty[1]!.source).toBe('CMMS_SYNC');

    const channelRevs = await listSensorChannelRevisions(db.pool, ctx, dataA.channel.channelId);
    expect(channelRevs.map((r) => [r.revision, r.calibrationRevision, r.calibrationOffsetMilli])).toEqual([
      [1, 1, 0],
      [2, 2, -150],
    ]);
    expect(channelRevs[0]!.validTo).toBe(channelRevs[1]!.validFrom);
  });

  it('an asset identity change appends a revision, advances the pointer, rebinds devices and invalidates unexecuted approvals without rewriting history', async () => {
    const ctx = dataA.admin;
    const revisions = await listAssetRevisions(db.pool, ctx, dataA.asset.assetId);
    expect(revisions.map((r) => [r.revision, r.serial, r.bomRevision])).toEqual([
      [1, 'alpha-SN-0001', 'BOM-3'],
      [2, 'alpha-SN-0002', 'BOM-4'],
    ]);
    expect(revisions[0]!.supersededAt).not.toBeNull();
    expect(revisions[1]!.supersededAt).toBeNull();
    expect(revisions[0]!.identityDigest).not.toBe(revisions[1]!.identityDigest);
    const asset = await getAsset(db.pool, ctx, dataA.asset.assetId);
    expect(asset.currentRevisionId).toBe(revisions[1]!.assetRevisionId);
    expect(asset.version).toBe(dataA.asset.version + 1);

    const assignments = await listDeviceAssignments(db.pool, ctx, dataA.device.deviceId);
    expect(assignments.map((x) => [x.revision, x.assetRevisionId])).toEqual([
      [1, dataA.asset.assetRevisionId],
      [2, dataA.revised.assetRevisionId],
    ]);
    expect(assignments[0]!.validTo).toBe(assignments[1]!.validFrom);
    expect(assignments[1]!.validTo).toBeNull();
    expect(dataA.revised.reboundAssignmentIds).toEqual([assignments[1]!.assignmentId]);

    const status = await getApprovalStatus(db.pool, ctx, dataA.approval.approvalId);
    expect(status.executable).toBe(false);
    expect(status.events.map((e) => [e.eventType, e.reasonCode])).toEqual([
      ['INVALIDATED', 'ASSET_REVISION_SUPERSEDED'],
    ]);
    expect(status.approval.assetRevisionId).toBe(dataA.asset.assetRevisionId);
    expect(status.approval.signatureDigest).toBe(dataA.approval.signatureDigest);
    expect(dataA.revised.invalidatedApprovalIds).toEqual([dataA.approval.approvalId]);
    const job = await db.admin(
      `SELECT kind, payload FROM jobs WHERE tenant_id = $1 AND kind = 'plan.revalidate_for_asset_revision'`,
      [a.tenantId],
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0].payload).toMatchObject({ supersededAssetRevisionId: dataA.asset.assetRevisionId });

    // The current pointer must name a revision of this same asset.
    await expect(
      db.admin(`UPDATE assets SET current_revision_id = $1 WHERE tenant_id = $2 AND id = $3`, [
        dataB.asset.assetRevisionId,
        a.tenantId,
        dataA.asset.assetId,
      ]),
    ).rejects.toMatchObject({ code: '23503' });

    // Overlapping effective intervals for one device are impossible at the database level.
    await expect(
      db.admin(
        `INSERT INTO device_asset_assignments (tenant_id, id, device_id, asset_id, asset_revision_id, revision, valid_from, valid_to, assignment_digest, actor_kind, actor_id, source)
         SELECT tenant_id, 'dasg_overlap-probe', device_id, asset_id, asset_revision_id, 99, valid_from, NULL, assignment_digest, actor_kind, actor_id, source
           FROM device_asset_assignments WHERE tenant_id = $1 AND device_id = $2 AND revision = 2`,
        [a.tenantId, dataA.device.deviceId],
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('the database rejects UPDATE, DELETE and TRUNCATE on every append-only table', async () => {
    for (const [table, column] of Object.entries(APPEND_ONLY)) {
      const { rows } = await db.admin(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n, `${table} has fixture rows`).toBeGreaterThan(0);
      await expect(db.admin(`UPDATE ${table} SET ${column} = ${column}`), `${table} UPDATE`).rejects.toThrow(
        /append-only/,
      );
      await expect(db.admin(`DELETE FROM ${table}`), `${table} DELETE`).rejects.toThrow(/append-only/);
      await expect(db.admin(`TRUNCATE ${table} CASCADE`), `${table} TRUNCATE`).rejects.toThrow(/append-only/);
    }

    // One-shot supersession/closing stamps cannot be moved once set.
    await expect(
      db.admin(`UPDATE asset_revisions SET superseded_at = now() WHERE tenant_id = $1 AND id = $2`, [
        a.tenantId,
        dataA.asset.assetRevisionId,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.admin(`UPDATE device_asset_assignments SET valid_to = now() WHERE tenant_id = $1 AND revision = 1`, [
        a.tenantId,
      ]),
    ).rejects.toThrow(/append-only/);

    // Outbox content is immutable; only the publication bookkeeping may change.
    await expect(db.admin(`UPDATE outbox_events SET payload = '{}'::jsonb`)).rejects.toThrow(/append-only/);
    await expect(db.admin(`DELETE FROM outbox_events WHERE published_at IS NULL`)).rejects.toThrow(/append-only/);
  });
});
