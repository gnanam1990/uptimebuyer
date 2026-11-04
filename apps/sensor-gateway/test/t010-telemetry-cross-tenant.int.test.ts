// T-010 — Cross-tenant access denial, re-run by M03 against the telemetry surfaces (INV-16, TEST-PLAN coverage rule).
// Tenant A's devices and users cannot read, infer or change tenant B telemetry, health, gaps, disclosures or
// rejections: foreign ids behave exactly like nonexistent ids, are audited in A only, and leave B unchanged; a device
// cannot route data into another tenant by naming its channel or its tenant; the sweeper keeps each row's tenant.
import { newId } from '@uptimebuyer/contracts';
import {
  createSite,
  getDeviceHealth,
  listDropDisclosures,
  listSequenceGaps,
  listTelemetryRejections,
  listTelemetrySamples,
  registerAsset,
  sweepTelemetryFreshness,
  type SensorChannelId,
  type TenantContext,
} from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorld,
  message,
  post,
  provisionDevice,
  seedTenant,
  sleep,
  syncClock,
  telemetryCounts,
  temp,
  type SeededTenant,
  type TestDevice,
  type World,
} from './helpers.js';

let w: World;
let devA: TestDevice;
let b: SeededTenant;
let devB: TestDevice;

async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; httpStatus?: number; message?: string; details?: unknown };
    return { code: err.code, httpStatus: err.httpStatus, message: err.message, details: err.details };
  }
  throw new Error('expected rejection');
}

async function tenantTelemetryDigest(tenantId: string): Promise<string> {
  const parts: string[] = [];
  for (const t of [
    'telemetry_batches',
    'telemetry_samples',
    'telemetry_rejections',
    'telemetry_sequence_gaps',
    'telemetry_drop_disclosures',
    'telemetry_channel_health',
  ]) {
    const r = await w.db.admin(
      `SELECT coalesce(md5(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text)), '') AS d FROM ${t} x WHERE tenant_id = $1`,
      [tenantId],
    );
    parts.push(`${t}=${r.rows[0].d}`);
  }
  return parts.join(';');
}

