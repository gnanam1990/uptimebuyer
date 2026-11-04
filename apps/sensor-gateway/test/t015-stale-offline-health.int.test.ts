// T-015 — Stale and offline health projection (FR-02, INV-11, NFR-08).
// Advancing the clock or stopping heartbeats moves a channel FRESH -> STALE -> OFFLINE; reads never show stale,
// missing, invalid, revoked or unauthenticated telemetry as healthy (even before the sweeper runs); late/backfilled
// data never refreshes a projection; reconnection does not backdate freshness; every projection carries source time,
// receipt time, freshness threshold and a status reason; the database refuses a FRESH row without a LIVE basis.
import { getDeviceHealth, setDeviceStatus, sweepTelemetryFreshness, type ChannelHealthView } from '@uptimebuyer/data';
import { DEFAULT_FRESHNESS_POLICY as P, TelemetryStaleEventSchema } from '@uptimebuyer/telemetry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorld,
  message,
  post,
  provisionDevice,
  sleep,
  syncClock,
  temp,
  type TestDevice,
  type World,
} from './helpers.js';

let w: World;
let dev: TestDevice;
const at = (ms: number) => new Date(ms).toISOString();

async function channel(d: TestDevice, name: string, nowMs: number): Promise<ChannelHealthView> {
  const h = await getDeviceHealth(w.db.pool, w.admin, d.deviceId, { now: at(nowMs) });
  return h.channels.find((c) => c.channelId === d.channels[name])!;
}

function expectInv11(v: ChannelHealthView) {
  expect(v.freshnessThresholdMs).toBe(P.staleAfterMs);
  expect(v.offlineThresholdMs).toBe(P.offlineAfterMs);
  expect(v.statusReason).toMatch(/^[A-Z][A-Z0-9_]+$/);
  expect(v).toHaveProperty('sourceTime');
  expect(v).toHaveProperty('receiptTime');
  expect(['FRESH', 'STALE', 'OFFLINE', 'INVALID']).toContain(v.freshness);
  expect(v.healthy).toBe(v.freshness === 'FRESH');
}

async function staleEvents(deviceId: string) {
  const { rows } = await w.db.admin(
    `SELECT * FROM outbox_events WHERE tenant_id = $1 AND event_type = 'telemetry.stale.v1' AND aggregate_id = $2
      ORDER BY aggregate_version`,
    [w.tenant.tenantId, deviceId],
  );
  return rows.map((r) =>
    TelemetryStaleEventSchema.parse({
      eventId: r.id,
      eventType: r.event_type,
      occurredAt: new Date(r.occurred_at).toISOString(),
      tenantId: r.tenant_id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      aggregateVersion: r.aggregate_version,
      correlationId: r.correlation_id,
      causationId: r.causation_id,
      schemaVersion: 1,
      payload: r.payload,
    }),
  );
}

