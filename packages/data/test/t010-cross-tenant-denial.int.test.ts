// T-010 — Cross-tenant access denial (FR-24, INV-16).
// Tenant A's authenticated context cannot read, infer, change or act on tenant B data through direct IDs, child
// joins, filters, exports, caches, jobs/outbox, object keys, or provider-account-namespaced webhook lookups; each
// denial is audited in the caller's own tenant and is indistinguishable from a request for a nonexistent ID.
import { createHash } from 'node:crypto';
import { DomainEventEnvelopeSchema, money, newId, type DomainEventEnvelope } from '@uptimebuyer/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OutboxPublisher,
  TenantScopedCache,
  appendProviderAccountRevision,
  assertObjectKeyInTenant,
  assignDeviceToAsset,
  authenticateDevice,
  claimJobs,
  completeJob,
  consumeOnce,
  enqueueJob,
  exportAuditEntries,
  exportEvidenceLedger,
  findWebhookDelivery,
  getApprovalStatus,
  getAsset,
  getAssetRevision,
  getProviderAccount,
  getSite,
  listAssets,
  listAuditEntries,
  listDeviceAssignments,
  listRegistryRevisions,
  listSecurityAuditEntries,
  listSites,
  recordApproval,
  recordRegistryEdit,
  recordWebhookDelivery,
  registerEvidenceBlob,
  resolveTenantContext,
  resolveWebhookBinding,
  reviseAssetIdentity,
  signPrincipalToken,
  tenantObjectKey,
  updateSite,
  addMembership,
  upsertUser,
  withTenantTransaction,
  type TenantContext,
} from '../src/index.js';
import { seedRepresentativeDataset, type RepresentativeDataset } from './dataset.js';
import {
  createTestDatabase,
  dbScripts,
  humanContext,
  resolver,
  seedTenant,
  sha,
  syntheticKey,
  TestIdentityProvider,
  type SeededTenant,
  type TestDatabase,
} from './helpers.js';

let db: TestDatabase;
let idp: TestIdentityProvider;
let a: SeededTenant;
let b: SeededTenant;
let A: RepresentativeDataset;
let B: RepresentativeDataset;
let ctxA: TenantContext;

/** Every observable property of a rejection, so equality proves the two cases are indistinguishable. */
async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; httpStatus?: number; message?: string; details?: unknown };
    return { code: err.code, httpStatus: err.httpStatus, message: err.message, details: err.details };
  }
  throw new Error('expected rejection');
}

async function tenantDigest(tenantId: string): Promise<string> {
  const { rows } = await db.admin(
    `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'
      AND table_name NOT IN ('audit_entries') ORDER BY table_name`,
  );
  const parts: string[] = [];
  for (const { table_name } of rows as { table_name: string }[]) {
    const r = await db.admin(
      `SELECT coalesce(md5(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text)), '') AS d FROM ${table_name} t WHERE tenant_id = $1`,
      [tenantId],
    );
    parts.push(`${table_name}=${r.rows[0].d}`);
  }
  return parts.join(';');
}

