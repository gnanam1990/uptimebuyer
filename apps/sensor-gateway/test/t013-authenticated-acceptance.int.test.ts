// T-013 — Authenticated telemetry acceptance (FR-02, INV-16, NFR-04).
// A provisioned device submits valid readings whose source time resolves to exactly one tenant-matched immutable
// device-to-asset assignment and channel/calibration revision; those IDs are stored on every sample. Invalid
// identity or signature, a foreign or malformed tenant, and a missing, overlapping or superseded binding are rejected
// without storing a sample.
import { randomBytes } from 'node:crypto';
import { newId } from '@uptimebuyer/contracts';
import {
  authenticateDevice,
  getAsset,
  listDeviceAssignments,
  listSensorChannelRevisions,
  listTelemetryRejections,
  listTelemetrySamples,
  registerServiceIdentity,
  reviseAssetIdentity,
  setDeviceStatus,
  signPrincipalToken,
} from '@uptimebuyer/data';
import { TelemetryAcceptedEventSchema, TELEMETRY_LIMITS } from '@uptimebuyer/telemetry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorld,
  identityOf,
  message,
  post,
  provisionDevice,
  seedTenant,
  sleep,
  syncClock,
  telemetryCounts,
  temp,
  type TestDevice,
  type World,
} from './helpers.js';

let w: World;
let dev: TestDevice;
const WORKLOAD = 'general-worker' as const;