describe('T-010 telemetry cross-tenant access denial', () => {
  beforeAll(async () => {
    w = await createWorld('t010m03');
    devA = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    b = await seedTenant(w.db.pool, w.idp, 't010m03-beta');
    const siteB = await createSite(w.db.pool, b.admin, { name: 'beta store', timezone: 'UTC', source: 'API' });
    const assetB = await registerAsset(w.db.pool, b.admin, {
      siteId: siteB.siteId,
      identity: {
        manufacturer: 'True',
        model: 'T-23',
        serial: 'beta-SN-1',
        safetyClass: 'STANDARD',
        bomRevision: 'B1',
      },
      source: 'API',
    });
    devB = await provisionDevice(w, { siteId: siteB.siteId, assetId: assetB.assetId, admin: b.admin });
    await sleep(20);
    const now = syncClock(w);
    await post(w, devB, [
      message(1, now - 20, [temp(devB.channels.temp!, 3900)]),
      message(5, now - 10, [temp(devB.channels.temp!, 3900)]),
    ]);
    await post(w, devB, [message(9, now - 5, [temp(devB.channels.door!, 3900)])]);
    await post(w, devA, [message(1, now - 5, [temp(devA.channels.temp!, 3900)])]);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('every M03 table is tenant-owned with a (tenant_id, id) key and tenant-leading foreign keys', async () => {
    const tables = [
      'telemetry_batches',
      'telemetry_samples',
      'telemetry_rejections',
      'telemetry_sequence_gaps',
      'telemetry_drop_disclosures',
      'telemetry_channel_health',
    ];
    for (const t of tables) {
      const pk = await w.db.admin(
        `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols FROM pg_constraint c
           CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          WHERE c.conrelid = $1::regclass AND c.contype = 'p' GROUP BY c.oid`,
        [t],
      );
      expect(pk.rows[0].cols, t).toEqual(['tenant_id', 'id']);
      const fks = await w.db.admin(
        `SELECT conname, (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1]) AS first_col
           FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'f'`,
        [t],
      );
      expect(fks.rows.length, t).toBeGreaterThan(0);
      for (const fk of fks.rows) expect(fk.first_col, `${t}.${fk.conname}`).toBe('tenant_id');
    }
  });

  it('foreign telemetry ids are denied exactly like nonexistent ids, audited in A only, and B is unchanged', async () => {
    const ctxA: TenantContext = w.admin;
    const beforeB = await tenantTelemetryDigest(b.tenantId);
    const auditB = await w.db.admin(`SELECT count(*)::int AS n FROM audit_entries WHERE tenant_id = $1`, [b.tenantId]);
    const fakeChannel = newId('device').replace('dev_', 'chn_') as SensorChannelId;
    const now = new Date(w.clock.now()).toISOString();
    const probes: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
      [
        'getDeviceHealth',
        () => getDeviceHealth(w.db.pool, ctxA, devB.deviceId, { now: now as never }),
        () => getDeviceHealth(w.db.pool, ctxA, newId('device'), { now: now as never }),
      ],
      [
        'listTelemetrySamples',
        () => listTelemetrySamples(w.db.pool, ctxA, { channelId: devB.channels.temp! }),
        () => listTelemetrySamples(w.db.pool, ctxA, { channelId: fakeChannel }),
      ],
      [
        'listSequenceGaps',
        () => listSequenceGaps(w.db.pool, ctxA, devB.deviceId),
        () => listSequenceGaps(w.db.pool, ctxA, newId('device')),
      ],
      [
        'listDropDisclosures',
        () => listDropDisclosures(w.db.pool, ctxA, devB.deviceId),
        () => listDropDisclosures(w.db.pool, ctxA, newId('device')),
      ],
      [
        'listTelemetryRejections',
        () => listTelemetryRejections(w.db.pool, ctxA, devB.deviceId),
        () => listTelemetryRejections(w.db.pool, ctxA, newId('device')),
      ],
    ];
    for (const [name, foreign, missing] of probes) {
      const f = await rejection(foreign());
      const m = await rejection(missing());
      expect(f, name).toEqual(m);
      expect(f.code, name).toBe('FORBIDDEN');
    }
    expect(await tenantTelemetryDigest(b.tenantId)).toBe(beforeB);
    const auditBAfter = await w.db.admin(`SELECT count(*)::int AS n FROM audit_entries WHERE tenant_id = $1`, [
      b.tenantId,
    ]);
    expect(auditBAfter.rows[0].n).toBe(auditB.rows[0].n);
    const auditA = await w.db.admin(
      `SELECT resource_id, metadata FROM audit_entries WHERE tenant_id = $1 AND result = 'DENIED' AND action LIKE 'telemetry.%'`,
      [w.tenant.tenantId],
    );
    expect(auditA.rows.length).toBeGreaterThanOrEqual(probes.length * 2);
    expect(JSON.stringify(auditA.rows)).not.toContain(devB.deviceId);
  });

  it("a device cannot write into another tenant by naming that tenant's channel or the tenant itself", async () => {
    const beforeB = await tenantTelemetryDigest(b.tenantId);
    const now = syncClock(w);
    const viaChannel = await post(w, devA, [message(50, now - 5, [temp(devB.channels.temp!, 1)])]);
    const viaMissing = await post(w, devA, [message(51, now - 5, [temp(newId('device').replace('dev_', 'chn_'), 1)])]);
    expect(viaChannel.body.results![0]).toMatchObject({ status: 'REJECTED', reasonCode: 'CHANNEL_UNKNOWN' });
    expect(viaMissing.body.results![0]).toMatchObject({ status: 'REJECTED', reasonCode: 'CHANNEL_UNKNOWN' });
    const viaHeader = await post(w, devA, [message(52, now - 5, [temp(devA.channels.temp!, 1)])], {
      tenantHeader: b.tenantId,
    });
    expect(viaHeader.status).toBe(403);
    const asB = await post(w, devA, [message(53, now - 5, [temp(devA.channels.temp!, 1)])], {
      bodyDeviceId: devB.deviceId,
    });
    expect(asB.status).toBe(403);
    // devA's key cannot impersonate devB
    const impersonate = await post(w, { ...devB, key: devA.key }, [
      message(54, now - 5, [temp(devB.channels.temp!, 1)]),
    ]);
    expect(impersonate.status).toBe(401);
    expect(await tenantTelemetryDigest(b.tenantId)).toBe(beforeB);
    const rows = await w.db.admin(`SELECT DISTINCT tenant_id FROM telemetry_rejections WHERE device_id = $1`, [
      devA.deviceId,
    ]);
    expect(rows.rows.map((r) => r.tenant_id)).toEqual([w.tenant.tenantId]);
  });

  it('the freshness sweeper keeps every projection and event in its own tenant', async () => {
    const before = await telemetryCounts(w.db, b.tenantId);
    const r = await sweepTelemetryFreshness(w.db.pool, { now: new Date(w.clock.now() + 3_600_000).toISOString() });
    expect(r.transitions.length).toBeGreaterThan(0);
    for (const t of r.transitions) {
      const row = await w.db.admin(`SELECT tenant_id FROM telemetry_channel_health WHERE channel_id = $1`, [
        t.channelId,
      ]);
      expect(row.rows[0].tenant_id).toBe(t.tenantId);
    }
    const ev = await w.db.admin(
      `SELECT e.tenant_id, e.aggregate_id, d.tenant_id AS device_tenant FROM outbox_events e
         JOIN devices d ON d.id = e.aggregate_id WHERE e.event_type = 'telemetry.stale.v1'`,
    );
    expect(ev.rows.length).toBeGreaterThan(0);
    for (const e of ev.rows) expect(e.tenant_id).toBe(e.device_tenant);
    expect((await telemetryCounts(w.db, b.tenantId)).telemetry_samples).toBe(before.telemetry_samples);
  });
});
