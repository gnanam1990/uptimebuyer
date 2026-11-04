// T-033 — Cost-to-recovery formula correctness, persisted (FR-09, INV-03, INV-04). The server engine builds a plan
// from M06 decisions and M07 quotes: only policy-eligible ALLOW candidates for the current action digest are ranked;
// HOLD/REJECT candidates are listed with reasons and never priced; every input carries unit, provenance, revision and
// as_of; the immutable plan revision binds the tenant/incident/asset/evidence/policy revisions and action digests in
// its plan hash; it is evented and ledgered, and only the engine may build it.
import { decodeWire } from '@uptimebuyer/contracts';
import { evaluateCandidate } from '@uptimebuyer/compatibility';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlanCreatedEventSchema, createRecoveryPlan, getRecoveryPlan, listIncidentPlans } from '../src/index.js';
import { exactCandidate, merchant } from '../../compatibility/test/helpers.js';
import {
  createPlanningWorld,
  labelsInOrder,
  outboxEvents,
  rejection,
  scenario,
  type PlanningWorld,
  type Scenario,
} from './helpers.js';
import { money } from '@uptimebuyer/contracts';

let w: PlanningWorld;
let s: Scenario;

describe('T-033 cost-to-recovery formula correctness (persisted plan)', () => {
  beforeAll(async () => {
    w = await createPlanningWorld('t033');
    s = await scenario(w, [
      { label: 'oem-cheap', priceMinor: 18_500n, etaMinutes: 25 },
      { label: 'oem-fast', priceMinor: 24_000n, etaMinutes: 10 },
    ]);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('ranks the ALLOW candidates by expected cost with every component exposed', async () => {
    expect(s.pairs.map((p) => p.decision)).toEqual(['ALLOW', 'ALLOW']);
    const plan = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: s.refs },
      w.signing,
    );
    expect(plan).toMatchObject({
      created: true,
      state: 'APPROVABLE',
      outcome: 'RANKED',
      incomplete: false,
      revision: 1,
    });
    expect(labelsInOrder(plan, s)).toEqual(['oem-cheap', 'oem-fast']);
    const cheap = plan.actions.find((a) => a.candidateActionId === s.byLabel['oem-cheap']!.candidateActionId)!;
    // 18500 + 25 min * 6000/h + 5% * 500000 + 2% * 40000 = 46800 (deadline 30 min after the report fits a 25 min ETA)
    expect(cheap.expectedCostMinor).toBe(46_800n);
    expect(cheap.currency).toBe('USD');
    expect(cheap.components.map((c) => [c.key, c.exact])).toEqual([
      ['PURCHASE_OR_SERVICE', { num: '18500', den: '1' }],
      ['DELAY_DOWNTIME', { num: '2500', den: '1' }],
      ['INVENTORY_RISK', { num: '25000', den: '1' }],
      ['REPEAT_FAILURE', { num: '800', den: '1' }],
    ]);
    expect(cheap.expectedCostRange).toEqual({ lowMinor: 36_400n, highMinor: 62_600n });
    const inputs = Object.fromEntries(cheap.inputs.map((i) => [i.field, i]));
    expect(inputs.purchaseOrService!.provenance).toMatchObject({
      source: 'CANDIDATE_ACTION',
      ref: cheap.candidateActionId,
    });
    expect(inputs.expectedDelay!.provenance).toMatchObject({ source: 'PROVIDER_QUOTE', ref: cheap.quoteId });
    expect(inputs.downtimeCostPerHour!.provenance).toMatchObject({
      source: 'TENANT_RISK_ESTIMATE',
      ref: w.riskEstimateId,
      revision: 1,
    });
    expect(inputs.inventoryValue!.provenance).toMatchObject({ source: 'REGISTRY_FOOD_AT_RISK' });
    expect(inputs.deadline!.provenance).toMatchObject({ source: 'INCIDENT_DEADLINE_PROJECTION', ref: s.incidentId });
    for (const i of cheap.inputs) expect(Date.parse(i.provenance!.asOf)).not.toBeNaN();
    expect(plan.tieBreakRule).toEqual([
      'EXPECTED_COST_ASC',
      'RECOVERY_ETA_ASC',
      'PROVIDER_SCORE_DESC',
      'CANDIDATE_ID_ASC_UTF16',
    ]);
    expect(plan.approved).toBe(false);
  });

  it('binds the revision tuple, action digests and compatibility decisions into the immutable plan', async () => {
    const [plan] = await listIncidentPlans(w.db.pool, w.people.viewer!.ctx, s.incidentId);
    const full = await getRecoveryPlan(w.db.pool, w.people.viewer!.ctx, plan!.planId);
    expect(full.planHash).toMatch(/^recovery-plan\.v1:sha256:[0-9a-f]{64}$/);
    expect(full.binding).toMatchObject({
      evidenceRevisionId: s.evidenceRevisionId,
      policyRevisionId: w.policyRevisionId,
      riskEstimateId: w.riskEstimateId,
    });
    for (const a of full.actions) {
      const pair = s.pairs.find((p) => p.candidateActionId === a.candidateActionId)!;
      expect(a.compatibilityDecisionId).toBe(pair.compatibilityDecisionId);
      expect(a.actionDigest).toMatch(/^action\.v1:sha256:/);
    }
    const upd = await w.db.pool
      .query(`UPDATE recovery_plans SET plan_hash = $3 WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        full.planId,
        `recovery-plan.v1:sha256:${'0'.repeat(64)}`,
      ])
      .catch((e) => e);
    expect(upd.code).toBe('UB001');
    const del = await w.db.pool
      .query(`DELETE FROM plan_actions WHERE tenant_id = $1 AND plan_id = $2`, [w.tenant.tenantId, full.planId])
      .catch((e) => e);
    expect(del.code).toBe('UB001');
    const skip = await w.db.pool
      .query(`UPDATE recovery_plans SET state = 'EXECUTING', version = version + 1 WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        full.planId,
      ])
      .catch((e) => e);
    expect(skip.code).toBe('UB001');
  });

  it('emits plan.created.v1 and a policy-decision ledger entry; approved is always false', async () => {
    const [plan] = await listIncidentPlans(w.db.pool, w.people.viewer!.ctx, s.incidentId);
    const events = await outboxEvents(w, 'plan.created.v1', plan!.planId);
    expect(events).toHaveLength(1);
    const e = decodeWire(PlanCreatedEventSchema, events[0]);
    expect(e.payload).toMatchObject({
      planId: plan!.planId,
      planHash: plan!.planHash,
      state: 'APPROVABLE',
      approved: false,
    });
    const ledger = await w.db.pool.query(
      `SELECT kind FROM evidence_ledger_entries WHERE tenant_id = $1 AND subject_aggregate_type = 'plan' AND subject_aggregate_id = $2`,
      [w.tenant.tenantId, plan!.planId],
    );
    expect(ledger.rows.map((r) => r.kind)).toEqual(['POLICY_DECISION']);
  });

  it('shows HOLD candidates with their reasons, never ranked or priced', async () => {
    const extra = await exactCandidate(
      w,
      { incidentId: s.incidentId, evidenceRevisionId: s.evidenceRevisionId },
      { merchantId: merchant(), amount: money(1_000n, 'USD'), vendorId: w.unapprovedVendorId },
    );
    const d = await evaluateCandidate(w.db.pool, w.service, { candidateActionId: extra.candidateActionId }, w.signing);
    expect(d.decision).not.toBe('ALLOW');
    const plan = await createRecoveryPlan(
      w.db.pool,
      w.service,
      {
        incidentId: s.incidentId,
        candidates: [...s.refs, { candidateActionId: extra.candidateActionId, quoteId: null }],
      },
      w.signing,
    );
    expect(plan.outcome).toBe('RANKED');
    expect(labelsInOrder(plan, s)).toEqual(['oem-cheap', 'oem-fast']);
    const held = plan.actions.find((a) => a.candidateActionId === extra.candidateActionId)!;
    expect(held).toMatchObject({ disposition: 'HELD', ordinal: null, expectedCostMinor: null, components: [] });
    expect(held.reasonCodes.length).toBeGreaterThan(0);
  });

  it('only the planning engine builds plans; humans and malformed requests are refused', async () => {
    for (const who of ['operator', 'approver', 'viewer'])
      expect(
        (
          await rejection(
            createRecoveryPlan(
              w.db.pool,
              w.people[who]!.ctx,
              { incidentId: s.incidentId, candidates: s.refs },
              w.signing,
            ),
          )
        ).code,
      ).toBe('FORBIDDEN');
    expect(
      (
        await rejection(
          createRecoveryPlan(w.db.pool, w.service, { incidentId: s.incidentId, candidates: [] }, w.signing),
        )
      ).code,
    ).toBe('VALIDATION_FAILED');
    const dup = await rejection(
      createRecoveryPlan(
        w.db.pool,
        w.service,
        { incidentId: s.incidentId, candidates: [s.refs[0]!, s.refs[0]!] },
        w.signing,
      ),
    );
    expect(dup.code).toBe('VALIDATION_FAILED');
    const smuggled = await rejection(
      createRecoveryPlan(
        w.db.pool,
        w.service,
        { incidentId: s.incidentId, candidates: [{ ...s.refs[0]!, amountMinor: 1n } as never] },
        w.signing,
      ),
    );
    expect(smuggled.code).toBe('VALIDATION_FAILED');
  });
});
