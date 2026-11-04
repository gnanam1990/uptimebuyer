// T-013 — Authenticated telemetry acceptance: security-review regressions (NFR-04, INV-16).
// - Unauthenticated floods are bounded before any database work: a per-source budget answers 429 without a
//   credential lookup or a new security-audit row once exhausted.
// - The public listener exposes no cross-tenant operational counters (observability cannot be used to infer other
//   tenants' activity); metrics are available to the operator in-process only.
import { randomBytes } from 'node:crypto';
import { signPrincipalToken } from '@uptimebuyer/data';
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

describe('T-013 security review: failure budgets are race-free and cannot lock out a valid device', () => {
  let w2: World;
  let victim: TestDevice;
  let other: TestDevice;
  const authAudits = async (reason: string) =>
    (
      await w2.db.admin(
        `SELECT count(*)::int AS n FROM security_audit_entries WHERE action = 'principal.authenticate' AND reason_code = $1`,
        [reason],
      )
    ).rows[0].n as number;

  beforeAll(async () => {
    w2 = await createWorld('t013sec2', {
      limits: {
        preAuthRate: { capacityMessages: 5, refillMessagesPerSecond: 0.1 },
        credentialFailureRate: { capacityMessages: 3, refillMessagesPerSecond: 0.1 },
      },
    });
    victim = await provisionDevice(w2, { siteId: w2.siteId, assetId: w2.assetId });
    other = await provisionDevice(w2, { siteId: w2.siteId, assetId: w2.assetId });
    await sleep(20);
  });
  afterAll(async () => {
    await w2?.close();
  });

  it('concurrent forged tokens for one credential reach authentication at most the reserved budgets', async () => {
    const now = syncClock(w2);
    const before = await authAudits('TOKEN_REJECTED');
    const forgedKey = new Uint8Array(randomBytes(32));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post(w2, victim, [message(i, now - 5, [temp(victim.channels.temp!, 1)])], { tokenKey: forgedKey }),
      ),
    );
    const statuses = results.map((r) => r.status);
    // (source, credential) budget of 3, then the per-source budget of 5 as fallback; nothing beyond
    expect(statuses.filter((s) => s === 401)).toHaveLength(8);
    expect(statuses.filter((s) => s === 429)).toHaveLength(12);
    expect((await authAudits('TOKEN_REJECTED')) - before).toBe(8);
  });

  it('concurrent malformed tokens from one source reach authentication at most the per-source budget', async () => {
    w2.clock.advance(120_000);
    const now = w2.clock.now();
    const before = await authAudits('MALFORMED_CREDENTIAL');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post(w2, victim, [message(i, now - 5, [temp(victim.channels.temp!, 1)])], { token: 'a.b.c' }),
      ),
    );
    expect(results.filter((r) => r.status === 401)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(15);
    expect((await authAudits('MALFORMED_CREDENTIAL')) - before).toBe(5);
  });

  it("an attacker exhausting failures from the same address does not block a valid device's ingestion", async () => {
    w2.clock.advance(120_000);
    let now = w2.clock.now();
    // both devices have authenticated before (their credentials are known to this gateway)
    for (const d of [victim, other]) {
      const r = await post(w2, d, [message(1000, now - 5, [temp(d.channels.temp!, 3800)])]);
      expect(r.status).toBe(200);
    }
    // the attacker, from the same address, burns the per-source budget and the victim's credential budget
    const forgedKey = new Uint8Array(randomBytes(32));
    for (let i = 0; i < 10; i++) {
      await post(w2, victim, [message(i, now, [temp(victim.channels.temp!, 1)])], { token: 'a.b.c' });
      await post(w2, victim, [message(i, now, [temp(victim.channels.temp!, 1)])], { tokenKey: forgedKey });
    }
    const blocked = await post(w2, victim, [message(1, now, [temp(victim.channels.temp!, 1)])], { token: 'a.b.c' });
    expect(blocked.status).toBe(429);
    // valid credentials are still accepted, for the targeted device and for its neighbour
    now = w2.clock.advance(1_000);
    for (const d of [victim, other]) {
      const r = await post(w2, d, [message(1001, now - 5, [temp(d.channels.temp!, 3800)])]);
      expect(r.status).toBe(200);
      expect(r.body.results).toEqual([expect.objectContaining({ status: 'ACCEPTED' })]);
    }
  });

  it("an attacker presenting a cold device's kid from another address cannot stop its first valid token", async () => {
    w2.clock.advance(120_000);
    const cold = await provisionDevice(w2, { siteId: w2.siteId, assetId: w2.assetId });
    await sleep(20);
    const now = syncClock(w2);
    const forgedKey = new Uint8Array(randomBytes(32));
    const attack: number[] = [];
    for (let i = 0; i < 30; i++)
      attack.push(
        (
          await post(w2, cold, [message(i, now - 5, [temp(cold.channels.temp!, 1)])], {
            tokenKey: forgedKey,
            remoteAddress: '10.9.9.9',
          })
        ).status,
      );
    expect(attack).toContain(429);
    const ok = await post(w2, cold, [message(100, now - 5, [temp(cold.channels.temp!, 3800)])], {
      remoteAddress: '10.1.1.1',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.results).toEqual([expect.objectContaining({ status: 'ACCEPTED' })]);
  });

  it('a replayed valid token is rejected and charged, and does not evict the cached credential', async () => {
    w2.clock.advance(120_000);
    const d = await provisionDevice(w2, { siteId: w2.siteId, assetId: w2.assetId });
    await sleep(20);
    let now = syncClock(w2);
    const ip = '10.2.2.2';
    // first use goes through database authentication (the credential is not known yet) and teaches the key
    const token = await signPrincipalToken('DEVICE', d.deviceId, d.key);
    expect(
      (await post(w2, d, [message(1, now - 5, [temp(d.channels.temp!, 3800)])], { token, remoteAddress: ip })).status,
    ).toBe(200);
    const charged = w2.gw.metrics().chargedAuthFailures;
    const replay = await post(w2, d, [message(2, now - 5, [temp(d.channels.temp!, 3800)])], {
      token,
      remoteAddress: ip,
    });
    expect(replay.status).toBe(401);
    expect(w2.gw.metrics().chargedAuthFailures).toBeGreaterThan(charged);
    // exhaust this address's budget; the device's next valid token is still recognised from the cached key
    for (let i = 0; i < 10; i++)
      await post(w2, d, [message(i, now, [temp(d.channels.temp!, 1)])], { token: 'a.b.c', remoteAddress: ip });
    expect(
      (await post(w2, d, [message(3, now, [temp(d.channels.temp!, 1)])], { token: 'a.b.c', remoteAddress: ip })).status,
    ).toBe(429);
    now = w2.clock.advance(1_000);
    const fresh = await post(w2, d, [message(4, now - 5, [temp(d.channels.temp!, 3800)])], { remoteAddress: ip });
    expect(fresh.status).toBe(200);
    expect(fresh.body.results).toEqual([expect.objectContaining({ status: 'ACCEPTED' })]);
  });
});
