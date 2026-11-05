// Shared fixtures for the M11 recovery-verification and CMMS tests. They extend the M10 orders world (which lives here
// because the in-process RECORDED_CONTRACT broker is importable only inside apps/kite-broker) with: an incident-rule
// revision whose recovery window is one minute (so a window fits in a test), a tenant-wide recovery policy revision,
// a CMMS integration identity per site with a runtime-generated record verifier key, a runtime recovery signing
// keyring, and helpers that carry a paid part purchase to a VERIFYING incident with a temperature sensor on its asset
// and post exact LIVE/LATE/BACKFILL readings through the real M03 gateway. Nothing here is a real CMMS, technician,
// sensor, provider or payment; every key is generated at runtime and never persisted.
import { randomBytes } from 'node:crypto';
import type { SiteId } from '@uptimebuyer/contracts';
import {
  assignRole,
  authenticateIntegration,
  registerIntegrationIdentity,
  resolveTenantContext,
  signPrincipalToken,
  type TenantContext,
} from '@uptimebuyer/data';
import { getIncident, publishIncidentRule } from '@uptimebuyer/incidents';
import {
  dispatchOrder,
  ingestFulfillmentWebhook,
  recordFulfillmentVerification,
  runFulfillmentObservationJobs,
  syncIncidentForOrder,
} from '@uptimebuyer/orders';
import {
  assessRecovery,
  ingestCmmsRecord,
  publishRecoveryPolicy,
  recordInterventionMilestone,
  registerCmmsIntegration,
  signCmmsRecord,
  type RecoveryPolicyBody,
  type RecoverySigning,
} from '@uptimebuyer/recovery';
import { HIGH_TEMP_RULE } from '../../../packages/incidents/test/helpers.js';
import { MANUFACTURER } from '../../../packages/planning/test/helpers.js';
import { message, post, provisionDevice, temp, type TestDevice } from '../../sensor-gateway/test/helpers.js';
import { brokerDeps, createOrdersWorld, eventBody, orderFor, view, webhook, type OrdersWorld } from './m10-helpers.js';

export const POLICY: RecoveryPolicyBody = {
  completionMilestoneType: 'WORK_COMPLETED',
  milestoneSources: ['CMMS', 'AUTHORIZED_OPERATOR'],
  attestationRoles: ['maintenance_approver', 'engineer'],
  requiredSignoffs: ['CMMS_WORK_ORDER'],
  installedPartRequired: true,
  maxBackdateMs: 3_600_000,
  maxFutureSkewMs: 120_000,
  stableWindowMs: 60_000,
  maxGapMs: 20_000,
  minSamples: 4,
  maxTailAgeMs: 30_000,
  maxObservationMs: 30 * 60_000,
  lostSignalAfterMs: 30_000,
  allowSimulatedInput: false,
};

export interface CmmsBinding {
  cmmsIntegrationId: string;
  integrationIdentityId: string;
  ctx: TenantContext;
  verifierKey: Uint8Array;
  siteId: SiteId;
}

export interface RecoveryWorld extends OrdersWorld {
  recoverySigning: RecoverySigning;
  cmms: CmmsBinding;
  farCmms: CmmsBinding;
  recoveryPolicyRevisionId: string;
}

/** A CMMS integration identity (authenticated INTEGRATION principal) bound to one site with a record verifier key. */
export async function cmmsBinding(
  w: OrdersWorld,
  siteId: SiteId,
  label: string,
  admin: TenantContext = w.admin,
): Promise<CmmsBinding> {
  const tag = `${label}-${randomBytes(3).toString('hex')}`;
  const authRef = `secretref:integration/tenants/${admin.tenantId}/${tag}-cmms-auth`;
  const verifierRef = `secretref:webhook/tenants/${admin.tenantId}/${tag}-cmms-records`;
  const authKey = new Uint8Array(randomBytes(32));
  const verifierKey = new Uint8Array(randomBytes(32));
  w.creds.set(authRef, authKey);
  w.creds.set(verifierRef, verifierKey);
  const integ = await registerIntegrationIdentity(w.db.pool, admin, {
    providerAccountId: null,
    credentialRef: authRef,
  });
  await assignRole(w.db.pool, admin, {
    principal: { kind: 'INTEGRATION', integrationIdentityId: integ.integrationIdentityId },
    role: 'integration',
    siteId: null,
  });
  const ctx = await resolveTenantContext(
    w.db.pool,
    await authenticateIntegration(
      w.db.pool,
      w.creds,
      await signPrincipalToken('INTEGRATION', integ.integrationIdentityId, authKey),
    ),
    admin.tenantId,
  );
  const reg = await registerCmmsIntegration(w.db.pool, admin, {
    siteId,
    integrationIdentityId: integ.integrationIdentityId,
    systemKey: 'cmms-sandbox',
    environment: 'SANDBOX',
    verifierRef,
  });
  return {
    cmmsIntegrationId: reg.cmmsIntegrationId,
    integrationIdentityId: integ.integrationIdentityId,
    ctx,
    verifierKey,
    siteId,
  };
}

