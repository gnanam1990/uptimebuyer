// T-053 tenant and site escape (INV-16, FR-24) beyond the per-route IDOR matrix of T-010/T-011:
// - every child table: a catalog scan proves each tenant-owned table leads its key with tenant_id, references tenants,
//   and that every foreign key between tenant-owned tables carries tenant_id at the same position (so no row can point
//   at another tenant's parent), with concrete refused inserts as controls;
// - jobs: a queued job of tenant B naming tenant A's order runs under B's worker context and cannot touch A;
// - callbacks: tenant B's signed fulfillment webhook and tenant B's signed CMMS record naming tenant A's objects are
//   quarantined/refused and A changes nothing;
// - objects: evidence object keys are tenant-namespaced and tenant B cannot read tenant A's citation;
// - caches: tenant A exhausting an authority-command rate bucket leaves tenant B's bucket intact;
// - exports and observability: ledger/audit exports and API logs of tenant B never contain tenant A identifiers.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSite, exportAuditEntries, exportEvidenceLedger, type TenantContext } from '@uptimebuyer/data';
import { ingestFulfillmentWebhook, runFulfillmentObservationJobs } from '@uptimebuyer/orders';
import { objectKeyFor, parseObjectKey } from '@uptimebuyer/evidence';
import { MemorySink, StructuredLogger } from '@uptimebuyer/observability';
import { humanContext } from '../../../packages/data/test/helpers.js';
import { eventBody, paidFulfillmentAccount, view, webhook } from './m10-helpers.js';
import {
  cmmsBinding,
  cmmsRecord,
  sendCmms,
  verifyingIncident,
  type CmmsBinding,
  type VerifyingIncident,
} from './m11-helpers.js';
import { buildApiFor, call, createApiWorld, errorOf, pendingApproval, type ApiWorld } from './m12-helpers.js';

let w: ApiWorld;
let v: VerifyingIncident;
let bAdmin: TenantContext;
let bOperator: TenantContext;
let bAccount: Awaited<ReturnType<typeof paidFulfillmentAccount>>;
let bCmms: CmmsBinding;

beforeAll(async () => {
  w = await createApiWorld('t053iso');
  v = await verifyingIncident(w);
  bAdmin = await humanContext(w.db.pool, w.idp, w.tenantB.adminSubject, w.tenantB.tenantId);
  bOperator = await humanContext(w.db.pool, w.idp, w.tenantB.operatorSubject, w.tenantB.tenantId);
  bAccount = await paidFulfillmentAccount(w, bAdmin, 't053iso-b');
  const bSite = await createSite(w.db.pool, bAdmin, { name: 'Beta depot', timezone: 'UTC', source: 'API' });
  bCmms = await cmmsBinding(w, bSite.siteId, 't053iso-b', bAdmin);
}, 300_000);
afterAll(async () => {
  await w?.close();
});

