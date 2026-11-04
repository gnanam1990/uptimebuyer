// T-035 — Missing economic input produces hold (persisted). A required missing or invalid cost/risk input yields an
// explicit incomplete plan (state HELD, no expected cost, no zero or default) and approval preparation is held. The
// candidate/quote binding is checked by the server: a quote that does not match the candidate's amount, currency,
// part, vendor or scope, or a provider that is unavailable, is never priced from client-supplied values.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRecoveryPlan, prepareApprovalRequest, publishTenantRiskEstimate } from '../src/index.js';
import { createPlanningWorld, rejection, riskBody, scenario, type PlanningWorld } from './helpers.js';

let w: PlanningWorld;

const build = async (refs: { candidateActionId: string; quoteId: string | null }[], incidentId: string) =>
  createRecoveryPlan(w.db.pool, w.service, { incidentId, candidates: refs }, w.signing);

describe('T-035 missing economic input produces hold (persisted)', () => {
  beforeAll(async () => {
    w = await createPlanningWorld('t035');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('no food-at-risk value: incomplete HELD plan, nothing priced, approval preparation held', async () => {
    const s = await scenario(w, [{ label: 'a', priceMinor: 18_500n, etaMinutes: 25 }], { inventoryMinor: null });
    const plan = await build(s.refs, s.incidentId);
    expect(plan).toMatchObject({
      state: 'HELD',
      outcome: 'INCOMPLETE',
      incomplete: true,
      holdReasons: ['ECONOMIC_INPUT_INCOMPLETE'],
    });
    const a = plan.actions[0]!;
    expect(a).toMatchObject({ disposition: 'INCOMPLETE', ordinal: null, expectedCostMinor: null, components: [] });
    expect(a.issues).toEqual([{ field: 'inventoryValue', reason: 'MISSING' }]);
    expect(a.inputs.find((i) => i.field === 'inventoryValue')).toMatchObject({ status: 'MISSING', value: null });
    const held = await rejection(
      prepareApprovalRequest(
        w.db.pool,
        w.service,
        { planId: plan.planId, planHash: plan.planHash, planActionId: a.planActionId },
        w.signing,
      ),
    );
    expect(held).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'PLAN_NOT_APPROVABLE' });
    const rows = await w.db.pool.query(`SELECT count(*)::int AS n FROM plan_approval_requests WHERE tenant_id = $1`, [
      w.tenant.tenantId,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('a quote without an ETA leaves the expected delay missing; one eligible gap holds the whole ranking', async () => {
    const s = await scenario(w, [
      { label: 'complete', priceMinor: 18_500n, etaMinutes: 25 },
      { label: 'no-eta', priceMinor: 9_000n, etaMinutes: null },
    ]);
    const plan = await build(s.refs, s.incidentId);
    expect(plan.outcome).toBe('INCOMPLETE');
    expect(plan.actions.every((x) => x.ordinal === null)).toBe(true);
    const gap = plan.actions.find((x) => x.candidateActionId === s.byLabel['no-eta']!.candidateActionId)!;
    expect(gap.issues).toEqual([{ field: 'expectedDelay', reason: 'MISSING' }]);
    const ok = plan.actions.find((x) => x.candidateActionId === s.byLabel['complete']!.candidateActionId)!;
    expect(ok.disposition).toBe('ELIGIBLE_UNRANKED');
  });

  it('a candidate without a quote, or a quote that does not match it, is an input gap, never a client price', async () => {
    const s = await scenario(w, [
      { label: 'no-quote', priceMinor: 18_500n, etaMinutes: 25, noQuote: true },
      { label: 'amount-mismatch', priceMinor: 18_500n, etaMinutes: 25, quoteAmountMinor: 17_000n },
      { label: 'currency-mismatch', priceMinor: 18_600n, etaMinutes: 25, quoteCurrency: 'EUR' },
      { label: 'part-mismatch', priceMinor: 18_700n, etaMinutes: 25, partNumber: '5A1-0499' },
      { label: 'wrong-vendor', priceMinor: 18_800n, etaMinutes: 25, provider: 'fr-207' },
    ]);
    const plan = await build(s.refs, s.incidentId);
    expect(plan.state).toBe('HELD');
    const codes = (label: string) =>
      plan.actions.find((x) => x.candidateActionId === s.byLabel[label]!.candidateActionId)!;
    expect(codes('no-quote').issues).toEqual(
      expect.arrayContaining([
        { field: 'expectedDelay', reason: 'MISSING' },
        { field: 'purchaseOrService', reason: 'MISSING', detail: 'QUOTE_MISSING' },
      ]),
    );
    expect(codes('amount-mismatch').reasonCodes).toContain('QUOTE_AMOUNT_MISMATCH');
    expect(codes('currency-mismatch').reasonCodes).toContain('QUOTE_AMOUNT_MISMATCH');
    expect(codes('part-mismatch').reasonCodes).toContain('QUOTE_PART_MISMATCH');
    expect(codes('wrong-vendor').reasonCodes).toContain('QUOTE_PROVIDER_NOT_CANDIDATE_VENDOR');
    for (const a of plan.actions) expect(a.expectedCostMinor).toBeNull();
  });

  it('an unavailable provider holds that candidate (not executable now) without blocking a complete ranking', async () => {
    const s = await scenario(w, [
      { label: 'ok', priceMinor: 18_500n, etaMinutes: 25 },
      { label: 'unavailable', priceMinor: 9_000n, etaMinutes: 5, availability: 'UNAVAILABLE' },
    ]);
    const plan = await build(s.refs, s.incidentId);
    expect(plan.outcome).toBe('RANKED');
    const u = plan.actions.find((x) => x.candidateActionId === s.byLabel['unavailable']!.candidateActionId)!;
    expect(u).toMatchObject({ disposition: 'HELD', ordinal: null, reasonCodes: ['PROVIDER_UNAVAILABLE'] });
  });

  it('a food-at-risk value in another currency is invalid, not converted', async () => {
    const s = await scenario(w, [{ label: 'a', priceMinor: 18_500n, etaMinutes: 25 }], {
      inventoryMinor: 500_000n,
      inventoryCurrency: 'EUR',
    });
    const plan = await build(s.refs, s.incidentId);
    expect(plan.outcome).toBe('INCOMPLETE');
    expect(plan.actions[0]!.issues).toEqual([{ field: 'inventoryValue', reason: 'CURRENCY_MISMATCH' }]);
  });

  it('a versioned estimate without the action kind leaves repeat-failure risk missing (site estimate overrides)', async () => {
    const site = await publishTenantRiskEstimate(
      w.db.pool,
      w.admin,
      riskBody({
        siteId: w.siteId,
        repeatFailure: {
          costMinor: 40_000n,
          byActionKind: [{ actionKind: 'SERVICE_JOB', estimatePpm: 1, lowPpm: 0, highPpm: 2 }],
        },
      }),
    );
    expect(site.revision).toBe(1);
    const s = await scenario(w, [{ label: 'a', priceMinor: 18_500n, etaMinutes: 25 }]);
    const plan = await build(s.refs, s.incidentId);
    expect(plan.binding.riskEstimateId).toBe(site.riskEstimateId);
    expect(plan.actions[0]!.issues).toEqual([{ field: 'repeatFailureProbability', reason: 'MISSING' }]);
  });

  it('refuses an invalid risk estimate at publication and lets only an administrator publish', async () => {
    const bounds = await rejection(
      publishTenantRiskEstimate(
        w.db.pool,
        w.admin,
        riskBody({
          inventoryLossPpm: {
            withinDeadline: { estimatePpm: 50_000, lowPpm: 60_000, highPpm: 80_000 },
            pastDeadline: { estimatePpm: 600_000, lowPpm: 400_000, highPpm: 800_000 },
          },
        }),
      ),
    );
    expect(bounds.code).toBe('VALIDATION_FAILED');
    const model = await rejection(publishTenantRiskEstimate(w.db.pool, w.admin, riskBody({ basis: 'MODEL_INFORMED' })));
    expect(model.code).toBe('VALIDATION_FAILED');
    for (const who of ['operator', 'approver', 'viewer'])
      expect((await rejection(publishTenantRiskEstimate(w.db.pool, w.people[who]!.ctx, riskBody()))).code).toBe(
        'FORBIDDEN',
      );
  });
});
