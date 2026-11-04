// T-014 — Duplicate and out-of-order sequence handling (FR-02, NFR-03).
// Duplicate delivery (sequential or concurrent, under fresh tokens) is idempotent and a conflicting duplicate never
// overwrites; out-of-order data is retained with the assignment/channel revisions effective at its own source time;
// a device rebind or asset/channel supersession appends intervals and cannot reinterpret stored samples or move the
// current health projection backwards.
import {
  getAsset,
  getDeviceHealth,
  listDeviceAssignments,
  listSensorChannelRevisions,
  listSequenceGaps,
  listTelemetrySamples,
  reviseAssetIdentity,
  reviseSensorChannel,
} from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorld,
  message,
  post,
  provisionDevice,
  sampleRowDigest,
  sleep,
  syncClock,
  temp,
  type TestDevice,
  type World,
} from './helpers.js';

let w: World;
let dev: TestDevice;

describe('T-014 duplicate and out-of-order sequence handling', () => {
  beforeAll(async () => {
    w = await createWorld('t014');
    dev = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    await sleep(20);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('a re-delivered batch is idempotent and leaves the stored rows byte-identical', async () => {
    const now = syncClock(w);
    const batch = [
      message(1, now - 300, [temp(dev.channels.temp!, 4100)]),
      message(2, now - 200, [temp(dev.channels.temp!, 4150)]),
    ];
    const first = await post(w, dev, batch);
    expect(first.body).toMatchObject({ accepted: 2, duplicates: 0 });
    const ids = first.body.results!.map((r) => r.sampleId!);
    const digests = await Promise.all(ids.map((id) => sampleRowDigest(w.db, id)));
    w.clock.advance(5_000);
    const again = await post(w, dev, batch);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ accepted: 0, duplicates: 2, rejected: 0 });
    expect(again.body.results!.map((r) => [r.status, r.sampleId])).toEqual(ids.map((id) => ['DUPLICATE', id]));
    expect(await Promise.all(ids.map((id) => sampleRowDigest(w.db, id)))).toEqual(digests);
    expect(await listTelemetrySamples(w.db.pool, w.admin, { channelId: dev.channels.temp! })).toHaveLength(2);
  });

  it('concurrent duplicate deliveries store exactly one sample', async () => {
    const now = syncClock(w);
    const batch = [message(3, now - 100, [temp(dev.channels.temp!, 4200)])];
    const results = await Promise.all(Array.from({ length: 6 }, () => post(w, dev, batch)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const statuses = results.map((r) => r.body.results![0]!.status).sort();
    expect(statuses.filter((s) => s === 'ACCEPTED')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'DUPLICATE')).toHaveLength(5);
    const rows = await w.db.admin(
      `SELECT count(*)::int AS n FROM telemetry_samples WHERE tenant_id = $1 AND channel_id = $2 AND sequence = 3`,
      [w.tenant.tenantId, dev.channels.temp],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('a conflicting duplicate (same boot and sequence, different content) is rejected and never overwrites', async () => {
    const [before] = await listTelemetrySamples(w.db.pool, w.admin, { channelId: dev.channels.temp! });
    const digest = await sampleRowDigest(w.db, before!.sampleId);
    syncClock(w);
    const r = await post(w, dev, [message(1, Date.parse(before!.eventAt), [temp(dev.channels.temp!, 9999)])]);
    expect(r.body.results).toEqual([expect.objectContaining({ status: 'REJECTED', reasonCode: 'DUPLICATE_CONFLICT' })]);
    expect(await sampleRowDigest(w.db, before!.sampleId)).toBe(digest);
    // the same sequence under a new boot id is a different message
    const now = syncClock(w);
    const nb = await post(w, dev, [message(1, now - 10, [temp(dev.channels.temp!, 4000)], 'boot_fixture-0002')]);
    expect(nb.body.results).toEqual([expect.objectContaining({ status: 'ACCEPTED' })]);
  });

  it('retains out-of-order samples with their own source time and tracks the sequence gap they fill', async () => {
    const now = syncClock(w);
    const boot = 'boot_fixture-ooo1';
    await post(w, dev, [message(10, now - 1_000, [temp(dev.channels.temp!, 4000)], boot)]);
    await post(w, dev, [message(14, now - 200, [temp(dev.channels.temp!, 4010)], boot)]);
    let gaps = (await listSequenceGaps(w.db.pool, w.admin, dev.deviceId)).filter((g) => g.bootId === boot);
    expect(gaps).toEqual([expect.objectContaining({ fromSequence: 11, toSequence: 13, outstanding: [[11, 13]] })]);
    const late = await post(w, dev, [message(12, now - 600, [temp(dev.channels.temp!, 4005)], boot)]);
    expect(late.body.results).toEqual([expect.objectContaining({ status: 'ACCEPTED' })]);
    gaps = (await listSequenceGaps(w.db.pool, w.admin, dev.deviceId)).filter((g) => g.bootId === boot);
    expect(gaps[0]!.outstanding).toEqual([
      [11, 11],
      [13, 13],
    ]);
    const samples = (await listTelemetrySamples(w.db.pool, w.admin, { channelId: dev.channels.temp! })).filter(
      (s) => s.bootId === boot,
    );
    expect(samples.map((s) => [s.sequence, s.eventAt])).toEqual([
      [10, new Date(now - 1_000).toISOString()],
      [12, new Date(now - 600).toISOString()],
      [14, new Date(now - 200).toISOString()],
    ]);
    const health = await getDeviceHealth(w.db.pool, w.admin, dev.deviceId, { now: new Date(now).toISOString() });
    const tempHealth = health.channels.find((c) => c.channelId === dev.channels.temp)!;
    // the late sample did not move the freshness basis backwards: it is still the newest LIVE source time
    const newest = (await listTelemetrySamples(w.db.pool, w.admin, { channelId: dev.channels.temp! }))
      .filter((s) => s.ingestionClass === 'LIVE')
      .map((s) => s.eventAt)
      .sort()
      .at(-1);
    expect(tempHealth.sourceTime).toBe(newest);
    expect(tempHealth.sourceTime).not.toBe(new Date(now - 600).toISOString());
  });

  it('rebind and asset/channel supersession append intervals and never reinterpret stored samples', async () => {
    const d = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    await sleep(50);
    const t1 = syncClock(w);
    const r1 = await post(w, d, [message(1, t1 - 5, [temp(d.channels.temp!, 4000)])]);
    const s1 = r1.body.results![0]!.sampleId!;
    const s1Digest = await sampleRowDigest(w.db, s1);
    const [a1] = await listDeviceAssignments(w.db.pool, w.admin, d.deviceId);
    const [c1] = await listSensorChannelRevisions(w.db.pool, w.admin, d.channels.temp!);
    const asset = await getAsset(w.db.pool, w.admin, w.assetId);
    const rev1 = asset.current.assetRevisionId;

    await sleep(30);
    await reviseAssetIdentity(
      w.db.pool,
      w.admin,
      w.assetId,
      { ...asset.current, bomRevision: `${asset.current.bomRevision}-b` },
      { expectedVersion: asset.version, source: 'API' },
    );
    await reviseSensorChannel(w.db.pool, w.admin, d.channels.temp!, {
      kind: 'TEMPERATURE',
      unit: 'MILLI_CELSIUS',
      sourceUnit: 'CELSIUS',
      calibrationRevision: 2,
      calibrationOffsetMilli: -150,
      source: 'API',
    });
    const assignments = await listDeviceAssignments(w.db.pool, w.admin, d.deviceId);
    const channelRevs = await listSensorChannelRevisions(w.db.pool, w.admin, d.channels.temp!);
    expect(assignments).toHaveLength(2);
    expect(channelRevs).toHaveLength(2);
    const a2 = assignments[1]!;
    const c2 = channelRevs[1]!;
    const rev2 = (await getAsset(w.db.pool, w.admin, w.assetId)).current.assetRevisionId;
    await sleep(30);
    const t3 = syncClock(w);

    // an out-of-order sample from before the rebind arrives after it; a new sample follows
    const lo = Math.max(Date.parse(a1!.validFrom), Date.parse(c1!.validFrom));
    const hi = Math.min(Date.parse(a2.validFrom), Date.parse(c2.validFrom));
    expect(hi - lo).toBeGreaterThan(2);
    const oooAt = lo + Math.floor((hi - lo) / 2);
    const r = await post(w, d, [
      message(3, t3 - 5, [temp(d.channels.temp!, 4000)]),
      message(2, oooAt, [temp(d.channels.temp!, 4000)]),
    ]);
    expect(r.body.results!.map((x) => x.status)).toEqual(['ACCEPTED', 'ACCEPTED']);
    const bySeq = Object.fromEntries(
      (await listTelemetrySamples(w.db.pool, w.admin, { channelId: d.channels.temp! })).map((s) => [s.sequence, s]),
    );
    expect(bySeq[1]).toMatchObject({
      deviceAssignmentId: a1!.assignmentId,
      assetRevisionId: rev1,
      channelRevisionId: c1!.channelRevisionId,
      calibrationRevision: 1,
      valueInt: 4000,
    });
    expect(bySeq[2]).toMatchObject({
      deviceAssignmentId: a1!.assignmentId,
      assetRevisionId: rev1,
      channelRevisionId: c1!.channelRevisionId,
      calibrationRevision: 1,
      valueInt: 4000,
      rawValueInt: 4000,
    });
    expect(bySeq[3]).toMatchObject({
      deviceAssignmentId: a2.assignmentId,
      assetRevisionId: rev2,
      channelRevisionId: c2.channelRevisionId,
      calibrationRevision: 2,
      valueInt: 3850,
      rawValueInt: 4000,
    });
    expect(await sampleRowDigest(w.db, s1)).toBe(s1Digest);
    const health = await getDeviceHealth(w.db.pool, w.admin, d.deviceId, { now: new Date(t3).toISOString() });
    expect(health.channels.find((c) => c.channelId === d.channels.temp)!.sourceTime).toBe(
      new Date(t3 - 5).toISOString(),
    );
  });

  it('a rebind after a slightly future-stamped sample starts strictly after it, so the sample stays covered', async () => {
    const d = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    await sleep(20);
    const now = syncClock(w);
    const ahead = now + 3_000; // device clock leads, within the bounded future skew
    const r = await post(w, d, [message(1, ahead, [temp(d.channels.temp!, 4000)])]);
    expect(r.body.results).toEqual([expect.objectContaining({ status: 'ACCEPTED' })]);
    const asset = await getAsset(w.db.pool, w.admin, w.assetId);
    await reviseAssetIdentity(
      w.db.pool,
      w.admin,
      w.assetId,
      { ...asset.current, bomRevision: `${asset.current.bomRevision}-c` },
      { expectedVersion: asset.version, source: 'API' },
    );
    const [first, second] = await listDeviceAssignments(w.db.pool, w.admin, d.deviceId);
    expect(Date.parse(first!.validTo!)).toBeGreaterThan(ahead);
    expect(second!.validFrom).toBe(first!.validTo);
    const sup = await w.db.admin(`SELECT superseded_at FROM asset_revisions WHERE tenant_id = $1 AND id = $2`, [
      w.tenant.tenantId,
      asset.current.assetRevisionId,
    ]);
    expect(new Date(sup.rows[0].superseded_at).getTime()).toBeGreaterThan(ahead);
    // and the database refuses to close an interval underneath a bound sample
    await expect(
      w.db.admin(
        `UPDATE device_asset_assignments SET valid_to = valid_from + interval '1 millisecond'
                   WHERE tenant_id = $1 AND device_id = $2 AND valid_to IS NULL`,
        [w.tenant.tenantId, dev.deviceId],
      ),
    ).rejects.toThrow(/bound telemetry/i);
  });

  it('stored samples are immutable', async () => {
    const [s] = await listTelemetrySamples(w.db.pool, w.admin, { channelId: dev.channels.temp! });
    await expect(w.db.admin(`UPDATE telemetry_samples SET value_int = 0 WHERE id = $1`, [s!.sampleId])).rejects.toThrow(
      /append-only/,
    );
    await expect(
      w.db.admin(`UPDATE telemetry_samples SET ingestion_class = 'LIVE' WHERE id = $1`, [s!.sampleId]),
    ).rejects.toThrow(/append-only/);
    await expect(w.db.admin(`DELETE FROM telemetry_samples WHERE id = $1`, [s!.sampleId])).rejects.toThrow(
      /append-only/,
    );
    await expect(w.db.admin(`TRUNCATE telemetry_samples CASCADE`)).rejects.toThrow(/append-only/);
  });
});