describe('T-053 tenant escape on every child table (catalog)', () => {
  it('every tenant-owned table is keyed and referenced by tenant', async () => {
    const tables = (
      await w.db.pool.query<{ relname: string; pk: string[] | null; has_tenant_fk: boolean }>(
        `SELECT c.relname,
                (SELECT array_agg(a.attname ORDER BY k.ord) FROM pg_constraint p,
                        unnest(p.conkey) WITH ORDINALITY k(attnum, ord), pg_attribute a
                  WHERE p.conrelid = c.oid AND p.contype = 'p' AND a.attrelid = c.oid AND a.attnum = k.attnum) AS pk,
                EXISTS (SELECT 1 FROM pg_constraint f WHERE f.conrelid = c.oid AND f.contype = 'f'
                          AND f.confrelid = 'tenants'::regclass) AS has_tenant_fk
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`,
      )
    ).rows;
    expect(tables.length).toBeGreaterThanOrEqual(118);
    // outbox_consumer_receipts is keyed by (consumer, event id) and carries a composite FK to the tenant's event.
    const unkeyed = tables.filter((t) => t.pk?.[0] !== 'tenant_id' && t.relname !== 'outbox_consumer_receipts');
    expect(unkeyed.map((t) => t.relname)).toEqual([]);
    expect(tables.filter((t) => !t.has_tenant_fk).map((t) => t.relname)).toEqual([]);
  });

  it('every foreign key between tenant-owned tables carries tenant_id at the same position', async () => {
    const { rows } = await w.db.pool.query(
      `WITH fk AS (
         SELECT c.conname, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
           (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS ccols,
           (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS pcols
           FROM pg_constraint c WHERE c.contype = 'f')
       SELECT child, parent, conname, ccols, pcols,
              array_position(ccols, 'tenant_id'::name) IS NOT NULL
                AND array_position(ccols, 'tenant_id'::name) = array_position(pcols, 'tenant_id'::name) AS composite
         FROM fk
        WHERE EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = fk.child::regclass AND attname = 'tenant_id')
          AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = fk.parent::regclass AND attname = 'tenant_id')`,
    );
    expect(rows.length).toBeGreaterThan(200);
    expect(rows.filter((r) => !r.composite).map((r) => `${r.child}.${r.conname}`)).toEqual([]);
  });

  it('controls: tenant B rows pointing at tenant A parents are refused by the database', async () => {
    const fk = (p: Promise<unknown>) =>
      p.then(
        () => 'OK',
        (e: { code?: string }) => e.code,
      );
    expect(
      await fk(
        w.db.pool.query(
          `INSERT INTO legal_holds (tenant_id, id, scope_type, scope_id, reason_code, placed_by_user_id, site_id, asset_id, incident_id)
           VALUES ($1, 'lgh_' || gen_random_uuid(), 'INCIDENT', $2, 'X', $3, $4, $5, $2)`,
          [w.tenantB.tenantId, v.incidentId, bAdmin.principal.id, w.siteId, v.assetId],
        ),
      ),
    ).toBe('23503');
    expect(
      await fk(
        w.db.pool.query(
          `INSERT INTO jobs (tenant_id, id, kind, payload) VALUES ($1, 'job_' || gen_random_uuid(), 'x.y', '{}')`,
          ['ten_00000000-dead-4000-8000-000000000000'],
        ),
      ),
    ).toBe('23503');
  });
});

