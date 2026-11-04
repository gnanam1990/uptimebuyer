// T-013 — Authenticated telemetry acceptance: security-review regressions (NFR-04, INV-16).
// - Unauthenticated floods are bounded before any database work: a per-source budget answers 429 without a
//   credential lookup or a new security-audit row once exhausted.
// - The public listener exposes no cross-tenant operational counters (observability cannot be used to infer other
//   tenants' activity); metrics are available to the operator in-process only.
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

describe('T-013 security review: pre-authentication bounds and metrics exposure', () => {
  beforeAll(async () => {
    w = await createWorld('t013sec', {
      limits: { preAuthRate: { capacityMessages: 5, refillMessagesPerSecond: 1 } },
    });
    dev = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    await sleep(20);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('bounds unauthenticated requests per source before touching the database', async () => {
    const now = syncClock(w);
    const audits = async () =>
      (
        await w.db.admin(
          `SELECT count(*)::int AS n FROM security_audit_entries WHERE action = 'principal.authenticate'`,
        )
      ).rows[0].n as number;
    const before = await audits();
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++)
      statuses.push((await post(w, dev, [message(i, now, [temp(dev.channels.temp!, 1)])], { token: 'a.b.c' })).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
    expect((await audits()) - before).toBe(5);
    // the budget refills from the injected clock
    w.clock.advance(10_000);
    const ok = await post(w, dev, [message(100, w.clock.now() - 5, [temp(dev.channels.temp!, 3800)])]);
    expect(ok.status).toBe(200);
  });

  it('does not serve cross-tenant counters on the device listener', async () => {
    const res = await w.gw.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
    expect(w.gw.metrics().requests).toBeGreaterThan(0);
  });
});