describe('T-015 stale and offline health projection', () => {
  beforeAll(async () => {
    w = await createWorld('t015');
    dev = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    await sleep(20);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('a channel that never reported is OFFLINE with a reason, never healthy', async () => {
    const v = await channel(dev, 'door', Date.now());
    expectInv11(v);
    expect(v).toMatchObject({ freshness: 'OFFLINE', healthy: false, statusReason: 'NO_LIVE_TELEMETRY' });
    expect(v.sourceTime).toBeNull();
    expect(v.receiptTime).toBeNull();
  });

  it('moves FRESH -> STALE -> OFFLINE with an advancing clock, persisted by the sweeper with typed events', async () => {
    const t0 = syncClock(w);
    await post(w, dev, [message(1, t0 - 400, [temp(dev.channels.temp!, 3800)])]);
    let v = await channel(dev, 'temp', t0 + 1_000);
    expectInv11(v);
    expect(v).toMatchObject({
      freshness: 'FRESH',
      healthy: true,
      statusReason: 'LIVE_TELEMETRY_WITHIN_THRESHOLD',
      sourceTime: at(t0 - 400),
      receiptTime: at(t0),
    });

    const staleAt = t0 - 400 + P.staleAfterMs + 1;
    // a read is never healthy once the threshold passed, even though nothing has re-evaluated the stored row yet
    v = await channel(dev, 'temp', staleAt);
    expectInv11(v);
    expect(v).toMatchObject({ freshness: 'STALE', healthy: false, statusReason: 'LIVE_TELEMETRY_OVERDUE' });
    expect(v.sourceTime).toBe(at(t0 - 400));

    const sweep1 = await sweepTelemetryFreshness(w.db.pool, { now: at(staleAt) });
    expect(sweep1.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deviceId: dev.deviceId, channelId: dev.channels.temp, from: 'FRESH', to: 'STALE' }),
      ]),
    );
    const row = await w.db.admin(`SELECT * FROM telemetry_channel_health WHERE tenant_id = $1 AND channel_id = $2`, [
      w.tenant.tenantId,
      dev.channels.temp,
    ]);
    expect(row.rows[0]).toMatchObject({ freshness: 'STALE', status_reason: 'LIVE_TELEMETRY_OVERDUE' });

    const offlineAt = t0 - 400 + P.offlineAfterMs + 1;
    v = await channel(dev, 'temp', offlineAt);
    expect(v).toMatchObject({ freshness: 'OFFLINE', healthy: false, statusReason: 'LIVE_TELEMETRY_OVERDUE_OFFLINE' });
    await sweepTelemetryFreshness(w.db.pool, { now: at(offlineAt) });
    // a repeated sweep at the same time is a no-op
    const again = await sweepTelemetryFreshness(w.db.pool, { now: at(offlineAt) });
    expect(again.transitions.filter((t) => t.channelId === dev.channels.temp)).toEqual([]);

    const events = (await staleEvents(dev.deviceId)).filter((e) => e.payload.channelId === dev.channels.temp);
    expect(events.map((e) => [e.payload.previousFreshness, e.payload.freshness])).toEqual([
      ['FRESH', 'STALE'],
      ['STALE', 'OFFLINE'],
    ]);
    for (const e of events) {
      expect(e.payload).toMatchObject({
        deviceId: dev.deviceId,
        sourceTime: at(t0 - 400),
        receiptTime: at(t0),
        freshnessThresholdMs: P.staleAfterMs,
        offlineThresholdMs: P.offlineAfterMs,
      });
    }
  });

  it('late and backfilled data never refresh an offline channel; a new LIVE reading does, without backdating', async () => {
    const base = (await channel(dev, 'temp', Date.now())).sourceTime!;
    // the device reconnects much later: its buffered samples are newer than the basis but delivered as backfill
    const t1 = Date.parse(base) + P.offlineAfterMs + 60_000;
    w.clock.set(t1);
    const b = await post(w, dev, [message(2, t1 - 30_000, [temp(dev.channels.temp!, 3800)])], {
      delivery: 'BACKFILL',
    });
    expect(b.body.results).toEqual([expect.objectContaining({ status: 'ACCEPTED' })]);
    const late = await post(w, dev, [message(3, t1 - 120_000, [temp(dev.channels.temp!, 3800)])]);
    expect(late.body.results).toEqual([expect.objectContaining({ status: 'ACCEPTED' })]);
    let v = await channel(dev, 'temp', t1);
    expect(v).toMatchObject({ freshness: 'OFFLINE', healthy: false, sourceTime: base });

    const live = await post(w, dev, [message(4, t1 - 50, [temp(dev.channels.temp!, 3800)])]);
    expect(live.body.results).toEqual([expect.objectContaining({ status: 'ACCEPTED' })]);
    v = await channel(dev, 'temp', t1);
    expect(v).toMatchObject({ freshness: 'FRESH', healthy: true, sourceTime: at(t1 - 50), receiptTime: at(t1) });
  });

  it('stopping heartbeats moves the heartbeat channel and the device rollup through STALE to OFFLINE', async () => {
    let now = syncClock(w);
    const hb = (seq: number) =>
      message(seq, now - 20, [{ channel: dev.channels.heartbeat!, valueInt: 0, unit: 'none', quality: 'GOOD' }]);
    for (let s = 100; s < 105; s++) {
      expect((await post(w, dev, [hb(s)])).status).toBe(200);
      expect((await channel(dev, 'heartbeat', now)).freshness).toBe('FRESH');
      now = w.clock.advance(30_000);
    }
    const last = now - 30_000 - 20;
    const stale = await channel(dev, 'heartbeat', last + P.staleAfterMs + 1);
    expect(stale).toMatchObject({ freshness: 'STALE', healthy: false });
    const device = await getDeviceHealth(w.db.pool, w.admin, dev.deviceId, { now: at(last + P.offlineAfterMs + 1) });
    expect(device).toMatchObject({ freshness: 'OFFLINE', healthy: false });
    expect(device.freshnessThresholdMs).toBe(P.staleAfterMs);
    expect(device.statusReason).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  it('invalid quality and a broken binding are INVALID with their reason, cleared only by a newer good LIVE sample', async () => {
    let now = syncClock(w);
    await post(w, dev, [message(200, now - 10, [temp(dev.channels.temp!, 3800, { quality: 'OUT_OF_RANGE' })])]);
    let v = await channel(dev, 'temp', now);
    expectInv11(v);
    expect(v).toMatchObject({ freshness: 'INVALID', healthy: false, statusReason: 'QUALITY_OUT_OF_RANGE' });

    now = w.clock.advance(1_000);
    // physically implausible value: accepted for diagnosis, flagged, never healthy
    await post(w, dev, [message(201, now - 10, [temp(dev.channels.temp!, 400_000)])]);
    v = await channel(dev, 'temp', now);
    expect(v).toMatchObject({ freshness: 'INVALID', healthy: false, statusReason: 'QUALITY_OUT_OF_RANGE' });

    now = w.clock.advance(1_000);
    await post(w, dev, [
      message(202, now - 10, [{ channel: dev.channels.temp!, valueInt: 1, unit: 'mF', quality: 'GOOD' }]),
    ]);
    v = await channel(dev, 'temp', now);
    expect(v).toMatchObject({ freshness: 'INVALID', healthy: false, statusReason: 'UNIT_MISMATCH' });

    now = w.clock.advance(1_000);
    await post(w, dev, [message(203, now - 10, [temp(dev.channels.temp!, 3800)])]);
    v = await channel(dev, 'temp', now);
    expect(v).toMatchObject({ freshness: 'FRESH', healthy: true, statusReason: 'LIVE_TELEMETRY_WITHIN_THRESHOLD' });
    const sweep = await sweepTelemetryFreshness(w.db.pool, { now: at(now) });
    expect(sweep.evaluated).toBeGreaterThan(0);
  });

  it('a rejected (unauthenticated) request cannot change the projection', async () => {
    const now = syncClock(w);
    const before = await channel(dev, 'temp', now);
    const r = await post(w, dev, [message(300, now, [temp(dev.channels.temp!, 3800)])], {
      signature: 'v1=' + '0'.repeat(64),
    });
    expect(r.status).toBe(401);
    const after = await channel(dev, 'temp', now);
    expect(after.sourceTime).toBe(before.sourceTime);
    expect(after.receiptTime).toBe(before.receiptTime);
  });

  it('a revoked device is INVALID, never healthy, and the sweeper records it', async () => {
    const d = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    await sleep(20);
    const now = syncClock(w);
    await post(w, d, [message(1, now - 10, [temp(d.channels.temp!, 3800)])]);
    expect((await channel(d, 'temp', now)).freshness).toBe('FRESH');
    await setDeviceStatus(w.db.pool, w.admin, d.deviceId, 'REVOKED');
    const v = await channel(d, 'temp', now);
    expect(v).toMatchObject({ freshness: 'INVALID', healthy: false, statusReason: 'DEVICE_REVOKED' });
    const sweep = await sweepTelemetryFreshness(w.db.pool, { now: at(now) });
    expect(sweep.transitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ deviceId: d.deviceId, to: 'INVALID' })]),
    );
    const device = await getDeviceHealth(w.db.pool, w.admin, d.deviceId, { now: at(now) });
    expect(device).toMatchObject({ freshness: 'INVALID', healthy: false, statusReason: 'DEVICE_REVOKED' });
  });

  it('the database refuses a FRESH projection without a LIVE, flag-free basis, and any non-canonical state', async () => {
    const id = dev.channels.temp;
    await expect(
      w.db.admin(
        `UPDATE telemetry_channel_health SET freshness = 'FRESH', basis_sample_id = NULL WHERE tenant_id = $1 AND channel_id = $2`,
        [w.tenant.tenantId, id],
      ),
    ).rejects.toThrow();
    const backfilled = await w.db.admin(
      `SELECT id FROM telemetry_samples WHERE tenant_id = $1 AND channel_id = $2 AND ingestion_class = 'BACKFILL' LIMIT 1`,
      [w.tenant.tenantId, id],
    );
    await expect(
      w.db.admin(`UPDATE telemetry_channel_health SET basis_sample_id = $3 WHERE tenant_id = $1 AND channel_id = $2`, [
        w.tenant.tenantId,
        id,
        backfilled.rows[0].id,
      ]),
    ).rejects.toThrow(/LIVE/);
    for (const state of ['HEALTHY', 'RECOVERED', 'ONLINE'])
      await expect(
        w.db.admin(`UPDATE telemetry_channel_health SET freshness = $3 WHERE tenant_id = $1 AND channel_id = $2`, [
          w.tenant.tenantId,
          id,
          state,
        ]),
      ).rejects.toThrow();
  });
});