describe('T-053 job, callback and object isolation', () => {
  it('a tenant B job naming tenant A order is processed under B and cannot touch A', async () => {
    const before = await view(w, v.orderId);
    const obsBefore = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM fulfillment_observations WHERE purchase_order_id = $1`,
      [v.orderId],
    );
    await w.db.pool.query(
      `INSERT INTO jobs (tenant_id, id, kind, payload, dedupe_key, max_attempts)
       VALUES ($1, 'job_' || gen_random_uuid(), 'orders.fulfillment_observation', $2, $3, 1)`,
      [
        w.tenantB.tenantId,
        JSON.stringify({
          deliveryId: 'whd_00000000-0000-4000-8000-000000000000',
          orderId: v.orderId,
          revisionId: w.account.revisionId,
          eventId: `evt-${randomBytes(4).toString('hex')}`,
          status: 'cancelled',
          observedAt: new Date().toISOString(),
          sequence: null,
          providerRef: null,
          details: {},
          rawBody: Buffer.from('{}').toString('base64'),
          rawBodyDigest: `sha256:${'0'.repeat(64)}`,
        }),
        `t053-escape-${randomBytes(4).toString('hex')}`,
      ],
    );
    await runFulfillmentObservationJobs(w.db.pool, { workerId: 't053' });
    expect((await view(w, v.orderId)).state).toBe(before.state);
    const obsAfter = await w.db.pool.query(
      `SELECT count(*)::int AS n FROM fulfillment_observations WHERE purchase_order_id = $1`,
      [v.orderId],
    );
    expect(obsAfter.rows[0].n).toBe(obsBefore.rows[0].n);
    const job = await w.db.pool.query(
      `SELECT state FROM jobs WHERE tenant_id = $1 AND kind = 'orders.fulfillment_observation'`,
      [w.tenantB.tenantId],
    );
    expect(job.rows.map((r) => r.state)).toEqual(['DEAD']);
  });

  it("tenant B's signed webhook naming tenant A's client operation is quarantined", async () => {
    const order = await view(w, v.orderId);
    const r = await ingestFulfillmentWebhook(
      w.db.pool,
      webhook(bAccount.binding, bAccount.verifierKey, eventBody(order, 'cancelled')),
      { credentials: w.creds },
    );
    expect(r).toMatchObject({ status: 'QUARANTINED', reasonCode: 'TARGET_NOT_FOUND' });
    expect((await view(w, v.orderId)).state).toBe(order.state);
    // Tenant A's key over tenant B's binding is a signature failure, not a cross-tenant match.
    const forged = await ingestFulfillmentWebhook(
      w.db.pool,
      webhook(bAccount.binding, w.account.verifierKey, eventBody(order, 'cancelled')),
      { credentials: w.creds },
    );
    expect(forged.status).toBe('REJECTED');
  });

  it("tenant B's signed CMMS record naming tenant A's incident is refused", async () => {
    const before = await w.db.pool.query(`SELECT count(*)::int AS n FROM recovery_evidence WHERE incident_id = $1`, [
      v.incidentId,
    ]);
    const out = await sendCmms(w, bCmms, cmmsRecord(v, Date.now())).then(
      (x) => x,
      (e: { code?: string }) => ({ refused: e.code }),
    );
    expect(out).toMatchObject({ refused: expect.stringMatching(/FORBIDDEN|VALIDATION_FAILED|POLICY_HOLD/) });
    const after = await w.db.pool.query(`SELECT count(*)::int AS n FROM recovery_evidence WHERE incident_id = $1`, [
      v.incidentId,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('object keys are tenant-namespaced and a key cannot be re-homed to another tenant', () => {
    const key = objectKeyFor(w.tenant.tenantId, 'document', `sha256:${'a'.repeat(64)}`);
    expect(parseObjectKey(key).tenantId).toBe(w.tenant.tenantId);
    expect(key.startsWith(`tenants/${w.tenant.tenantId}/`)).toBe(true);
    for (const bad of [
      `tenants/${w.tenant.tenantId}/../${w.tenantB.tenantId}/document/${'a'.repeat(64)}`,
      `/etc/passwd`,
    ])
      expect(() => parseObjectKey(bad)).toThrow();
  });
});

describe('T-053 cache, export and observability isolation', () => {
  it("tenant A exhausting the authority-command bucket does not throttle tenant B's principal", async () => {
    const api = await buildApiFor(w, {
      limits: { sensitiveCommands: { capacity: 1, refillPerSecond: 0.001, maxKeys: 100 } },
    });
    const p = await pendingApproval(w);
    const hold = (subject: string, body: unknown, url: string) =>
      call({ app: api.app, idp: w.idp }, subject, 'POST', url, { body });
    const url = `/v1/plans/${p.planId}:hold`;
    const body = { approvalRequestId: p.approvalRequestId, reasonCode: 'NEEDS_SECOND_QUOTE' };
    await hold(w.subjects.approver!, body, url);
    expect(errorOf(await hold(w.subjects.approver!, body, url)).reasonCode).toBe('COMMAND_RATE_EXCEEDED');
    // Tenant B's principal still has its own budget (it is refused for the resource, not for the rate).
    const b = errorOf(await hold(w.tenantB.operatorSubject, body, url));
    expect(b.reasonCode).not.toBe('COMMAND_RATE_EXCEEDED');
    await api.app.close();
  });

  it("tenant B's ledger and audit exports never contain tenant A rows or identifiers", async () => {
    const ledger = await exportEvidenceLedger(w.db.pool, bAdmin);
    const audit = await exportAuditEntries(w.db.pool, bAdmin);
    const text = JSON.stringify([ledger, audit]);
    for (const id of [w.tenant.tenantId, v.incidentId, v.orderId, v.assetId, w.siteId]) expect(text).not.toContain(id);
  });

  it("tenant B's API request logs carry only tenant B context", async () => {
    const sink = new MemorySink();
    const api = await buildApiFor(w, {
      observability: { logger: new StructuredLogger({ service: 'api', sink: sink.write }) },
    });
    await call({ app: api.app, idp: w.idp }, w.tenantB.operatorSubject, 'GET', `/v1/incidents/${v.incidentId}`);
    await call({ app: api.app, idp: w.idp }, w.tenantB.operatorSubject, 'GET', '/v1/incidents');
    const recs = sink.records().filter((r) => r.event === 'http.request');
    expect(recs).toHaveLength(2);
    for (const r of recs) {
      expect(r.tenantId).toBe(w.tenantB.tenantId);
      expect(JSON.stringify(r)).not.toContain(w.tenant.tenantId);
      expect(JSON.stringify(r)).not.toContain(v.incidentId);
    }
    void bOperator;
    await api.app.close();
  });
});