export async function createRecoveryWorld(label: string, policy: RecoveryPolicyBody = POLICY): Promise<RecoveryWorld> {
  const w = await createOrdersWorld(label);
  // Incidents opened from now on pin a rule revision whose recovery window is one minute.
  await publishIncidentRule(w.db.pool, w.admin, { ...HIGH_TEMP_RULE, recoveryWindowMs: 60_000 });
  const pol = await publishRecoveryPolicy(w.db.pool, w.admin, { siteId: null, body: policy });
  const cmms = await cmmsBinding(w, w.siteId, `${label}-s1`);
  const farCmms = await cmmsBinding(w, w.otherSiteId as SiteId, `${label}-s2`);
  return Object.assign(w, {
    recoverySigning: {
      keyId: 'recovery-k1',
      keyring: Object.freeze({ 'recovery-k1': new Uint8Array(randomBytes(32)) }),
    },
    cmms,
    farCmms,
    recoveryPolicyRevisionId: pol.recoveryPolicyRevisionId,
  });
}

export interface VerifyingIncident {
  incidentId: string;
  assetId: string;
  assetRevisionId: string;
  planId: string;
  planActionId: string;
  actionDigest: string;
  orderId: string;
  device: TestDevice;
  /** Database time (epoch ms) just after the incident reached VERIFYING. */
  readyAt: number;
}

/** Deliver a fulfillment status script for an order through signed webhooks and apply it. */
export async function fulfil(w: OrdersWorld, orderId: string, statuses: string[]) {
  const v = await view(w, orderId);
  for (const status of statuses) {
    const r = await ingestFulfillmentWebhook(
      w.db.pool,
      webhook(w.account.binding, w.account.verifierKey, eventBody(v, status)),
      { credentials: w.creds },
    );
    if (r.status !== 'ACCEPTED') throw new Error(`webhook not accepted: ${JSON.stringify(r)}`);
  }
  await runFulfillmentObservationJobs(w.db.pool, { workerId: 'm11-fixture' });
}

export async function dbNowMs(w: OrdersWorld): Promise<number> {
  const { rows } = await w.db.pool.query(`SELECT clock_timestamp() AS now`);
  return (rows[0].now as Date).getTime();
}

/**
 * A paid part purchase dispatched through the in-process broker, ordered, shipped, delivered and receiving-verified
 * (M10), so the incident is VERIFYING (and the plan COMPLETED); its asset carries a temperature device.
 */
export async function verifyingIncident(w: RecoveryWorld): Promise<VerifyingIncident> {
  const o = await orderFor(w, 'PART_PURCHASE');
  const device = await provisionDevice(w, { siteId: w.siteId, assetId: o.action.assetId as never });
  await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
  await syncIncidentForOrder(w.db.pool, w.service, o.orderId);
  await fulfil(w, o.orderId, ['ordered', 'shipped', 'delivered']);
  await syncIncidentForOrder(w.db.pool, w.service, o.orderId);
  await recordFulfillmentVerification(w.db.pool, w.operator, {
    orderId: o.orderId,
    outcome: 'VERIFIED',
    idempotencyKey: w.key('verify'),
  });
  await syncIncidentForOrder(w.db.pool, w.service, o.orderId);
  const inc = await getIncident(w.db.pool, w.viewerCtx, o.action.incidentId);
  if (inc.state !== 'VERIFYING') throw new Error(`fixture incident is ${inc.state}, not VERIFYING`);
  const order = await view(w, o.orderId);
  return {
    incidentId: o.action.incidentId,
    assetId: o.action.assetId,
    assetRevisionId: inc.assetRevisionId,
    planId: o.action.planId,
    planActionId: o.action.planActionId,
    actionDigest: order.actionDigest,
    orderId: o.orderId,
    device,
    readyAt: await dbNowMs(w),
  };
}

export interface Reading {
  at: number;
  value?: number;
  /** Receipt lag at the gateway (default 0: LIVE). 45 s makes the reading LATE under the default lateness policy. */
  lagMs?: number;
  delivery?: 'LIVE' | 'BACKFILL';
}

let seq = 70_000;
/** Post each reading as its own signed batch with the gateway clock at `at + lagMs`; returns the stored sample ids. */
export async function readings(w: RecoveryWorld, device: TestDevice, points: Reading[]): Promise<string[]> {
  const ids: string[] = [];
  for (const p of points) {
    w.clock.set(p.at + (p.lagMs ?? 0));
    const res = await post(w, device, [message(++seq, p.at, [temp(device.channels.temp!, p.value ?? 4_000)])], {
      delivery: p.delivery ?? 'LIVE',
    });
    const r = res.body.results?.[0];
    if (res.status !== 200 || !r || r.status !== 'ACCEPTED' || !r.sampleId)
      throw new Error(`reading not accepted: ${res.status} ${JSON.stringify(res.body)}`);
    ids.push(r.sampleId);
  }
  return ids;
}

