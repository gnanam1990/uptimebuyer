// T-035 / INV-03 — approval request preparation and the plan lifecycle (STATE-MACHINES §4). An approval request is
// prepared only for a ranked action of an APPROVABLE plan whose hash the caller names and whose inputs, recomputed
// now, still reproduce that hash; its exact scope (action kind, provider-account revision, maximum amount, currency,
// incident, asset/evidence/policy revisions, action digest, plan hash, expiry) is server-derived. Price, decision,
// evidence and asset-revision changes invalidate open plans (and their requests and unexecuted approvals) through the
// planning consumer and the plan.revalidate_for_asset_revision job; a stale, forged or incomplete plan holds.
import { decodeWire, money } from '@uptimebuyer/contracts';
import { getAsset, recordApproval, reviseAssetIdentity } from '@uptimebuyer/data';
import { PlanInvalidatedPayloadSchema } from '@uptimebuyer/evidence';
import { recordQuote } from '@uptimebuyer/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PLANNING_CONSUMER,
  createRecoveryPlan,
  getApprovalRequest,
  getRecoveryPlan,
  handlePlanningEvent,
  prepareApprovalRequest,
  runPlanRevalidationJobs,
} from '../src/index.js';
import {
  MANUFACTURER,
  createPlanningWorld,
  outboxEvents,
  rejection,
  scenario,
  type Offer,
  type PlanningWorld,
} from './helpers.js';

let w: PlanningWorld;
const OFFERS: Offer[] = [
  { label: 'cheap', priceMinor: 18_500n, etaMinutes: 25 },
  { label: 'fast', priceMinor: 24_000n, etaMinutes: 10 },
];

async function planFor(offers = OFFERS, opts: Parameters<typeof scenario>[2] = {}) {
  const s = await scenario(w, offers, opts);
  const plan = await createRecoveryPlan(
    w.db.pool,
    w.service,
    { incidentId: s.incidentId, candidates: s.refs },
    w.signing,
  );
  return { s, plan, top: plan.actions.find((a) => a.ordinal === 1)! };
}

async function drainPlanning() {
  for (const type of [
    'plan.invalidated.v1',
    'provider.quote_recorded.v1',
    'compatibility.evaluated.v1',
    'incident.deadline_changed.v1',
    'evidence.revision_committed.v1',
  ])
    for (const e of await outboxEvents(w, type)) await handlePlanningEvent(w.db.pool, e as never);
}