describe('T-013 authenticated telemetry acceptance', () => {
  beforeAll(async () => {
    w = await createWorld('t013');
    dev = await provisionDevice(w, {
      siteId: w.siteId,
      assetId: w.assetId,
      channels: [
        { name: 'temp', kind: 'TEMPERATURE', sourceUnit: 'FAHRENHEIT' },
        { name: 'door', kind: 'DOOR' },
      ],
    });
    // the first accepted reading is 250 ms old, so it must postdate the channel revisions created above
    await sleep(300);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('accepts valid readings and pins assignment, asset revision, channel and calibration revision on every sample', async () => {
    const now = syncClock(w);
    const r = await post(w, dev, [
      message(1, now - 250, [
        { channel: dev.channels.temp!, valueInt: 39_614, unit: 'mF', quality: 'GOOD' },
        { channel: dev.channels.door!, valueInt: 0, unit: 'bool', quality: 'GOOD' },
      ]),
    ]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accepted: 2, duplicates: 0, rejected: 0 });
    expect(r.body.results!.map((x) => x.status)).toEqual(['ACCEPTED', 'ACCEPTED']);

    const [assignment] = await listDeviceAssignments(w.db.pool, w.admin, dev.deviceId);
    const asset = await getAsset(w.db.pool, w.admin, w.assetId);
    const [tempRev] = await listSensorChannelRevisions(w.db.pool, w.admin, dev.channels.temp!);
    const [sample] = await listTelemetrySamples(w.db.pool, w.admin, { channelId: dev.channels.temp! });
    expect(sample).toMatchObject({
      deviceId: dev.deviceId,
      channelId: dev.channels.temp,
      channelRevisionId: tempRev!.channelRevisionId,
      calibrationRevision: 1,
      deviceAssignmentId: assignment!.assignmentId,
      assetId: w.assetId,
      assetRevisionId: asset.current.assetRevisionId,
      bootId: 'boot_fixture-0001',
      sequence: 1,
      eventAt: new Date(now - 250).toISOString(),
      receivedAt: new Date(now).toISOString(),
      kind: 'TEMPERATURE',
      unit: 'MILLI_CELSIUS',
      // 39.614 °F is exactly 4.230 °C; the source value and unit are retained
      valueInt: 4230,
      rawValueInt: 4230,
      sourceUnit: 'mF',
      sourceValueInt: 39_614,
      conversion: 'EXACT',
      qualityFlags: [],
      ingestionClass: 'LIVE',
      latenessMs: 250,
      latenessPolicyVersion: 'telemetry-lateness.v1',
      inputOrigin: 'PHYSICAL_SENSOR',
    });
    expect(sample!.sampleDigest).toMatch(/^telemetry-sample\.v1:sha256:[0-9a-f]{64}$/);

    const ev = await w.db.admin(
      `SELECT * FROM outbox_events WHERE tenant_id = $1 AND event_type = 'telemetry.accepted.v1' AND aggregate_id = $2`,
      [w.tenant.tenantId, dev.deviceId],
    );
    expect(ev.rows).toHaveLength(1);
    const envelope = TelemetryAcceptedEventSchema.parse({
      eventId: ev.rows[0].id,
      eventType: ev.rows[0].event_type,
      occurredAt: new Date(ev.rows[0].occurred_at).toISOString(),
      tenantId: ev.rows[0].tenant_id,
      aggregateType: ev.rows[0].aggregate_type,
      aggregateId: ev.rows[0].aggregate_id,
      aggregateVersion: ev.rows[0].aggregate_version,
      correlationId: ev.rows[0].correlation_id,
      causationId: ev.rows[0].causation_id,
      schemaVersion: 1,
      payload: ev.rows[0].payload,
    });
    expect(envelope.payload).toMatchObject({
      deviceId: dev.deviceId,
      acceptedCount: 2,
      classCounts: { LIVE: 2, LATE: 0, BACKFILL: 0 },
      inputOrigin: 'PHYSICAL_SENSOR',
    });
  });

  it('rejects invalid identity, signature and tenant at the request boundary and stores nothing', async () => {
    const now = syncClock(w);
    const ok = [message(100, now - 100, [temp(dev.channels.door!, 1, { unit: 'bool' })])];
    const serviceRef = `secretref:service/tenants/${w.tenant.tenantId}/svc-${randomBytes(4).toString('hex')}`;
    const service = await registerServiceIdentity(w.db.pool, w.admin, {
      workload: WORKLOAD,
      credentialRef: serviceRef,
    });
    const serviceKey = new Uint8Array(randomBytes(32));
    w.creds.set(serviceRef, serviceKey);
    const other = await seedTenant(w.db.pool, w.idp, 't013-beta');
    const replayed = await signPrincipalToken('DEVICE', dev.deviceId, dev.key);
    expect((await post(w, dev, [message(101, now - 100, ok[0]!.samples)], { token: replayed })).status).toBe(200);
    const before = await telemetryCounts(w.db);

    const cases: [string, Promise<{ status: number; body: Record<string, unknown> }>, number, string][] = [
      ['missing token', post(w, dev, ok, { token: null }), 401, 'UNAUTHENTICATED'],
      ['malformed token', post(w, dev, ok, { token: 'not-a-token' }), 401, 'UNAUTHENTICATED'],
      [
        'token signed with a wrong key',
        post(w, dev, ok, { tokenKey: new Uint8Array(randomBytes(32)) }),
        401,
        'UNAUTHENTICATED',
      ],
      ['replayed token', post(w, dev, ok, { token: replayed }), 401, 'UNAUTHENTICATED'],
      [
        'service token on the device route',
        post(w, dev, ok, { token: await signPrincipalToken('SERVICE', service.serviceIdentityId, serviceKey) }),
        401,
        'UNAUTHENTICATED',
      ],
      ['missing body signature', post(w, dev, ok, { signature: null }), 401, 'UNAUTHENTICATED'],
      [
        'body signed with a wrong key',
        post(w, dev, ok, { signingKey: new Uint8Array(randomBytes(32)) }),
        401,
        'UNAUTHENTICATED',
      ],
      [
        'body tampered after signing',
        post(w, dev, ok, { mutateBody: (raw) => raw.replace('"valueInt":1', '"valueInt":0') }),
        401,
        'UNAUTHENTICATED',
      ],
      ['stale signing timestamp', post(w, dev, ok, { timestampMs: now - 301_000 }), 401, 'UNAUTHENTICATED'],
      ['future signing timestamp', post(w, dev, ok, { timestampMs: now + 301_000 }), 401, 'UNAUTHENTICATED'],
      ['foreign tenant header', post(w, dev, ok, { tenantHeader: other.tenantId }), 403, 'FORBIDDEN'],
      ['malformed tenant header', post(w, dev, ok, { tenantHeader: 'tenant-b' }), 403, 'FORBIDDEN'],
      ['body names another device', post(w, dev, ok, { bodyDeviceId: newId('device') }), 403, 'FORBIDDEN'],
      ['payload asserts an asset', post(w, dev, ok, { extra: { assetId: w.assetId } }), 400, 'VALIDATION_FAILED'],
      [
        'payload asserts a tenant',
        post(w, dev, ok, { extra: { tenantId: w.tenant.tenantId } }),
        400,
        'VALIDATION_FAILED',
      ],
    ];
    for (const [name, p, status, code] of cases) {
      const r = await p;
      expect(r.status, name).toBe(status);
      expect((r.body.error as { code: string }).code, name).toBe(code);
      expect(JSON.stringify(r.body), name).not.toMatch(/secretref|stack|signature mismatch/i);
    }
    expect(await telemetryCounts(w.db)).toEqual(before);
    const denials = await w.db.admin(
      `SELECT reason_code FROM audit_entries WHERE tenant_id = $1 AND action = 'telemetry.ingest' AND result = 'DENIED'`,
      [w.tenant.tenantId],
    );
    expect(denials.rows.map((r) => r.reason_code)).toEqual(
      expect.arrayContaining(['SIGNATURE_MISSING', 'SIGNATURE_INVALID', 'TIMESTAMP_SKEW', 'DEVICE_MISMATCH']),
    );
  });

  it('bounds the request body and the batch size', async () => {
    const now = syncClock(w);
    const before = await telemetryCounts(w.db);
    const huge = Array.from({ length: TELEMETRY_LIMITS.maxMessagesPerBatch + 1 }, (_, i) =>
      message(1000 + i, now - 10, [temp(dev.channels.door!, 1, { unit: 'bool' })]),
    );
    const tooMany = await post(w, dev, huge);
    expect([400, 413]).toContain(tooMany.status);
    const padded = await post(w, dev, [message(2000, now, [temp(dev.channels.door!, 1, { unit: 'bool' })])], {
      extra: { firmware: 'x'.repeat(TELEMETRY_LIMITS.maxBodyBytes) },
    });
    expect(padded.status).toBe(413);
    expect(await telemetryCounts(w.db)).toEqual(before);
  });

  it('rejects a revoked device', async () => {
    const victim = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    await setDeviceStatus(w.db.pool, w.admin, victim.deviceId, 'REVOKED');
    const now = syncClock(w);
    const r = await post(w, victim, [message(1, now, [temp(victim.channels.temp!, 4000)])]);
    expect(r.status).toBe(401);
    await expect(
      authenticateDevice(w.db.pool, w.creds, await signPrincipalToken('DEVICE', victim.deviceId, victim.key)),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a sample whose source time has no binding (never assigned, or before the assignment began)', async () => {
    const unbound = await provisionDevice(w, { siteId: w.siteId, assetId: null });
    const bound = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    await sleep(20);
    const now = syncClock(w);
    const [a] = await listDeviceAssignments(w.db.pool, w.admin, bound.deviceId);
    const r1 = await post(w, unbound, [message(1, now - 50, [temp(unbound.channels.temp!, 4000)])]);
    expect(r1.status).toBe(200);
    expect(r1.body.results).toEqual([expect.objectContaining({ status: 'REJECTED', reasonCode: 'BINDING_MISSING' })]);
    const beforeStart = Date.parse(a!.validFrom) - 5;
    const r2 = await post(w, bound, [message(1, beforeStart, [temp(bound.channels.temp!, 4000)])], {
      delivery: 'BACKFILL',
    });
    expect(r2.body.results).toEqual([expect.objectContaining({ status: 'REJECTED', reasonCode: 'BINDING_MISSING' })]);
    expect(await listTelemetrySamples(w.db.pool, w.admin, { channelId: unbound.channels.temp! })).toEqual([]);
    expect(await listTelemetrySamples(w.db.pool, w.admin, { channelId: bound.channels.temp! })).toEqual([]);
    const rejections = await listTelemetryRejections(w.db.pool, w.admin, unbound.deviceId);
    expect(rejections).toEqual([
      expect.objectContaining({ bootId: 'boot_fixture-0001', sequence: 1, reasonCode: 'BINDING_MISSING' }),
    ]);
  });

  it('rejects a binding whose asset revision was already superseded at source time', async () => {
    const d = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    const asset = await getAsset(w.db.pool, w.admin, w.assetId);
    const oldRevision = asset.current.assetRevisionId;
    await reviseAssetIdentity(
      w.db.pool,
      w.admin,
      w.assetId,
      { ...identityOf(asset.current), serial: `${asset.current.serial}-R` },
      { expectedVersion: asset.version, source: 'API' },
    );
    // A misassigned device: an interval opened after the revision change that still names the superseded revision
    // (only reachable by a direct write — the repository always binds the current revision).
    const sup = await provisionDevice(w, { siteId: w.siteId, assetId: null });
    await w.db.admin(
      `INSERT INTO device_asset_assignments (tenant_id, id, device_id, asset_id, asset_revision_id, revision, valid_from,
                                             assignment_digest, actor_kind, actor_id, source)
       VALUES ($1, $2, $3, $4, $5, 1, clock_timestamp(), $6, 'PLATFORM', NULL, 'MIGRATION')`,
      [
        w.tenant.tenantId,
        `dasg_${randomBytes(8).toString('hex')}`,
        sup.deviceId,
        w.assetId,
        oldRevision,
        `device-assignment.v1:sha256:${'0'.repeat(64)}`,
      ],
    );
    await sleep(20);
    const now = syncClock(w);
    const r = await post(w, sup, [message(1, now - 10, [temp(sup.channels.temp!, 4100)])]);
    expect(r.body.results).toEqual([expect.objectContaining({ status: 'REJECTED', reasonCode: 'BINDING_SUPERSEDED' })]);
    // the correctly rebound device is still accepted against the new revision
    const ok = await post(w, d, [message(1, now - 10, [temp(d.channels.temp!, 4100)])]);
    expect(ok.body.results).toEqual([expect.objectContaining({ status: 'ACCEPTED' })]);
  });

  it('rejects an overlapping binding even when the interval exclusion has been removed', async () => {
    const d = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    const asset = await getAsset(w.db.pool, w.admin, w.assetId);
    const insertOverlap = () =>
      w.db.admin(
        `INSERT INTO device_asset_assignments (tenant_id, id, device_id, asset_id, asset_revision_id, revision, valid_from,
                                               assignment_digest, actor_kind, actor_id, source)
         VALUES ($1, $2, $3, $4, $5, 99, clock_timestamp() - interval '1 minute', $6, 'PLATFORM', NULL, 'MIGRATION')`,
        [
          w.tenant.tenantId,
          `dasg_${randomBytes(8).toString('hex')}`,
          d.deviceId,
          w.assetId,
          asset.current.assetRevisionId,
          `device-assignment.v1:sha256:${'0'.repeat(64)}`,
        ],
      );
    await expect(insertOverlap()).rejects.toThrow(/exclu|conflicting key/i);
    // (the exclusion constraint is removed below only in this throwaway database, to prove the gateway check)
    const { rows } = await w.db.admin(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'device_asset_assignments'::regclass AND contype = 'x'`,
    );
    await w.db.admin(`ALTER TABLE device_asset_assignments DROP CONSTRAINT ${rows[0].conname}`);
    await insertOverlap();
    const now = syncClock(w);
    const r = await post(w, d, [message(1, now - 10, [temp(d.channels.temp!, 4000)])]);
    expect(r.body.results).toEqual([
      expect.objectContaining({ status: 'REJECTED', reasonCode: 'BINDING_OVERLAPPING' }),
    ]);
    expect(await listTelemetrySamples(w.db.pool, w.admin, { channelId: d.channels.temp! })).toEqual([]);
  });

  it('rejects unknown or foreign channels identically, a channel revision missing at source time, and a unit mismatch', async () => {
    const d = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId, channels: [] });
    await sleep(30);
    // Anchor the gap at the later of the host and database clocks: the assignment and the channel revision are stamped
    // by the database clock, and a container clock running ahead of the host would otherwise put the gap sample
    // before the assignment (BINDING_MISSING) instead of between the assignment and the revision.
    const dbNow = await w.db.admin(`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS t`);
    const gapStart = Math.ceil(Math.max(Date.now(), Number(dbNow.rows[0].t)));
    // A database clock running BEHIND the host would stamp the channel revision before gapStart; wait until the
    // database clock itself is past the gap sample before creating the revision.
    const dbClock = async () =>
      Number((await w.db.admin(`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS t`)).rows[0].t);
    await sleep(30);
    while ((await dbClock()) < gapStart + 30) await sleep(5);
    const { createSensorChannel } = await import('@uptimebuyer/data');
    const ch = await createSensorChannel(w.db.pool, w.admin, {
      deviceId: d.deviceId,
      kind: 'TEMPERATURE',
      unit: 'MILLI_CELSIUS',
      sourceUnit: 'CELSIUS',
      calibrationRevision: 1,
      source: 'API',
    });
    await sleep(20);
    const now = syncClock(w);
    const r = await post(w, d, [
      message(1, now - 10, [temp(dev.channels.temp!, 1)]),
      message(2, now - 9, [temp(newId('device').replace('dev_', 'chn_'), 1)]),
      message(3, gapStart + 5, [temp(ch.channelId, 1)]),
      message(4, now - 8, [{ channel: ch.channelId, valueInt: 39_614, unit: 'mF', quality: 'GOOD' }]),
      message(5, now - 7, [temp(ch.channelId, 4000)]),
    ]);
    expect(r.body.results!.map((x) => [x.sequence, x.status, x.reasonCode])).toEqual([
      [1, 'REJECTED', 'CHANNEL_UNKNOWN'],
      [2, 'REJECTED', 'CHANNEL_UNKNOWN'],
      [3, 'REJECTED', 'CHANNEL_REVISION_MISSING'],
      [4, 'REJECTED', 'UNIT_MISMATCH'],
      [5, 'ACCEPTED', null],
    ]);
    // a rejection for a channel the device does not own records no channel identifier
    const rej = await w.db.admin(
      `SELECT channel_id, requested_channel_digest FROM telemetry_rejections WHERE tenant_id = $1 AND device_id = $2 ORDER BY sequence`,
      [w.tenant.tenantId, d.deviceId],
    );
    expect(rej.rows[0]).toMatchObject({ channel_id: null });
    expect(rej.rows[0].requested_channel_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('the database refuses a sample row whose pinned revisions are not the ones effective at its source time', async () => {
    const [s] = await listTelemetrySamples(w.db.pool, w.admin, { channelId: dev.channels.temp! });
    const forged = `tsm_${randomBytes(8).toString('hex')}`;
    await expect(
      w.db.admin(
        `INSERT INTO telemetry_samples
           SELECT tenant_id, $2, batch_id, device_id, channel_id, channel_revision_id, calibration_revision,
                  device_assignment_id, asset_id, asset_revision_id, boot_id, sequence + 1000,
                  valid_from - interval '1 hour', received_at, kind, unit, value_int, raw_value_int, source_unit,
                  source_value_int, conversion, quality_flags, ingestion_class, lateness_ms, lateness_policy_version,
                  lateness_policy_digest, delivery, input_origin, sample_digest
             FROM telemetry_samples s JOIN LATERAL (SELECT valid_from FROM device_asset_assignments a
                                                     WHERE a.tenant_id = s.tenant_id AND a.id = s.device_assignment_id) v ON true
            WHERE s.id = $1`,
        [s!.sampleId, forged],
      ),
    ).rejects.toThrow(/binding/i);
  });
});