describe('T-010 cross-tenant access denial', () => {
  beforeAll(async () => {
    db = await createTestDatabase('t010');
    idp = await TestIdentityProvider.create();
    await (await dbScripts()).migrate(db.url);
    a = await seedTenant(db.pool, idp, 'alpha');
    b = await seedTenant(db.pool, idp, 'beta');
    A = await seedRepresentativeDataset(db.pool, idp, a, 'alpha');
    B = await seedRepresentativeDataset(db.pool, idp, b, 'beta');
    ctxA = A.admin;
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('every tenant-owned table carries tenant_id, a composite (tenant_id, id) key and tenant-leading foreign keys', async () => {
    const { rows: tables } = await db.admin(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'
        AND table_name NOT IN ('schema_migrations','platform_info','tenants','users','security_audit_entries')`,
    );
    expect(tables.length).toBeGreaterThan(20);
    for (const { table_name } of tables as { table_name: string }[]) {
      const cols = await db.admin(
        `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='tenant_id' AND is_nullable='NO'`,
        [table_name],
      );
      expect(cols.rows, `${table_name}.tenant_id NOT NULL`).toHaveLength(1);
    }
    const { rows: keys } = await db.admin(`
      SELECT c.conrelid::regclass::text AS t,
             array_agg(a.attname ORDER BY k.ord) AS cols
        FROM pg_constraint c
        CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.contype IN ('p','u') AND c.connamespace = 'public'::regnamespace
       GROUP BY c.oid, c.conrelid`);
    for (const { table_name } of tables as { table_name: string }[]) {
      if (table_name === 'outbox_consumer_receipts' || table_name === 'evidence_revision_items') continue;
      const ok = (keys as { t: string; cols: string[] }[]).some(
        (k) => k.t === table_name && k.cols.length === 2 && k.cols[0] === 'tenant_id' && k.cols[1] === 'id',
      );
      expect(ok, `${table_name} has UNIQUE/PK (tenant_id, id)`).toBe(true);
    }
    const { rows: fks } = await db.admin(`
      SELECT c.conname, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
             (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1]) AS first_col
        FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`);
    expect(fks.length).toBeGreaterThan(30);
    for (const fk of fks as { conname: string; child: string; parent: string; first_col: string }[]) {
      if (fk.parent === 'users') continue; // global identity table
      expect(fk.first_col, `${fk.conname} (${fk.child} -> ${fk.parent}) leads with tenant_id`).toBe('tenant_id');
    }
  });

  it('direct IDs from another tenant are denied exactly like nonexistent IDs, audited, with no change to the other tenant', async () => {
    const beforeB = await tenantDigest(b.tenantId);
    const auditB = await db.admin(`SELECT count(*)::int AS n FROM audit_entries WHERE tenant_id=$1`, [b.tenantId]);
    const probes: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
      ['getSite', () => getSite(db.pool, ctxA, B.site.siteId), () => getSite(db.pool, ctxA, newId('site'))],
      ['getAsset', () => getAsset(db.pool, ctxA, B.asset.assetId), () => getAsset(db.pool, ctxA, newId('asset'))],
      [
        'getAssetRevision',
        () => getAssetRevision(db.pool, ctxA, B.asset.assetRevisionId),
        () => getAssetRevision(db.pool, ctxA, newId('assetRevision')),
      ],
      [
        'getProviderAccount',
        () => getProviderAccount(db.pool, ctxA, B.provider.providerAccountId),
        () => getProviderAccount(db.pool, ctxA, newId('providerAccount')),
      ],
      [
        'getApprovalStatus',
        () => getApprovalStatus(db.pool, ctxA, B.approval.approvalId),
        () => getApprovalStatus(db.pool, ctxA, newId('approval')),
      ],
      [
        'listDeviceAssignments',
        () => listDeviceAssignments(db.pool, ctxA, B.device.deviceId),
        () => listDeviceAssignments(db.pool, ctxA, newId('device')),
      ],
      [
        'listRegistryRevisions',
        () => listRegistryRevisions(db.pool, ctxA, 'ASSET', B.asset.assetId),
        () => listRegistryRevisions(db.pool, ctxA, 'ASSET', newId('asset')),
      ],
      [
        'updateSite',
        () => updateSite(db.pool, ctxA, B.site.siteId, { name: 'pwned' }, { expectedVersion: 1, source: 'API' }),
        () => updateSite(db.pool, ctxA, newId('site'), { name: 'pwned' }, { expectedVersion: 1, source: 'API' }),
      ],
      [
        'reviseAssetIdentity',
        () =>
          reviseAssetIdentity(
            db.pool,
            ctxA,
            B.asset.assetId,
            { manufacturer: 'X', model: 'Y', serial: 'Z', safetyClass: 'STANDARD', bomRevision: 'B' },
            { expectedVersion: 2, source: 'API' },
          ),
        () =>
          reviseAssetIdentity(
            db.pool,
            ctxA,
            newId('asset'),
            { manufacturer: 'X', model: 'Y', serial: 'Z', safetyClass: 'STANDARD', bomRevision: 'B' },
            { expectedVersion: 2, source: 'API' },
          ),
      ],
      [
        'assignDeviceToAsset(foreign asset)',
        () =>
          assignDeviceToAsset(db.pool, ctxA, { deviceId: A.device.deviceId, assetId: B.asset.assetId, source: 'API' }),
        () =>
          assignDeviceToAsset(db.pool, ctxA, { deviceId: A.device.deviceId, assetId: newId('asset'), source: 'API' }),
      ],
      [
        'assignDeviceToAsset(foreign device)',
        () =>
          assignDeviceToAsset(db.pool, ctxA, { deviceId: B.device.deviceId, assetId: A.asset.assetId, source: 'API' }),
        () =>
          assignDeviceToAsset(db.pool, ctxA, { deviceId: newId('device'), assetId: A.asset.assetId, source: 'API' }),
      ],
      [
        'recordRegistryEdit',
        () =>
          recordRegistryEdit(db.pool, ctxA, {
            entityKind: 'FOOD_AT_RISK',
            entityId: B.asset.assetId,
            body: { value: { amountMinor: 1n, currency: 'USD' }, basis: 'INVENTORY_COUNT' },
            source: 'API',
          }),
        () =>
          recordRegistryEdit(db.pool, ctxA, {
            entityKind: 'FOOD_AT_RISK',
            entityId: newId('asset'),
            body: { value: { amountMinor: 1n, currency: 'USD' }, basis: 'INVENTORY_COUNT' },
            source: 'API',
          }),
      ],
      [
        'appendProviderAccountRevision',
        () =>
          appendProviderAccountRevision(db.pool, ctxA, B.provider.providerAccountId, {
            revision: {
              capabilities: ['PURCHASE'],
              paid: true,
              ownerService: 'KITE_BROKER_PAID',
              credentialRef: 'secretref:provider/hijack',
              endpointPolicyDigest: sha('x'),
              webhookVerifierRef: 'secretref:webhook/hijack',
            },
            source: 'API',
          }),
        () =>
          appendProviderAccountRevision(db.pool, ctxA, newId('providerAccount'), {
            revision: {
              capabilities: ['PURCHASE'],
              paid: true,
              ownerService: 'KITE_BROKER_PAID',
              credentialRef: 'secretref:provider/hijack',
              endpointPolicyDigest: sha('x'),
              webhookVerifierRef: 'secretref:webhook/hijack',
            },
            source: 'API',
          }),
      ],
      [
        'recordApproval(foreign revisions)',
        () =>
          recordApproval(db.pool, ctxA, {
            ...A.approvalInput,
            assetRevisionId: B.revised.assetRevisionId,
            evidenceRevisionId: B.evidence.evidenceRevisionId,
          }),
        () =>
          recordApproval(db.pool, ctxA, {
            ...A.approvalInput,
            assetRevisionId: newId('assetRevision'),
            evidenceRevisionId: newId('evidenceRevision'),
          }),
      ],
    ];
    for (const [name, foreign, missing] of probes) {
      const f = await rejection(foreign());
      const m = await rejection(missing());
      expect(f.code, name).toBe('FORBIDDEN');
      expect(f.httpStatus, name).toBe(403);
      expect(f, `${name}: foreign and nonexistent are indistinguishable`).toEqual(m);
      expect(JSON.stringify(f)).not.toContain(b.tenantId);
    }
    expect(await tenantDigest(b.tenantId)).toBe(beforeB);
    const auditBAfter = await db.admin(`SELECT count(*)::int AS n FROM audit_entries WHERE tenant_id=$1`, [b.tenantId]);
    expect(auditBAfter.rows[0].n).toBe(auditB.rows[0].n);

    const denials = await listAuditEntries(db.pool, ctxA, { result: 'DENIED' });
    const denied = denials.filter((d) => d.reasonCode === 'RESOURCE_UNAVAILABLE');
    expect(denied.length).toBeGreaterThanOrEqual(probes.length * 2);
    for (const d of denied) {
      expect(d.tenantId).toBe(a.tenantId);
      expect(d.actor).toEqual({ kind: 'HUMAN', id: a.adminUserId });
      expect(JSON.stringify(d)).not.toContain(b.tenantId);
    }
  });

  it('child-table joins cannot cross tenants: composite foreign keys reject foreign parents', async () => {
    const probes: [string, string, unknown[]][] = [
      [
        'asset revision on foreign asset',
        `INSERT INTO asset_revisions (tenant_id, id, asset_id, revision, manufacturer, model, serial, safety_class, bom_revision, valid_from, identity_digest, actor_kind, actor_id, source)
         VALUES ($1, 'arv_probe-0001', $2, 9, 'm', 'm', 's', 'STANDARD', 'b', now(), 'asset-identity.v1:sha256:${'0'.repeat(64)}', 'HUMAN', $3, 'API')`,
        [a.tenantId, B.asset.assetId, a.adminUserId],
      ],
      [
        'assignment to foreign asset revision',
        `INSERT INTO device_asset_assignments (tenant_id, id, device_id, asset_id, asset_revision_id, revision, valid_from, assignment_digest, actor_kind, actor_id, source)
         VALUES ($1, 'dasg_probe-0001', $2, $3, $4, 9, now() + interval '1 day', 'device-assignment.v1:sha256:${'0'.repeat(64)}', 'HUMAN', $5, 'API')`,
        [a.tenantId, A.device.deviceId, B.asset.assetId, B.revised.assetRevisionId, a.adminUserId],
      ],
      [
        'approval event on foreign approval',
        `INSERT INTO approval_events (tenant_id, id, approval_id, event_type, reason_code, actor_kind, actor_id)
         VALUES ($1, 'ape_probe-0001', $2, 'REVOKED', 'PROBE', 'HUMAN', $3)`,
        [a.tenantId, B.approval.approvalId, a.adminUserId],
      ],
      [
        'webhook delivery on foreign provider account',
        `INSERT INTO webhook_deliveries (tenant_id, id, provider_account_id, provider_account_revision_id, provider_event_id, signature_result, body_digest)
         VALUES ($1, 'whd_probe-0001', $2, $3, 'evt-probe', 'VALID', $4)`,
        [a.tenantId, B.provider.providerAccountId, B.providerRev2.providerAccountRevisionId, sha('probe')],
      ],
      [
        'ledger correction of foreign evidence',
        `INSERT INTO evidence_ledger_entries (tenant_id, id, sequence, kind, trust, subject_aggregate_type, subject_aggregate_id, recorded_at, correlation_id, payload_schema, payload_digest, supersedes_evidence_id, previous_envelope_digest, envelope_digest)
         VALUES ($1, 'evd_probe-0001', 99, 'MATERIAL_INPUT', 'AUTHORITATIVE', 'asset', $2, now(), 'corr_probe-0001', 'x.v1', $3, $4, 'evidence-envelope.v1:sha256:${'1'.repeat(64)}', 'evidence-envelope.v1:sha256:${'2'.repeat(64)}')`,
        [a.tenantId, A.asset.assetId, sha('probe'), B.ledger.first.evidenceId],
      ],
      [
        'role assignment of a non-member user',
        `INSERT INTO role_assignments (tenant_id, id, principal_kind, user_id, role, granted_by_user_id)
         VALUES ($1, 'rla_probe-0001', 'HUMAN', $2, 'admin', $3)`,
        [a.tenantId, b.adminUserId, a.adminUserId],
      ],
    ];
    for (const [name, sql, params] of probes)
      await expect(db.admin(sql, params), name).rejects.toMatchObject({ code: '23503' });

    const assets = await listAssets(db.pool, ctxA, {});
    expect(assets.map((x) => x.assetId)).toEqual([A.asset.assetId]);
    expect(assets[0]!.current.tenantId).toBe(a.tenantId);
  });

  it('filters naming foreign IDs return nothing, and listings never include foreign rows', async () => {
    expect(await listAssets(db.pool, ctxA, { siteId: B.site.siteId })).toEqual([]);
    const sites = await listSites(db.pool, ctxA);
    expect(sites.map((s) => s.siteId).sort()).toEqual([A.site.siteId, A.site2.siteId].sort());
    expect(await listAuditEntries(db.pool, ctxA, { resourceId: B.asset.assetId, result: 'SUCCEEDED' })).toEqual([]);
  });

  it('exports contain only the caller tenant and declare their cut-off', async () => {
    const ledger = await exportEvidenceLedger(db.pool, ctxA);
    expect(ledger.tenantId).toBe(a.tenantId);
    expect(ledger.chain).toEqual({ ok: true });
    expect(ledger.entries.map((e) => e.evidenceId)).toEqual([
      A.ledger.first.evidenceId,
      A.ledger.correction.evidenceId,
    ]);
    expect(Number.isNaN(Date.parse(ledger.cutoffAt))).toBe(false);
    const audit = await exportAuditEntries(db.pool, ctxA);
    expect(audit.entries.length).toBeGreaterThan(5);
    const text = JSON.stringify(ledger, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + JSON.stringify(audit);
    for (const foreign of [b.tenantId, B.asset.assetId, B.ledger.first.evidenceId, B.site.siteId])
      expect(text).not.toContain(foreign);
  });

  it('outbox delivery and consumers derive tenant context from the durable row, never from the payload', async () => {
    // A forged payload claiming tenant B inside tenant A's event cannot redirect it.
    await withTenantTransaction(db.pool, ctxA, (client) =>
      appendOutboxEventForged(client, ctxA, b.tenantId, A.device.deviceId),
    );
    const delivered: DomainEventEnvelope[] = [];
    const publisher = new OutboxPublisher(
      db.pool,
      { publish: async (e) => void delivered.push(e) },
      {
        workerId: 't010-publisher',
      },
    );
    await publisher.drain();
    expect(delivered.length).toBeGreaterThan(0);
    for (const e of delivered) {
      DomainEventEnvelopeSchema.parse(e);
      const row = await db.admin(`SELECT tenant_id FROM outbox_events WHERE id = $1`, [e.eventId]);
      expect(e.tenantId).toBe(row.rows[0].tenant_id);
    }
    const forged = delivered.find((e) => (e.payload as { claimedTenantId?: string }).claimedTenantId);
    expect(forged?.tenantId).toBe(a.tenantId);
    const seen: string[] = [];
    await consumeOnce(db.pool, 't010-consumer', forged!, async (_client, ctx) => {
      seen.push(ctx.tenantId);
      await expect(getAsset(db.pool, ctx, B.asset.assetId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await getAsset(db.pool, ctx, A.asset.assetId)).assetId).toBe(A.asset.assetId);
    });
    expect(seen).toEqual([a.tenantId]);
  });

  it('jobs run under the tenant of their durable row; dedupe keys are tenant-namespaced', async () => {
    const ja = await withTenantTransaction(db.pool, ctxA, (c) =>
      enqueueJob(c, ctxA, { kind: 't010.probe', payload: { targetAssetId: B.asset.assetId }, dedupeKey: 'same-key' }),
    );
    const jb = await withTenantTransaction(db.pool, B.admin, (c) =>
      enqueueJob(c, B.admin, {
        kind: 't010.probe',
        payload: { targetAssetId: A.asset.assetId },
        dedupeKey: 'same-key',
      }),
    );
    expect(ja.jobId).not.toBe(jb.jobId);
    expect(ja.duplicate).toBe(false);
    expect(jb.duplicate).toBe(false);
    const claimed = await claimJobs(db.pool, { workerId: 't010-worker', kinds: ['t010.probe'], limit: 10 });
    expect(claimed.map((c) => c.ctx.tenantId).sort()).toEqual([a.tenantId, b.tenantId].sort());
    for (const c of claimed) {
      const target = (c.job.payload as { targetAssetId: string }).targetAssetId;
      expect(c.job.tenantId).toBe(c.ctx.tenantId);
      await expect(getAsset(db.pool, c.ctx, target as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await completeJob(db.pool, c);
    }
  });

  it('object keys are tenant-prefixed and verified, and the database refuses a foreign prefix', async () => {
    const key = tenantObjectKey(ctxA, 'evidence', sha('same-content'));
    expect(key.startsWith(`tenants/${a.tenantId}/evidence/`)).toBe(true);
    const ba = await registerEvidenceBlob(db.pool, ctxA, {
      sha256: sha('same-content'),
      mediaType: 'image/jpeg',
      sizeBytes: 10,
      trustLevel: 'OPERATOR_ATTESTED',
    });
    const bb = await registerEvidenceBlob(db.pool, B.admin, {
      sha256: sha('same-content'),
      mediaType: 'image/jpeg',
      sizeBytes: 10,
      trustLevel: 'OPERATOR_ATTESTED',
    });
    expect(ba.objectKey).not.toBe(bb.objectKey);
    expect(() => assertObjectKeyInTenant(ctxA, bb.objectKey)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => assertObjectKeyInTenant(ctxA, `tenants/${a.tenantId}/../${b.tenantId}/evidence/x`)).toThrow();
    expect(assertObjectKeyInTenant(ctxA, ba.objectKey)).toBe(ba.objectKey);
    await expect(
      db.admin(
        `INSERT INTO evidence_blobs (tenant_id, id, object_key, sha256, media_type, size_bytes, trust_level)
         VALUES ($1, 'blb_probe-0001', $2, $3, 'image/jpeg', 1, 'AUTHORITATIVE')`,
        [a.tenantId, bb.objectKey, sha('probe-object')],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('caches are tenant-namespaced', () => {
    const cache = new TenantScopedCache<string>();
    cache.set(ctxA, ['asset', 'shared-key'], 'alpha-value');
    expect(cache.get(B.admin, ['asset', 'shared-key'])).toBeUndefined();
    expect(cache.get(ctxA, ['asset', 'shared-key'])).toBe('alpha-value');
  });

  it('webhook bindings and provider events are namespaced by tenant and provider account', async () => {
    const bindA = await resolveWebhookBinding(db.pool, A.provider.webhookBinding);
    const bindB = await resolveWebhookBinding(db.pool, B.provider.webhookBinding);
    expect(bindA.tenantId).toBe(a.tenantId);
    expect(bindB.tenantId).toBe(b.tenantId);
    expect(bindA.providerAccountRevisionId).toBe(A.providerRev2.providerAccountRevisionId);
    // The same provider event id exists independently in both tenants; a replay in A is a duplicate in A only.
    const replay = await recordWebhookDelivery(db.pool, bindA, {
      providerEventId: 'evt-provider-0001',
      signatureValid: true,
      bodyDigest: sha('alpha-webhook-body'),
    });
    expect(replay).toEqual({ deliveryId: A.delivery.deliveryId, duplicate: true });
    expect(A.delivery.deliveryId).not.toBe(B.delivery.deliveryId);
    expect(
      (await findWebhookDelivery(db.pool, ctxA, A.provider.providerAccountId, 'evt-provider-0001'))?.deliveryId,
    ).toBe(A.delivery.deliveryId);
    const crossFind = await rejection(
      findWebhookDelivery(db.pool, ctxA, B.provider.providerAccountId, 'evt-provider-0001'),
    );
    const missingFind = await rejection(
      findWebhookDelivery(db.pool, ctxA, newId('providerAccount'), 'evt-provider-0001'),
    );
    expect(crossFind.code).toBe('FORBIDDEN');
    expect(crossFind).toEqual(missingFind);
    const unknown = await rejection(resolveWebhookBinding(db.pool, 'not-a-real-binding-0000000000000000000000'));
    expect(unknown.code).toBe('UNAUTHENTICATED');
    const sec = await listSecurityAuditEntries(db.pool, { action: 'webhook.resolve' });
    expect(sec.some((s) => s.result === 'DENIED' && s.reasonCode === 'UNKNOWN_WEBHOOK_BINDING')).toBe(true);
    expect(JSON.stringify(sec)).not.toContain('not-a-real-binding');
  });

  it('X-Tenant-ID naming a non-member tenant is rejected identically whether or not it exists, and audited', async () => {
    const member = await rejection(humanContext(db.pool, idp, a.adminSubject, b.tenantId));
    const missing = await rejection(humanContext(db.pool, idp, a.adminSubject, newId('tenant')));
    const malformed = await rejection(humanContext(db.pool, idp, a.adminSubject, "' OR 1=1 --"));
    expect(member.code).toBe('FORBIDDEN');
    expect(member).toEqual(missing);
    expect(member).toEqual(malformed);
    const sec = await listSecurityAuditEntries(db.pool, { action: 'tenant.resolve' });
    const mine = sec.filter((s) => s.principal.id === a.adminUserId && s.result === 'DENIED');
    expect(mine.length).toBeGreaterThanOrEqual(3);
    for (const s of mine) {
      expect(s.requestedTenantDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(JSON.stringify(s)).not.toContain(b.tenantId);
    }
    expect(mine.map((s) => s.requestedTenantDigest)).toContain(
      `sha256:${createHash('sha256').update(b.tenantId).digest('hex')}`,
    );

    // Absent header defaults only to a single membership.
    const single = await humanContext(db.pool, idp, a.adminSubject);
    expect(single.tenantId).toBe(a.tenantId);
    const both = `both-${Date.now()}`;
    const user = await upsertUser(db.pool, { issuer: idp.issuer, externalSubject: both, displayName: 'two tenants' });
    await addMembership(db.pool, ctxA, user.userId);
    await addMembership(db.pool, B.admin, user.userId);
    expect((await rejection(humanContext(db.pool, idp, both))).code).toBe('VALIDATION_FAILED');
    expect((await humanContext(db.pool, idp, both, b.tenantId)).tenantId).toBe(b.tenantId);

    // Device principals are bound to their own tenant.
    const creds = resolver();
    const key = syntheticKey();
    creds.set(`secretref:device/alpha-1`, key);
    const device = await authenticateDevice(db.pool, creds, await signPrincipalToken('DEVICE', A.device.deviceId, key));
    expect((await rejection(resolveTenantContext(db.pool, device, b.tenantId))).code).toBe('FORBIDDEN');
    expect((await resolveTenantContext(db.pool, device, undefined)).tenantId).toBe(a.tenantId);
  });

  it('a tenant context cannot be forged from client-supplied fields', async () => {
    const forged = { ...ctxA, tenantId: b.tenantId } as TenantContext;
    await expect(getSite(db.pool, forged, B.site.siteId)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const literal = JSON.parse(JSON.stringify(ctxA)) as TenantContext;
    await expect(listSites(db.pool, literal)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(() => new TenantScopedCache<string>().get(forged, ['x'])).toThrow();
    expect(money(1n, 'USD').amountMinor).toBe(1n);
  });
});

// Appends a device event whose payload claims another tenant; the envelope must still carry the row tenant.
async function appendOutboxEventForged(
  client: Parameters<Parameters<typeof withTenantTransaction>[2]>[0],
  ctx: TenantContext,
  claimedTenantId: string,
  deviceId: string,
) {
  const { appendOutboxEvent } = await import('../src/index.js');
  return appendOutboxEvent(client, ctx, {
    eventType: 'telemetry.stale.v1',
    aggregateType: 'device',
    aggregateId: deviceId,
    aggregateVersion: 1,
    payload: { claimedTenantId, tenantId: claimedTenantId },
    correlationId: newId('correlation'),
    causationId: newId('command'),
  });
}
