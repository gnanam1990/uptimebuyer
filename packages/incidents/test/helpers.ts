// Shared fixtures for the M04 integration tests: the M03 gateway world (throwaway database, seeded tenant, site,
// asset, manual clock, signed device posts), plus tenant users for each incident role, an authenticated worker
// service, a published AUTHORITY policy, an operating procedure and a temperature rule. Synthetic keys are generated
// at runtime; nothing is persisted outside the throwaway database.
import { randomBytes } from 'node:crypto';
import type { AssetId, SiteId, UserId } from '@uptimebuyer/contracts';
import {
  addMembership,
  assignRole,
  authenticateService,
  publishPolicyRevision,
  registerAsset,
  registerServiceIdentity,
  resolveTenantContext,
  signPrincipalToken,
  upsertUser,
  type HumanRole,
  type TenantContext,
} from '@uptimebuyer/data';
import { humanContext } from '../../../packages/data/test/helpers.js';
import {
  createWorld,
  message,
  post,
  provisionDevice,
  syncClock,
  temp,
  type TestDevice,
  type World,
} from '../../../apps/sensor-gateway/test/helpers.js';
import {
  publishIncidentRule,
  publishOperatingProcedure,
  type PublishIncidentRuleInput,
  type PublishProcedureInput,
} from '../src/index.js';
import { recoverIncidentWithEvaluation, type RecoveryEvaluator } from '../src/recovery.js';

export { message, post, provisionDevice, syncClock, temp, type TestDevice, type World };

export interface Person {
  userId: UserId;
  subject: string;
  ctx: TenantContext;
}

export interface IncidentWorld extends World {
  people: Record<string, Person>;
  service: TenantContext;
  policyRevisionId: string;
  procedure: { procedureRevisionId: string; revision: number };
  rule: { ruleRevisionId: string; revision: number };
  key(label?: string): string;
}

export const COLD_CHAIN_PROCEDURE: Omit<PublishProcedureInput, 'initialAssigneeUserId'> = {
  procedureKey: 'cold-chain',
  deadlineKind: 'CONTAINMENT',
  deadlineBasis: 'TRIGGER_EVENT_AT',
  responseDeadlineMs: 30 * 60_000,
  pauseAllowed: true,
  maxExtensionMs: 15 * 60_000,
  adjustRole: 'maintenance_approver',
  timezoneBasis: 'SITE_LOCAL',
};

export const HIGH_TEMP_RULE: PublishIncidentRuleInput = {
  ruleKey: 'cabinet-temp-high',
  siteId: null,
  assetId: null,
  channelKind: 'TEMPERATURE',
  comparator: 'ABOVE',
  thresholdInt: 8_000,
  hysteresisInt: 500,
  durationMs: 120_000,
  minSamples: 4,
  quorumChannels: 1,
  maxGapMs: 60_000,
  maxEvaluationLagMs: 60_000,
  staleBehavior: 'ESCALATE_ACTIVE',
  faultWindowKey: 'cabinet-temperature',
  faultFamily: 'REFRIGERATION_TEMPERATURE_HIGH',
  urgency: 'CRITICAL',
  watchWindowMs: 6 * 3_600_000,
  recoveryWindowMs: 15 * 60_000,
  procedureKey: 'cold-chain',
};

/** A tenant member holding `roles` at `siteId` (null = tenant-wide), with an authenticated context. */
export async function person(
  w: World,
  label: string,
  roles: HumanRole[],
  siteId: SiteId | null,
  admin: TenantContext = w.admin,
): Promise<Person> {
  const subject = `${label}-${randomBytes(4).toString('hex')}`;
  const user = await upsertUser(w.db.pool, { issuer: w.idp.issuer, externalSubject: subject, displayName: label });
  await addMembership(w.db.pool, admin, user.userId);
  for (const role of roles)
    await assignRole(w.db.pool, admin, { principal: { kind: 'HUMAN', userId: user.userId }, role, siteId });
  return { userId: user.userId, subject, ctx: await humanContext(w.db.pool, w.idp, subject, admin.tenantId) };
}

/** An authenticated general-worker service identity with the tenant-wide `worker` role. */
export async function workerService(w: World, admin: TenantContext = w.admin): Promise<TenantContext> {
  const key = new Uint8Array(randomBytes(32));
  const ref = `secretref:service/tenants/${admin.tenantId}/incident-worker-${randomBytes(3).toString('hex')}`;
  w.creds.set(ref, key);
  const svc = await registerServiceIdentity(w.db.pool, admin, { workload: 'general-worker', credentialRef: ref });
  await assignRole(w.db.pool, admin, {
    principal: { kind: 'SERVICE', serviceIdentityId: svc.serviceIdentityId },
    role: 'worker',
    siteId: null,
  });
  return resolveTenantContext(
    w.db.pool,
    await authenticateService(w.db.pool, w.creds, await signPrincipalToken('SERVICE', svc.serviceIdentityId, key)),
    admin.tenantId,
  );
}

