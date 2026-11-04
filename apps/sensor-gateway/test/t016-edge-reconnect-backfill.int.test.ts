// T-016 — Edge reconnect and bounded backfill (FR-02, FR-22, NFR-04, INV-01, INV-11).
// The reference edge agent is disconnected, fills its bounded buffer past capacity and reconnects through the real
// gateway: live data is delivered first, backfill drains oldest-first in bounded batches under the gateway's rate
// bound (429 + Retry-After honoured, nothing lost), overflow is disclosed, original source and receive times are
// kept, and LATE/BACKFILL classification is immutable, can never be rewritten to LIVE and never qualifies for
// recovery. Simulated input is labelled SIMULATED_INPUT end to end and cannot pass a physical-sensor claim.
import {
  listDropDisclosures,
  listSequenceGaps,
  listTelemetrySamples,
  type TelemetrySampleRecord,
} from '@uptimebuyer/data';
import {
  SensorAgent,
  SensorSimulator,
  createDeviceTokenProvider,
  type AgentTransport,
} from '@uptimebuyer/sensor-agent';
import { assertPhysicalSensorClaim, isRecoveryQualifying, type DeviceMessage } from '@uptimebuyer/telemetry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, message, post, provisionDevice, sleep, syncClock, temp, type World } from './helpers.js';

let w: World;

const transportFor =
  (world: World): AgentTransport =>
  async (req) => {
    const res = await world.gw.app.inject({ method: 'POST', url: req.path, headers: req.headers, payload: req.body });
    return { status: res.statusCode, headers: res.headers as Record<string, string>, body: res.json() };
  };

