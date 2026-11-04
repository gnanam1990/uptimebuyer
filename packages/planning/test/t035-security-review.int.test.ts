// T-035 / T-010 — M08 self security review regressions: client-supplied amounts and currency, plan-hash forgery,
// stale-plan approval, tenant isolation of events and oversized identifiers, integer overflow, plan liveness after
// supersession, and the EXECUTING -> INVALIDATED + in-flight reconciliation path of STATE-MACHINES §4.
import { money, newId } from '@uptimebuyer/contracts';
import { recordQuote } from '@uptimebuyer/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRecoveryPlan,
  getApprovalRequest,
  getRecoveryPlan,
  handlePlanningEvent,
  prepareApprovalRequest,
  publishTenantRiskEstimate,
} from '../src/index.js';
import {
  MANUFACTURER,
  createPlanningWorld,
  outboxEvents,
  rejection,
  riskBody,
  scenario,
  type PlanningWorld,
} from './helpers.js';

let w: PlanningWorld;
const OFFERS = [
  { label: 'cheap', priceMinor: 18_500n, etaMinutes: 25 },
  { label: 'fast', priceMinor: 24_000n, etaMinutes: 10 },
];

describe('T-035/T-010 planning security review', () => {
  beforeAll(async () => {
    w = await createPlanningWorld('t035s');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('a plan superseded by another candidate set can be rebuilt as a fresh revision (liveness)', async () => {
    const s = await scenario(w, OFFERS);
    const all = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: s.refs },
      w.signing,
    );
    const one = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: [s.refs[0]!] },
      w.signing,
    );
    expect((await getRecoveryPlan(w.db.pool, w.people.viewer!.ctx, all.planId)).state).toBe('INVALIDATED');
    const back = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: s.refs },
      w.signing,
    );
    expect(back).toMatchObject({ created: true, revision: 3, state: 'APPROVABLE', planHash: all.planHash });
    expect(back.planId).not.toBe(all.planId);
    expect((await getRecoveryPlan(w.db.pool, w.people.viewer!.ctx, one.planId)).state).toBe('INVALIDATED');
    // The old revision's hash cannot be used to prepare against the invalidated row.
    const top = all.actions.find((a) => a.ordinal === 1)!;
    expect(
      (
        await rejection(
          prepareApprovalRequest(
            w.db.pool,
            w.service,
            { planId: all.planId, planHash: all.planHash, planActionId: top.planActionId },
            w.signing,
          ),
        )
      ).reasonCode,
    ).toBe('PLAN_NOT_APPROVABLE');
  });

  it('the database refuses a forged approval-request scope even when the service layer is bypassed', async () => {
    const s = await scenario(w, OFFERS);
    const plan = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: s.refs },
      w.signing,
    );
    const top = plan.actions.find((a) => a.ordinal === 1)!;
    const req = await prepareApprovalRequest(
      w.db.pool,
      w.service,
      { planId: plan.planId, planHash: plan.planHash, planActionId: top.planActionId },
      w.signing,
    );
    const row = (
      await w.db.pool.query(`SELECT * FROM plan_approval_requests WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        req.approvalRequestId,
      ])
    ).rows[0];
    const second = plan.actions.find((a) => a.ordinal === 2)!;
    const forge = async (over: Record<string, unknown>) => {
      const r = { ...row, id: `apq_${newId('command').slice(4)}`, plan_action_id: second.planActionId, ...over };
      const cols = Object.keys(r).filter((k) => !['created_at', 'invalidated_at', 'invalidated_reason'].includes(k));
      return w.db.pool
        .query(
          `INSERT INTO plan_approval_requests (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          cols.map((k) => (k === 'approval_route' ? JSON.stringify(r[k]) : r[k])),
        )
        .catch((e) => e);
    };
    // The second action's own scope differs from the first's: copying the first's amount/digest is refused.
    expect((await forge({})).code).toBe('UB083');
    expect((await forge({ action_digest: second.actionDigest, max_amount_minor: '1' })).code).toBe('UB083');
    expect(
      (
        await forge({
          action_digest: second.actionDigest,
          max_amount_minor: String(second.amount!.amountMinor),
          currency: 'EUR',
        })
      ).code,
    ).toBe('UB083');
  });

  it('an EXECUTING plan is invalidated with in-flight reconciliation, never erased; no new plan while it executes', async () => {
    const s = await scenario(w, OFFERS);
    const plan = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: s.refs },
      w.signing,
    );
    // M09 owns APPROVED/EXECUTING; drive the legal edges directly to exercise the M08 invalidation path.
    for (const to of ['APPROVED', 'EXECUTING'])
      await w.db.pool.query(
        `UPDATE recovery_plans SET state = $3, version = version + 1 WHERE tenant_id = $1 AND id = $2`,
        [w.tenant.tenantId, plan.planId, to],
      );
    const skip = await w.db.pool
      .query(
        `UPDATE recovery_plans SET state = 'INVALIDATED', version = version + 1, invalidated_at = now(),
                invalidated_reason = 'X' WHERE tenant_id = $1 AND id = $2`,
        [w.tenant.tenantId, plan.planId],
      )
      .catch((e) => e);
    expect(skip.code).toBe('UB001');
    const blocked = await rejection(
      createRecoveryPlan(w.db.pool, w.service, { incidentId: s.incidentId, candidates: [s.refs[0]!] }, w.signing),
    );
    expect(blocked).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'PLAN_APPROVED_OR_EXECUTING' });
    const top = plan.actions.find((a) => a.ordinal === 1)!;
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
      amount: money(21_000n, 'USD'),
      taxMinor: 0n,
      etaMinutes: 40,
      availabilityStatus: 'LIMITED',
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      sourceEvidence: { note: 'supplier changed terms mid-execution' },
    });
    for (const e of await outboxEvents(w, 'provider.quote_recorded.v1'))
      await handlePlanningEvent(w.db.pool, e as never);
    const after = await getRecoveryPlan(w.db.pool, w.people.viewer!.ctx, plan.planId);
    expect(after).toMatchObject({
      state: 'INVALIDATED',
      inFlightReconciliation: true,
      invalidatedReason: 'QUOTE_CHANGED',
    });
    expect(after.actions).toHaveLength(2);
    const inv = (await outboxEvents(w, 'plan.invalidated.v1', s.incidentId)).at(-1)!;
    expect(inv.payload).toMatchObject({ inFlightPlanIds: [plan.planId], invalidatedPlanIds: [plan.planId] });
  });

  it('a forged event envelope cannot drive the planning consumer; oversized ids are refused uniformly', async () => {
    const [e] = await outboxEvents(w, 'plan.created.v1');
    const forged = { ...e!, eventId: newId('event'), eventType: 'plan.invalidated.v1', aggregateType: 'plan' };
    const r = await rejection(handlePlanningEvent(w.db.pool, forged as never));
    expect(r.code).toBe('FORBIDDEN');
    const big = `pln_${'a'.repeat(10_000)}`;
    for (const probe of [
      () => getRecoveryPlan(w.db.pool, w.admin, big),
      () => getApprovalRequest(w.db.pool, w.admin, `apq_${'b'.repeat(10_000)}`),
    ]) {
      const x = await rejection(probe());
      expect([x.code, x.reasonCode]).toEqual(['FORBIDDEN', 'RESOURCE_UNAVAILABLE']);
    }
    const bad = await rejection(
      createRecoveryPlan(
        w.db.pool,
        w.service,
        { incidentId: `inc_${'c'.repeat(10_000)}`, candidates: [{ candidateActionId: 'cand_x-0001', quoteId: null }] },
        w.signing,
      ),
    );
    expect(bad.code).toBe('VALIDATION_FAILED');
  });

  it('economic values beyond int64 are refused at publication, not wrapped', async () => {
    const over = 9_223_372_036_854_775_808n;
    for (const body of [
      riskBody({ downtimeCostPerHourMinor: over }),
      riskBody({ repeatFailure: { costMinor: over, byActionKind: [] } }),
      riskBody({ downtimeCostPerHourMinor: -1n }),
      riskBody({ currency: 'XXX' as never }),
    ])
      expect((await rejection(publishTenantRiskEstimate(w.db.pool, w.admin, body))).code).toBe('VALIDATION_FAILED');
  });
});
