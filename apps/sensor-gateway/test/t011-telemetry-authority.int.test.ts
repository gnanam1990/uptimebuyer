// T-011 — Role and approval authority denial, re-run by M03 against the telemetry surfaces (FR-24, NFR-05).
// Only an authenticated device may ingest, and only for itself; humans, services and integrations cannot ingest
// through the repository or the gateway. Telemetry and health reads require a human role at the device's site (or
// an internal worker context); devices, services and site-scoped users at another site are denied identically.
import { randomBytes } from 'node:crypto';
import {
  addMembership,
  assignRole,
  authenticateDevice,
  authenticateService,
  authorize,
  createSite,
  getDeviceHealth,
  ingestTelemetryBatch,
  listTelemetrySamples,
  registerServiceIdentity,
  resolveTenantContext,
  signPrincipalToken,
  upsertUser,
  type TenantContext,
} from '@uptimebuyer/data';
import type { SiteId } from '@uptimebuyer/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { humanContext } from '../../../packages/data/test/helpers.js';
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
let site2: SiteId;
const ctx: Record<string, TenantContext> = {};

async function human(role: 'viewer' | 'operator' | 'auditor' | 'admin', siteId: SiteId | null) {
  const subject = `${role}-${randomBytes(4).toString('hex')}`;
  const user = await upsertUser(w.db.pool, { issuer: w.idp.issuer, externalSubject: subject, displayName: role });
  await addMembership(w.db.pool, w.admin, user.userId);
  await assignRole(w.db.pool, w.admin, { principal: { kind: 'HUMAN', userId: user.userId }, role, siteId });
  return { ctx: await humanContext(w.db.pool, w.idp, subject, w.tenant.tenantId), subject };
}

describe('T-011 telemetry role and authority denial', () => {
  beforeAll(async () => {
    w = await createWorld('t011m03');
    dev = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    site2 = (await createSite(w.db.pool, w.admin, { name: 'S2', timezone: 'UTC', source: 'API' })).siteId;
    ctx.viewerS1 = (await human('viewer', w.siteId)).ctx;
    ctx.viewerS2 = (await human('viewer', site2)).ctx;
    ctx.auditor = (await human('auditor', null)).ctx;
    ctx.admin = w.admin;
    ctx.device = await resolveTenantContext(
      w.db.pool,
      await authenticateDevice(w.db.pool, w.creds, await signPrincipalToken('DEVICE', dev.deviceId, dev.key)),
      undefined,
    );
    const ref = `secretref:service/tenants/${w.tenant.tenantId}/svc-${randomBytes(4).toString('hex')}`;
    const svc = await registerServiceIdentity(w.db.pool, w.admin, { workload: 'sensor-gateway', credentialRef: ref });
    const svcKey = new Uint8Array(randomBytes(32));
    w.creds.set(ref, svcKey);
    ctx.service = await resolveTenantContext(
      w.db.pool,
      await authenticateService(w.db.pool, w.creds, await signPrincipalToken('SERVICE', svc.serviceIdentityId, svcKey)),
      undefined,
    );
    await sleep(20);
    const now = syncClock(w);
    await post(w, dev, [message(1, now - 10, [temp(dev.channels.temp!, 3900)])]);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('telemetry.read is allowed to human roles at the device site and to nobody else', () => {
    const allowed = (c: TenantContext, siteId: SiteId) => authorize(c, { action: 'telemetry.read', siteId }).allowed;
    expect(allowed(ctx.viewerS1!, w.siteId)).toBe(true);
    expect(allowed(ctx.auditor!, w.siteId)).toBe(true);
    expect(allowed(ctx.admin!, w.siteId)).toBe(true);
    expect(allowed(ctx.viewerS2!, w.siteId)).toBe(false);
    expect(allowed(ctx.device!, w.siteId)).toBe(false);
    expect(allowed(ctx.service!, w.siteId)).toBe(false);
    for (const c of ['viewerS1', 'viewerS2', 'auditor', 'admin', 'service'])
      expect(authorize(ctx[c]!, { action: 'telemetry.ingest', siteId: w.siteId }).allowed, c).toBe(false);
    expect(authorize(ctx.device!, { action: 'telemetry.ingest', siteId: w.siteId }).allowed).toBe(true);
    expect(authorize(ctx.device!, { action: 'telemetry.ingest', siteId: site2 }).allowed).toBe(false);
  });

  it('reads are denied to devices, services and users scoped to another site, exactly like a missing device', async () => {
    const now = new Date(w.clock.now()).toISOString() as never;
    const ok = await getDeviceHealth(w.db.pool, ctx.viewerS1!, dev.deviceId, { now });
    expect(ok.channels.length).toBeGreaterThan(0);
    expect(await listTelemetrySamples(w.db.pool, ctx.auditor!, { channelId: dev.channels.temp! })).toHaveLength(1);
    for (const c of ['viewerS2', 'device', 'service']) {
      await expect(getDeviceHealth(w.db.pool, ctx[c]!, dev.deviceId, { now }), c).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(
        listTelemetrySamples(w.db.pool, ctx[c]!, { channelId: dev.channels.temp! }),
        c,
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('only the device itself can ingest; human and service contexts are refused by the repository', async () => {
    const now = syncClock(w);
    const batch = {
      schemaVersion: 1 as const,
      deviceId: dev.deviceId,
      delivery: 'LIVE' as const,
      sentAt: new Date(now).toISOString() as never,
      messages: [message(2, now - 5, [temp(dev.channels.temp!, 3900)])],
      disclosures: [],
    };
    const input = { batch, receivedAt: new Date(now).toISOString() as never, bodyDigest: `sha256:${'a'.repeat(64)}` };
    for (const c of ['admin', 'viewerS1', 'auditor', 'service'])
      await expect(ingestTelemetryBatch(w.db.pool, ctx[c]!, input), c).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = await provisionDevice(w, { siteId: w.siteId, assetId: w.assetId });
    const otherCtx = await resolveTenantContext(
      w.db.pool,
      await authenticateDevice(w.db.pool, w.creds, await signPrincipalToken('DEVICE', other.deviceId, other.key)),
      undefined,
    );
    await expect(ingestTelemetryBatch(w.db.pool, otherCtx, input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reasonCode: 'DEVICE_MISMATCH' },
    });
    const r = await ingestTelemetryBatch(w.db.pool, ctx.device!, input);
    expect(r.accepted).toBe(1);
  });

  it('human and service bearer tokens are refused at the gateway', async () => {
    const now = syncClock(w);
    const viewer = await human('viewer', w.siteId);
    const humanToken = await w.idp.mint(viewer.subject);
    const r1 = await post(w, dev, [message(3, now - 5, [temp(dev.channels.temp!, 3900)])], { token: humanToken });
    expect(r1.status).toBe(401);
  });
});