/** Readings every `stepMs` from `startMs` to `endMs` inclusive. */
export function steady(startMs: number, endMs: number, extra: Omit<Reading, 'at'> = {}, stepMs = 10_000): Reading[] {
  const out: Reading[] = [];
  for (let t = startMs; t <= endMs; t += stepMs) out.push({ at: t, ...extra });
  return out;
}

export const iso = (ms: number) => new Date(ms).toISOString();

/** A CMMS work-order signoff record for the incident's approved action (override any field to build attacks). */
export function cmmsRecord(v: VerifyingIncident, occurredAtMs: number, over: Record<string, unknown> = {}) {
  return {
    schema: 'cmms-record.v1',
    recordId: `wo-${randomBytes(6).toString('hex')}`,
    recordType: 'WORK_ORDER_SIGNOFF',
    incidentId: v.incidentId,
    assetId: v.assetId,
    assetRevisionId: v.assetRevisionId,
    planId: v.planId,
    actionDigest: v.actionDigest,
    workOrderRef: `WO-${randomBytes(3).toString('hex')}`,
    milestoneType: 'WORK_COMPLETED',
    occurredAt: iso(occurredAtMs),
    technicianRef: 'tech-0042',
    signerRef: 'supervisor-07',
    installedPart: {
      manufacturer: MANUFACTURER,
      partNumber: '5A1-0402',
      serial: `SN-${randomBytes(4).toString('hex')}`,
      barcode: `0123456${randomBytes(2).toString('hex')}`,
    },
    ...over,
  };
}

/** Sign and submit a CMMS record as the given integration (key/timestamp/raw bytes can be overridden). */
export async function sendCmms(
  w: RecoveryWorld,
  binding: CmmsBinding,
  body: Record<string, unknown>,
  opts: { key?: Uint8Array; ts?: number; raw?: Uint8Array; signature?: string } = {},
) {
  const raw = opts.raw ?? new Uint8Array(Buffer.from(JSON.stringify(body), 'utf8'));
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  return ingestCmmsRecord(
    w.db.pool,
    binding.ctx,
    { signature: opts.signature ?? signCmmsRecord(opts.key ?? binding.verifierKey, ts, raw), rawBody: raw },
    { credentials: w.creds },
  );
}

/** Record the policy-designated completion milestone from a verified CMMS signoff at `occurredAtMs`. */
export async function milestoneAt(
  w: RecoveryWorld,
  v: VerifyingIncident,
  occurredAtMs: number,
  over: Record<string, unknown> = {},
) {
  const ev = await sendCmms(w, w.cmms, cmmsRecord(v, occurredAtMs, over));
  const m = await recordInterventionMilestone(
    w.db.pool,
    w.service,
    { incidentId: v.incidentId, evidenceId: ev.evidenceId, idempotencyKey: w.key('milestone') },
    w.recoverySigning,
  );
  return { evidenceId: ev.evidenceId, milestoneId: m.interventionMilestoneId, boundaryMs: Date.parse(m.occurredAt) };
}

export const assess = (w: RecoveryWorld, v: { incidentId: string }, asOfMs?: number, ctx: TenantContext = w.service) =>
  assessRecovery(
    w.db.pool,
    ctx,
    {
      incidentId: v.incidentId,
      idempotencyKey: w.key('assess'),
      ...(asOfMs === undefined ? {} : { asOf: iso(asOfMs) }),
    },
    w.recoverySigning,
  );

/**
 * The happy path: milestone 5 s after "now", seven LIVE in-range readings 10 s apart strictly after it, assessed at
 * the last reading. Returns the incident, the boundary and the sample ids.
 */
export async function recoveredIncident(w: RecoveryWorld, v?: VerifyingIncident) {
  const inc = v ?? (await verifyingIncident(w));
  const m = await milestoneAt(w, inc, (await dbNowMs(w)) + 5_000);
  const ids = await readings(w, inc.device, steady(m.boundaryMs + 1_000, m.boundaryMs + 61_000));
  const r = await assess(w, inc, m.boundaryMs + 61_500);
  return { inc, m, ids, r };
}

export async function incidentRow(w: RecoveryWorld, incidentId: string) {
  return (
    await w.db.pool.query(`SELECT * FROM incidents WHERE tenant_id = $1 AND id = $2`, [w.tenant.tenantId, incidentId])
  ).rows[0];
}

export async function transitionPath(w: RecoveryWorld, incidentId: string) {
  return (
    await w.db.pool.query(
      `SELECT from_state, to_state, guard_ref FROM incident_transitions WHERE tenant_id = $1 AND incident_id = $2 ORDER BY incident_version`,
      [w.tenant.tenantId, incidentId],
    )
  ).rows.map((r) => `${r.from_state ?? '-'}>${r.to_state}`);
}