describe('T-016 edge reconnect and bounded backfill', () => {
  beforeAll(async () => {
    w = await createWorld('t016', {
      limits: { backfillRate: { capacityMessages: 4, refillMessagesPerSecond: 1 } },
    });
  });
  afterAll(async () => {
    await w?.close();
  });

  it('delivers live first, then ordered, bounded, rate-limited backfill with overflow disclosure and original times', async () => {
    const d = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    await sleep(20);
    syncClock(w);
    const agent = new SensorAgent({
      deviceId: d.deviceId,
      deviceKey: d.key,
      tokenProvider: createDeviceTokenProvider(d.deviceId, d.key),
      transport: transportFor(w),
      clock: w.clock,
      bufferCapacity: 8,
      maxBatchMessages: 3,
      backfillIntervalMs: 500,
    });
    const T = d.channels.temp!;
    for (let i = 0; i < 2; i++) {
      agent.record([{ channel: T, valueInt: 3500 + i, unit: 'mC' }]);
      await agent.flush();
      w.clock.advance(1_000);
    }

    agent.disconnect();
    const offline: DeviceMessage[] = [];
    for (let i = 0; i < 12; i++) {
      offline.push(agent.record([{ channel: T, valueInt: 4000 + i * 100, unit: 'mC' }]));
      w.clock.advance(60_000);
    }
    expect(agent.stats()).toMatchObject({ buffered: 8, droppedTotal: 4 });

    agent.reconnect();
    const live = agent.record([{ channel: T, valueInt: 3600, unit: 'mC' }]);
    const liveSentAt = w.clock.now();
    await agent.flush();
    let rounds = 0;
    while ((agent.stats().buffered > 0 || agent.stats().pendingDisclosures > 0) && rounds++ < 60) {
      w.clock.advance(500);
      await agent.flush();
    }
    expect(agent.stats()).toMatchObject({ buffered: 0, pendingDisclosures: 0 });
    expect(w.gw.metrics().rateLimited).toBeGreaterThan(0);

    const samples = await listTelemetrySamples(w.db.pool, w.admin, { channelId: T });
    const bySeq = new Map(samples.map((s) => [s.sequence, s]));
    // live data first and LIVE
    expect(bySeq.get(live.sequence)).toMatchObject({
      ingestionClass: 'LIVE',
      delivery: 'LIVE',
      eventAt: live.eventAt,
      receivedAt: new Date(liveSentAt).toISOString(),
    });
    const kept = offline.slice(4);
    const backfilled = kept.map((m) => bySeq.get(m.sequence)!);
    for (const [i, s] of backfilled.entries()) {
      expect(s, `sequence ${kept[i]!.sequence}`).toMatchObject({
        ingestionClass: 'BACKFILL',
        delivery: 'BACKFILL',
        eventAt: kept[i]!.eventAt,
        valueInt: kept[i]!.samples[0]!.valueInt,
      });
      expect(Date.parse(s.receivedAt)).toBeGreaterThanOrEqual(liveSentAt);
      expect(isRecoveryQualifying(s)).toBe(false);
    }
    // ordered backfill: receipt order follows sequence order
    const order = [...backfilled].sort(
      (a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt) || a.sequence - b.sequence,
    );
    expect(order.map((s) => s.sequence)).toEqual(kept.map((m) => m.sequence));
    // dropped messages were never stored and are disclosed with their aggregates
    for (const m of offline.slice(0, 4)) expect(bySeq.has(m.sequence)).toBe(false);
    const [disclosure] = await listDropDisclosures(w.db.pool, w.admin, d.deviceId);
    expect(disclosure).toMatchObject({
      bootId: live.bootId,
      droppedTotal: 4,
      droppedMessages: 4,
      fromSequence: offline[0]!.sequence,
      toSequence: offline[3]!.sequence,
      firstEventAt: offline[0]!.eventAt,
      lastEventAt: offline[3]!.eventAt,
      aggregates: [{ channel: T, unit: 'mC', count: 4, min: 4000, max: 4300, sum: '16600' }],
    });
    const gaps = await listSequenceGaps(w.db.pool, w.admin, d.deviceId);
    expect(gaps.flatMap((g) => g.outstanding)).toEqual([[offline[0]!.sequence, offline[3]!.sequence]]);
    expect(gaps.every((g) => g.disclosed)).toBe(true);
    // every backfill batch was bounded
    const batches = await w.db.admin(
      `SELECT delivery, message_count FROM telemetry_batches WHERE tenant_id = $1 AND device_id = $2`,
      [w.tenant.tenantId, d.deviceId],
    );
    expect(batches.rows.filter((b) => b.delivery === 'BACKFILL').every((b) => b.message_count <= 3)).toBe(true);

    // a backfilled message re-sent as live is a duplicate; the stored class stays BACKFILL
    w.clock.advance(30_000); // let the backfill budget refill
    const resend = await post(w, d, [kept[0]!], { delivery: 'LIVE' });
    expect(resend.body.results).toEqual([expect.objectContaining({ status: 'DUPLICATE' })]);
    const after = (await listTelemetrySamples(w.db.pool, w.admin, { channelId: T })).find(
      (s) => s.sequence === kept[0]!.sequence,
    )!;
    expect(after.ingestionClass).toBe('BACKFILL');
    await expect(
      w.db.admin(`UPDATE telemetry_samples SET ingestion_class = 'LIVE' WHERE id = $1`, [after.sampleId]),
    ).rejects.toThrow(/append-only/);
    const liveOnly = await listTelemetrySamples(w.db.pool, w.admin, { channelId: T, ingestionClasses: ['LIVE'] });
    expect(liveOnly.every((s) => s.ingestionClass === 'LIVE')).toBe(true);
    expect(liveOnly.map((s) => s.sequence)).not.toContain(kept[0]!.sequence);
  });

  it('classifies a live delivery that arrives after the live lag as LATE, never LIVE', async () => {
    const d = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    await sleep(20);
    const now = syncClock(w, 3 * 60_000);
    const r = await post(w, d, [message(1, now - 2 * 60_000, [temp(d.channels.temp!, 3800)])]);
    expect(r.body.results).toEqual([expect.objectContaining({ status: 'ACCEPTED' })]);
    const [s] = await listTelemetrySamples(w.db.pool, w.admin, { channelId: d.channels.temp! });
    expect(s).toMatchObject({ ingestionClass: 'LATE', delivery: 'LIVE', latenessMs: 2 * 60_000 });
    expect(isRecoveryQualifying(s!)).toBe(false);
  });

  it('the gateway bounds backfill rate per device with 429 and Retry-After while live data keeps flowing', async () => {
    const d = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    await sleep(20);
    const now = syncClock(w);
    const old = (seq: number) => message(seq, now - 5, [temp(d.channels.temp!, 3800)]);
    const statuses: number[] = [];
    let retryAfter: unknown;
    for (let i = 0; i < 4; i++) {
      const r = await post(w, d, [old(i * 3), old(i * 3 + 1), old(i * 3 + 2)], { delivery: 'BACKFILL' });
      statuses.push(r.status);
      if (r.status === 429) retryAfter = r.headers['retry-after'];
    }
    expect(statuses[0]).toBe(200);
    expect(statuses).toContain(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    // live data is not starved by the exhausted backfill budget
    const live = await post(w, d, [message(100, now - 10, [temp(d.channels.temp!, 3800)])]);
    expect(live.status).toBe(200);
    expect(live.body.results).toEqual([expect.objectContaining({ status: 'ACCEPTED' })]);
    const m = w.gw.metrics();
    expect(m).toMatchObject({ queue: { live: 0, backfill: 0 } });
    expect(m.accepted.LIVE + m.accepted.LATE + m.accepted.BACKFILL).toBeGreaterThan(0);
  });

  it('simulated input is persistently labelled and can never pass a physical-sensor claim', async () => {
    const sim = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId, inputClass: 'SIMULATOR' });
    const phys = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    await sleep(20);
    syncClock(w);
    const simulator = new SensorSimulator({
      deviceId: sim.deviceId,
      deviceKey: sim.key,
      tokenProvider: createDeviceTokenProvider(sim.deviceId, sim.key),
      transport: transportFor(w),
      clock: w.clock,
      channels: [{ channel: sim.channels.temp!, unit: 'mC', baseline: 3500 }],
    });
    for (const s of ['normal', 'warming', 'recovery'] as const) {
      simulator.step(s);
      await simulator.agent.flush();
      w.clock.advance(5_000);
    }
    // a simulator-class device that omits the label is still stored as simulated (the registry class wins)
    const now = w.clock.now();
    await post(w, sim, [message(500, now - 10, [temp(sim.channels.temp!, 3500)])]);
    // a physical-class device that labels its sample simulated is stored as simulated (the label only downgrades)
    await post(w, phys, [message(1, now - 10, [temp(phys.channels.temp!, 3500, { label: 'SIMULATED_INPUT' })])]);
    await post(w, phys, [message(2, now - 5, [temp(phys.channels.temp!, 3500)])]);

    const simRows: TelemetrySampleRecord[] = await listTelemetrySamples(w.db.pool, w.admin, {
      channelId: sim.channels.temp!,
    });
    expect(simRows).toHaveLength(4);
    expect(simRows.every((s) => s.inputOrigin === 'SIMULATED_INPUT')).toBe(true);
    expect(() => assertPhysicalSensorClaim(simRows)).toThrow(/SIMULATED_INPUT/);
    const physRows = await listTelemetrySamples(w.db.pool, w.admin, { channelId: phys.channels.temp! });
    expect(physRows.map((s) => [s.sequence, s.inputOrigin])).toEqual([
      [1, 'SIMULATED_INPUT'],
      [2, 'PHYSICAL_SENSOR'],
    ]);
    expect(() => assertPhysicalSensorClaim(physRows)).toThrow(/SIMULATED_INPUT/);
    expect(() => assertPhysicalSensorClaim(physRows.filter((s) => s.sequence === 2))).not.toThrow();
    await expect(
      w.db.admin(`UPDATE devices SET input_class = 'PHYSICAL_SENSOR' WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        sim.deviceId,
      ]),
    ).rejects.toThrow(/input_class/);
  });
});