export async function createIncidentWorld(label: string): Promise<IncidentWorld> {
  const w = await createWorld(label);
  const people: Record<string, Person> = {
    oncall: await person(w, 'oncall', ['operator'], w.siteId),
    operator: await person(w, 'operator', ['operator'], w.siteId),
    operator2: await person(w, 'operator2', ['operator'], w.siteId),
    approver: await person(w, 'approver', ['maintenance_approver', 'operator'], w.siteId),
    viewer: await person(w, 'viewer', ['viewer'], w.siteId),
    auditor: await person(w, 'auditor', ['auditor'], null),
  };
  const service = await workerService(w);
  const policy = await publishPolicyRevision(w.db.pool, w.admin, {
    policyKey: 'AUTHORITY',
    body: { approvalLimits: [] },
    source: 'API',
  });
  const procedure = await publishOperatingProcedure(w.db.pool, w.admin, {
    ...COLD_CHAIN_PROCEDURE,
    initialAssigneeUserId: people.oncall!.userId,
  });
  const rule = await publishIncidentRule(w.db.pool, w.admin, HIGH_TEMP_RULE);
  let n = 0;
  return {
    ...w,
    people,
    service,
    policyRevisionId: policy.policyRevisionId,
    procedure,
    rule,
    key: (l = 'k') => `${label}-${l}-${++n}-${randomBytes(3).toString('hex')}`,
  };
}

let serial = 0;
/** Register another asset at the world's site with one temperature device assigned to it. */
export async function freshAsset(
  w: IncidentWorld,
  siteId: SiteId = w.siteId,
): Promise<{ assetId: AssetId; device: TestDevice }> {
  const asset = await registerAsset(w.db.pool, w.admin, {
    siteId,
    identity: {
      manufacturer: 'True',
      model: 'T-49',
      serial: `m04-${++serial}-${randomBytes(3).toString('hex')}`,
      safetyClass: 'STANDARD',
      bomRevision: 'BOM-3',
    },
    source: 'API',
  });
  const device = await provisionDevice(w, { siteId, assetId: asset.assetId });
  return { assetId: asset.assetId, device };
}

let seq = 1000;
/**
 * Post `values` as LIVE readings `stepMs` apart, advancing the manual clock to each reading's source time so the
 * gateway classifies them LIVE. Returns the stored sample ids in order and the final clock time.
 */
export async function liveRun(
  w: IncidentWorld,
  device: TestDevice,
  values: number[],
  opts: { stepMs?: number; channel?: string; delivery?: 'LIVE' | 'BACKFILL'; eventOffsetMs?: number } = {},
): Promise<{ sampleIds: string[]; at: number; startAt: number }> {
  const step = opts.stepMs ?? 30_000;
  let at = syncClock(w);
  const startAt = at;
  const sampleIds: string[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i > 0) {
      at += step;
      w.clock.set(at);
    }
    const res = await post(
      w,
      device,
      [message(++seq, at + (opts.eventOffsetMs ?? 0), [temp(device.channels[opts.channel ?? 'temp']!, values[i]!)])],
      { delivery: opts.delivery ?? 'LIVE' },
    );
    if (res.status !== 200) throw new Error(`telemetry post failed: ${res.status} ${JSON.stringify(res.body)}`);
    const r = res.body.results?.[0];
    if (!r || r.status !== 'ACCEPTED' || !r.sampleId) throw new Error(`sample not accepted: ${JSON.stringify(r)}`);
    sampleIds.push(r.sampleId);
  }
  return { sampleIds, at, startAt };
}

export const isoAt = (ms: number) => new Date(ms).toISOString();

export async function rejection(
  p: Promise<unknown>,
): Promise<{ code: string | undefined; reasonCode: string | undefined; message: string | undefined }> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string; details?: { reasonCode?: string } };
    return { code: err.code, reasonCode: err.details?.reasonCode, message: err.message };
  }
  throw new Error('expected rejection');
}

/**
 * TEST-ONLY stand-in for the M11 recovery evaluator. M04 has no recovery evaluations, so the internal recovery hook
 * is driven here by a fake that reports PASSED (or another state) for the named evaluation. This is not evidence of
 * recovery and is never exported from @uptimebuyer/incidents.
 */
export function fakeEvaluator(
  state: 'PASSED' | 'FAILED' | 'OBSERVING' = 'PASSED',
  incidentOverride?: string,
): RecoveryEvaluator {
  return {
    async loadPassedEvaluation(_c, _ctx, incident, recoveryEvaluationId) {
      return {
        recoveryEvaluationId,
        incidentId: incidentOverride ?? incident.incidentId,
        state: state as 'PASSED',
        evidenceDigest: `sha256:${'e'.repeat(64)}`,
      };
    },
  };
}

/** Drive VERIFYING -> RECOVERED through the internal hook with the test-only evaluator. */
export async function recoverForTest(w: IncidentWorld, incidentId: string, expectedVersion: number) {
  return recoverIncidentWithEvaluation(
    w.db.pool,
    w.service,
    incidentId,
    {
      recoveryEvaluationId: 'rev_fixture-passed-0001',
      reasonCode: 'RECOVERY_PASSED',
      expectedVersion,
      idempotencyKey: w.key('recover'),
    },
    fakeEvaluator(),
  );
}