describe('T-035 approval request preparation holds on stale, forged or incomplete plans (INV-03)', () => {
  beforeAll(async () => {
    w = await createPlanningWorld('t035l');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('prepares the exact server-derived scope for a ranked action, idempotently', async () => {
    const { s, plan, top } = await planFor();
    const req = await prepareApprovalRequest(
      w.db.pool,
      w.service,
      { planId: plan.planId, planHash: plan.planHash, planActionId: top.planActionId },
      w.signing,
    );
    const asset = await getAsset(w.db.pool, w.admin, s.assetId);
    expect(req).toMatchObject({
      created: true,
      state: 'PENDING',
      planId: plan.planId,
      planHash: plan.planHash,
      planActionId: top.planActionId,
      scope: {
        actionKind: 'PART_PURCHASE',
        actionClass: 'STANDARD',
        incidentId: s.incidentId,
        siteId: w.siteId,
        assetRevisionId: asset.currentRevisionId,
        evidenceRevisionId: s.evidenceRevisionId,
        policyRevisionId: w.policyRevisionId,
        actionDigest: top.actionDigest,
        providerAccountRevisionId: w.providerAccountRevisionId,
        maxAmount: money(18_500n, 'USD'),
        paid: true,
      },
      authority: 'NONE',
      executable: false,
    });
    expect(Date.parse(req.scope.expiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(req.scope.expiresAt)).toBeLessThanOrEqual(Date.now() + 4 * 3_600_000 + 5_000);
    expect(req.requestDigest).toMatch(/^plan-approval-request\.v1:sha256:/);
    const again = await prepareApprovalRequest(
      w.db.pool,
      w.service,
      { planId: plan.planId, planHash: plan.planHash, planActionId: top.planActionId },
      w.signing,
    );
    expect(again).toMatchObject({ created: false, approvalRequestId: req.approvalRequestId });
    expect(await getApprovalRequest(w.db.pool, w.people.viewer!.ctx, req.approvalRequestId)).toMatchObject({
      approvalRequestId: req.approvalRequestId,
      scope: { maxAmount: money(18_500n, 'USD') },
    });
    // The request is immutable and the database refuses a scope that does not match its plan action.
    const upd = await w.db.pool
      .query(`UPDATE plan_approval_requests SET max_amount_minor = 1 WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        req.approvalRequestId,
      ])
      .catch((e) => e);
    expect(upd.code).toBe('UB001');
  });

  it('refuses a forged plan hash, an unranked action and a client-chosen longer expiry', async () => {
    const { plan, top } = await planFor();
    const forged = await rejection(
      prepareApprovalRequest(
        w.db.pool,
        w.service,
        { planId: plan.planId, planHash: `recovery-plan.v1:sha256:${'a'.repeat(64)}`, planActionId: top.planActionId },
        w.signing,
      ),
    );
    expect(forged).toMatchObject({ code: 'DIGEST_MISMATCH', reasonCode: 'PLAN_HASH_MISMATCH' });
    const smuggled = await rejection(
      prepareApprovalRequest(
        w.db.pool,
        w.service,
        { planId: plan.planId, planHash: plan.planHash, planActionId: top.planActionId, maxAmountMinor: 1n } as never,
        w.signing,
      ),
    );
    expect(smuggled.code).toBe('VALIDATION_FAILED');
    const capped = await prepareApprovalRequest(
      w.db.pool,
      w.service,
      {
        planId: plan.planId,
        planHash: plan.planHash,
        planActionId: top.planActionId,
        expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
      w.signing,
    );
    expect(Date.parse(capped.scope.expiresAt)).toBeLessThanOrEqual(Date.now() + 4 * 3_600_000 + 5_000);
    for (const who of ['operator', 'approver', 'viewer'])
      expect(
        (
          await rejection(
            prepareApprovalRequest(
              w.db.pool,
              w.people[who]!.ctx,
              { planId: plan.planId, planHash: plan.planHash, planActionId: top.planActionId },
              w.signing,
            ),
          )
        ).code,
      ).toBe('FORBIDDEN');
  });

  it('a new quote revision (price change) invalidates the open plan, its request and the bound approval', async () => {
    const { s, plan, top } = await planFor();
    const req = await prepareApprovalRequest(
      w.db.pool,
      w.service,
      { planId: plan.planId, planHash: plan.planHash, planActionId: top.planActionId },
      w.signing,
    );
    const approval = await recordApproval(w.db.pool, w.people.approver!.ctx, {
      approvalKind: 'PLAN_ACTION',
      incidentId: s.incidentId,
      siteId: w.siteId,
      assetRevisionId: req.scope.assetRevisionId,
      evidenceRevisionId: req.scope.evidenceRevisionId,
      policyRevisionId: req.scope.policyRevisionId,
      planHash: req.planHash,
      actionDigest: req.scope.actionDigest,
      actionClass: 'STANDARD',
      paid: true,
      providerAccountRevisionId: req.scope.providerAccountRevisionId,
      targetExecutionAuthorityId: null,
      maxAmount: req.scope.maxAmount,
      expiresAt: req.scope.expiresAt,
    });
    const contact = await w.db.pool.query(
      `SELECT contact_request_id FROM provider_quotes WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, top.quoteId],
    );
    await recordQuote(w.db.pool, w.people.operator!.ctx, {
      contactRequestId: contact.rows[0].contact_request_id,
      sourceKind: 'OPERATOR_ENTRY',
      scopeKind: 'PART_SUPPLY',
      partNumber: '5A1-0402',
      manufacturer: MANUFACTURER,
      amount: money(19_900n, 'USD'),
      taxMinor: 0n,
      etaMinutes: 25,
      availabilityStatus: 'AVAILABLE',
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      sourceEvidence: { note: 'price revised on callback' },
    });
    await drainPlanning();
    const after = await getRecoveryPlan(w.db.pool, w.people.viewer!.ctx, plan.planId);
    expect(after).toMatchObject({ state: 'INVALIDATED', invalidatedReason: 'QUOTE_CHANGED' });
    expect(after.transitions.map((t) => t.to)).toEqual(['DRAFT', 'EVALUATED', 'APPROVABLE', 'INVALIDATED']);
    expect(await getApprovalRequest(w.db.pool, w.people.viewer!.ctx, req.approvalRequestId)).toMatchObject({
      state: 'INVALIDATED',
      invalidatedReason: 'QUOTE_CHANGED',
    });
    const ev = await w.db.pool.query(
      `SELECT event_type, reason_code FROM approval_events WHERE tenant_id = $1 AND approval_id = $2`,
      [w.tenant.tenantId, approval.approvalId],
    );
    expect(ev.rows).toEqual([{ event_type: 'INVALIDATED', reason_code: 'PLAN_INVALIDATED' }]);
    const stale = await rejection(
      prepareApprovalRequest(
        w.db.pool,
        w.service,
        { planId: plan.planId, planHash: plan.planHash, planActionId: top.planActionId },
        w.signing,
      ),
    );
    expect(stale).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'PLAN_NOT_APPROVABLE' });
    const inv = (await outboxEvents(w, 'plan.invalidated.v1', s.incidentId)).map((e) =>
      decodeWire(PlanInvalidatedPayloadSchema, e.payload),
    );
    expect(inv.at(-1)).toMatchObject({
      reasonCode: 'PLAN_INPUT_STALE',
      staleInputs: ['QUOTE'],
      invalidatedPlanIds: [plan.planId],
      invalidatedApprovalRequestIds: [req.approvalRequestId],
      invalidatedApprovalIds: [approval.approvalId],
    });
    // Redelivery is a no-op for the idempotent consumer.
    const e = (await outboxEvents(w, 'provider.quote_recorded.v1')).at(-1)!;
    expect(await handlePlanningEvent(w.db.pool, e as never)).toBe('DUPLICATE');
    expect(PLANNING_CONSUMER).toBe('planning-revalidation.v1');
  });

  it('recomputes before preparing: an input that went stale without an event (quote expiry) holds and invalidates', async () => {
    const { plan, top } = await planFor([
      { label: 'cheap', priceMinor: 18_500n, etaMinutes: 25, validForMs: 2_500 },
      { label: 'fast', priceMinor: 24_000n, etaMinutes: 10 },
    ]);
    expect(plan.state).toBe('APPROVABLE');
    await new Promise((r) => setTimeout(r, 3_000));
    const held = await rejection(
      prepareApprovalRequest(
        w.db.pool,
        w.service,
        { planId: plan.planId, planHash: plan.planHash, planActionId: top.planActionId },
        w.signing,
      ),
    );
    expect(held).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'PLAN_STALE' });
    expect((await getRecoveryPlan(w.db.pool, w.people.viewer!.ctx, plan.planId)).state).toBe('INVALIDATED');
  });

  it('a compatibility decision superseded without a plan event is caught by the recompute at preparation', async () => {
    const { s, plan, top } = await planFor();
    const topPair = s.pairs.find((p) => p.candidateActionId === top.candidateActionId)!;
    await w.db.pool.query(
      `UPDATE compatibility_decisions SET lifecycle = 'SUPERSEDED', superseded_at = clock_timestamp(),
              superseded_reason = 'NEW_EVALUATION' WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, topPair.compatibilityDecisionId],
    );
    const held = await rejection(
      prepareApprovalRequest(
        w.db.pool,
        w.service,
        { planId: plan.planId, planHash: plan.planHash, planActionId: top.planActionId },
        w.signing,
      ),
    );
    expect(held).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'PLAN_STALE' });
    expect((await getRecoveryPlan(w.db.pool, w.people.viewer!.ctx, plan.planId)).state).toBe('INVALIDATED');
  });

  it('the plan.revalidate_for_asset_revision job invalidates plans bound to a superseded asset revision', async () => {
    const { s, plan, top } = await planFor();
    const req = await prepareApprovalRequest(
      w.db.pool,
      w.service,
      { planId: plan.planId, planHash: plan.planHash, planActionId: top.planActionId },
      w.signing,
    );
    const asset = await getAsset(w.db.pool, w.admin, s.assetId);
    await reviseAssetIdentity(
      w.db.pool,
      w.admin,
      s.assetId,
      {
        manufacturer: asset.current.manufacturer,
        model: asset.current.model,
        serial: `${asset.current.serial}-R`,
        safetyClass: asset.current.safetyClass,
        bomRevision: asset.current.bomRevision,
      },
      { expectedVersion: asset.version, source: 'API' },
    );
    const run = await runPlanRevalidationJobs(w.db.pool, { workerId: 'planning-worker-1' });
    expect(run.processed).toBeGreaterThanOrEqual(1);
    expect(run.invalidatedPlanIds).toContain(plan.planId);
    const after = await getRecoveryPlan(w.db.pool, w.people.viewer!.ctx, plan.planId);
    expect(after).toMatchObject({ state: 'INVALIDATED', invalidatedReason: 'ASSET_REVISION_SUPERSEDED' });
    expect((await getApprovalRequest(w.db.pool, w.people.viewer!.ctx, req.approvalRequestId)).state).toBe(
      'INVALIDATED',
    );
    const jobs = await w.db.pool.query(
      `SELECT state FROM jobs WHERE tenant_id = $1 AND kind = 'plan.revalidate_for_asset_revision'`,
      [w.tenant.tenantId],
    );
    expect(jobs.rows.every((r) => r.state === 'SUCCEEDED')).toBe(true);
    // A rerun finds nothing left to do.
    expect((await runPlanRevalidationJobs(w.db.pool, { workerId: 'planning-worker-1' })).processed).toBe(0);
  });

  it('a new plan revision supersedes the open one, and a plan cannot be built for a recovered or unknown incident', async () => {
    const { s, plan } = await planFor();
    const extra = await scenario(w, [{ label: 'x', priceMinor: 30_000n, etaMinutes: 5 }]);
    expect(extra.incidentId).not.toBe(s.incidentId);
    const two = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: [s.refs[1]!, s.refs[0]!] },
      w.signing,
    );
    expect(two.created).toBe(false); // same inputs, any order -> the same plan revision
    const one = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: [s.refs[0]!] },
      w.signing,
    );
    expect(one).toMatchObject({ created: true, revision: 2 });
    expect((await getRecoveryPlan(w.db.pool, w.people.viewer!.ctx, plan.planId)).invalidatedReason).toBe(
      'SUPERSEDED_BY_NEW_PLAN',
    );
    const cross = await rejection(
      createRecoveryPlan(w.db.pool, w.service, { incidentId: s.incidentId, candidates: extra.refs }, w.signing),
    );
    expect(cross.code).toBe('FORBIDDEN');
    const unknown = await rejection(
      createRecoveryPlan(
        w.db.pool,
        w.service,
        { incidentId: 'inc_00000000-0000-0000-0000-000000000000', candidates: s.refs },
        w.signing,
      ),
    );
    expect(unknown.code).toBe('FORBIDDEN');
  });
});
