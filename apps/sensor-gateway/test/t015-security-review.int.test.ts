// T-015 — Stale and offline health projection: security-review regressions (INV-11).
// A caller-supplied evaluation time earlier than the server clock must not make stale telemetry read (or be
// persisted) as FRESH: reads and the sweeper evaluate at the later of the requested time and the server clock.
import { getDeviceHealth, sweepTelemetryFreshness } from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, message, post, provisionDevice, sleep, temp, type TestDevice, type World } from './helpers.js';

let w: World;
let dev: TestDevice;
const policy = {
  policyVersion: 'telemetry-freshness.v1',
  staleAfterMs: 200,
  offlineAfterMs: 60_000,
  maxFutureSkewMs: 5_000,
};

describe('T-015 security review: evaluation time cannot be rewound', () => {
  beforeAll(async () => {
    w = await createWorld('t015sec', { freshnessPolicy: policy });
    dev = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    await sleep(20);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('a past "now" does not render stale data FRESH, and the sweeper cannot persist FRESH from a past time', async () => {
    const t = w.clock.set(Date.now());
    const r = await post(w, dev, [message(1, t - 5, [temp(dev.channels.temp!, 3800)])]);
    expect(r.body.results).toEqual([expect.objectContaining({ status: 'ACCEPTED' })]);
    await sleep(policy.staleAfterMs + 150);
    const rewound = new Date(t + 10).toISOString();
    const h = await getDeviceHealth(w.db.pool, w.admin, dev.deviceId, { now: rewound });
    const ch = h.channels.find((c) => c.channelId === dev.channels.temp)!;
    expect(ch).toMatchObject({ freshness: 'STALE', healthy: false });
    expect(h.healthy).toBe(false);

    await sweepTelemetryFreshness(w.db.pool, { now: new Date(Date.now()).toISOString() });
    await sweepTelemetryFreshness(w.db.pool, { now: rewound });
    const row = await w.db.admin(
      `SELECT freshness FROM telemetry_channel_health WHERE tenant_id = $1 AND channel_id = $2`,
      [w.tenant.tenantId, dev.channels.temp],
    );
    expect(row.rows[0].freshness).toBe('STALE');
  });
});
