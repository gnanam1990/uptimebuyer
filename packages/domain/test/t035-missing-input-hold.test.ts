// T-035 — Missing economic input produces hold (pure layer). A required missing or invalid cost/risk input yields an
// explicit incomplete result: no expected cost, no fabricated zero, no default confidence, and a plan that cannot
// present a winner. Evidence sufficiency and policy eligibility are gates, never price adjustments.
import { describe, expect, it } from 'vitest';
import { computeCostToRecovery, evaluateRecoveryPlan, type CostInputs } from '../src/index.js';
import { EVALUATED_AT, candidate, deadlineAt, planInput, ppmOf, prov, usd, v1Inputs } from './planning-fixtures.js';

const ctx = { evaluatedAt: EVALUATED_AT, deadline: deadlineAt('2026-11-05T10:30:00.000Z') };
const MANDATORY: (keyof CostInputs)[] = [
  'purchaseOrService',
  'expectedDelay',
  'downtimeCostPerHour',
  'inventoryLossWithinDeadline',
  'inventoryLossPastDeadline',
  'inventoryValue',
  'repeatFailureProbability',
  'repeatFailureCost',
];

describe('T-035 missing economic input produces hold', () => {
  it.each(MANDATORY)('missing %s: incomplete, no total and no zero substitute', (field) => {
    const r = computeCostToRecovery(v1Inputs({ [field]: null }), ctx);
    expect(r.complete).toBe(false);
    expect(r.expectedCostMinor).toBeNull();
    expect(r.range).toBeNull();
    expect(r.issues).toEqual([{ field, reason: 'MISSING' }]);
  });

  it('invalid inputs are named, never coerced', () => {
    const bad: [Partial<CostInputs>, string, string][] = [
      [{ purchaseOrService: usd(-1n, 'CANDIDATE_ACTION', 'cand_x') }, 'purchaseOrService', 'INVALID'],
      [
        {
          purchaseOrService: { amountMinor: 1.5 as never, currency: 'USD', provenance: prov('CANDIDATE_ACTION', 'c') },
        },
        'purchaseOrService',
        'INVALID',
      ],
      [
        { inventoryValue: { amountMinor: 100n, currency: 'EUR', provenance: prov('REGISTRY_FOOD_AT_RISK', 'r') } },
        'inventoryValue',
        'CURRENCY_MISMATCH',
      ],
      [{ expectedDelay: { ms: -5, provenance: prov('PROVIDER_QUOTE', 'q') } }, 'expectedDelay', 'INVALID'],
      [{ expectedDelay: { ms: 0.5, provenance: prov('PROVIDER_QUOTE', 'q') } }, 'expectedDelay', 'INVALID'],
      [
        { expectedDelay: { ms: 400 * 86_400_000, provenance: prov('PROVIDER_QUOTE', 'q') } },
        'expectedDelay',
        'OUT_OF_BOUNDS',
      ],
      [{ repeatFailureProbability: ppmOf(1_000_001, 't') }, 'repeatFailureProbability', 'OUT_OF_BOUNDS'],
      [{ repeatFailureProbability: ppmOf(10, 't', 20, 30) }, 'repeatFailureProbability', 'INVALID'],
      [{ inventoryLossWithinDeadline: ppmOf(Number.NaN, 't') }, 'inventoryLossWithinDeadline', 'INVALID'],
      [
        {
          purchaseOrService: {
            amountMinor: 10n,
            currency: 'USD',
            provenance: { source: 'CANDIDATE_ACTION', ref: '', revision: 1, asOf: 'yesterday' },
          },
        },
        'purchaseOrService',
        'INVALID',
      ],
    ];
    for (const [over, field, reason] of bad) {
      const r = computeCostToRecovery(v1Inputs(over), ctx);
      expect(r.complete, field).toBe(false);
      expect(r.expectedCostMinor, field).toBeNull();
      expect(
        r.issues.map((i) => [i.field, i.reason]),
        field,
      ).toContainEqual([field, reason]);
    }
  });

  it('the plan is INCOMPLETE (held, no winner) when any eligible candidate lacks an input', () => {
    const r = evaluateRecoveryPlan(
      planInput([
        candidate('cand_complete-01', 18_500n, 25),
        candidate('cand_noeta-0002', 9_000n, 0, { expectedDelay: null }),
      ]),
    );
    expect(r.outcome).toBe('INCOMPLETE');
    expect(r.incomplete).toBe(true);
    expect(r.holdReasons).toEqual(['ECONOMIC_INPUT_INCOMPLETE']);
    expect(r.ranking).toBeNull();
    expect(r.candidates.every((c) => c.ordinal === null)).toBe(true);
    const complete = r.candidates.find((c) => c.candidateId === 'cand_complete-01')!;
    expect(complete.disposition).toBe('ELIGIBLE_UNRANKED');
    const missing = r.candidates.find((c) => c.candidateId === 'cand_noeta-0002')!;
    expect(missing).toMatchObject({ disposition: 'INCOMPLETE', ordinal: null });
    expect(missing.cost!.expectedCostMinor).toBeNull();
    expect(missing.cost!.issues).toEqual([{ field: 'expectedDelay', reason: 'MISSING' }]);
  });

  it('tenant-level economics missing holds every eligible candidate', () => {
    const r = evaluateRecoveryPlan(planInput([candidate('cand_complete-01', 18_500n, 25)], { economics: null }));
    expect(r.outcome).toBe('INCOMPLETE');
    expect(r.candidates[0]!.cost!.issues.map((i) => i.field).sort()).toEqual(
      ['downtimeCostPerHour', 'inventoryLossPastDeadline', 'inventoryLossWithinDeadline', 'repeatFailureCost'].sort(),
    );
    const noInventory = evaluateRecoveryPlan(
      planInput([candidate('cand_complete-01', 18_500n, 25)], { inventoryValue: null }),
    );
    expect(noInventory.outcome).toBe('INCOMPLETE');
  });

  it('assembly issues (e.g. a quote that does not match the candidate) hold the candidate', () => {
    const r = evaluateRecoveryPlan(
      planInput([
        candidate('cand_complete-01', 18_500n, 25, {
          issues: [{ field: 'purchaseOrService', reason: 'MISMATCH', detail: 'QUOTE_AMOUNT_MISMATCH' }],
        }),
      ]),
    );
    expect(r.outcome).toBe('INCOMPLETE');
    expect(r.candidates[0]).toMatchObject({ disposition: 'INCOMPLETE', ordinal: null });
    expect(r.candidates[0]!.cost!.expectedCostMinor).toBeNull();
    expect(r.candidates[0]!.reasonCodes).toContain('QUOTE_AMOUNT_MISMATCH');
  });

  it('a missing provider score is an input gap, not a default', () => {
    const r = evaluateRecoveryPlan(planInput([candidate('cand_complete-01', 18_500n, 25, { providerScore: null })]));
    expect(r.outcome).toBe('INCOMPLETE');
    expect(r.candidates[0]!.reasonCodes).toContain('PROVIDER_SCORE_MISSING');
  });

  it('HOLD/REJECT/not-executable candidates are shown with reasons and never ranked or priced', () => {
    const r = evaluateRecoveryPlan(
      planInput([
        candidate('cand_allow-00001', 30_000n, 20),
        candidate('cand_hold-000001', 1_000n, 5, {
          eligibility: { status: 'POLICY_HOLD', reasonCodes: ['SUBSTITUTE_REQUIRES_NAMED_APPROVAL'] },
        }),
        candidate('cand_reject-0001', 500n, 5, {
          eligibility: { status: 'POLICY_REJECT', reasonCodes: ['PROHIBITED'] },
        }),
        candidate('cand_stale-00001', 700n, 5, {
          eligibility: { status: 'NOT_EXECUTABLE', reasonCodes: ['STALE_PRICE_OR_STOCK'] },
        }),
        candidate('cand_nodecision1', 800n, 5, {
          eligibility: { status: 'NO_DECISION', reasonCodes: ['NO_CURRENT_DECISION'] },
        }),
      ]),
    );
    expect(r.outcome).toBe('RANKED');
    expect(r.ranking).toEqual(['cand_allow-00001']);
    const byId = Object.fromEntries(r.candidates.map((c) => [c.candidateId, c]));
    expect(byId['cand_hold-000001']).toMatchObject({
      disposition: 'HELD',
      ordinal: null,
      cost: null,
      reasonCodes: ['SUBSTITUTE_REQUIRES_NAMED_APPROVAL'],
    });
    expect(byId['cand_reject-0001']).toMatchObject({ disposition: 'REJECTED', ordinal: null, cost: null });
    expect(byId['cand_stale-00001']).toMatchObject({ disposition: 'HELD', reasonCodes: ['STALE_PRICE_OR_STOCK'] });
    expect(byId['cand_nodecision1']).toMatchObject({ disposition: 'HELD' });
  });

  it('no eligible candidate holds the plan with an explicit reason', () => {
    const r = evaluateRecoveryPlan(
      planInput([
        candidate('cand_hold-000001', 1_000n, 5, { eligibility: { status: 'POLICY_HOLD', reasonCodes: ['X_Y'] } }),
      ]),
    );
    expect(r).toMatchObject({
      outcome: 'NO_ELIGIBLE_CANDIDATE',
      ranking: null,
      holdReasons: ['NO_ELIGIBLE_CANDIDATE'],
    });
    expect(evaluateRecoveryPlan(planInput([])).outcome).toBe('NO_ELIGIBLE_CANDIDATE');
  });

  it('rejects malformed plan input (duplicate candidates, oversize lists) outright', () => {
    const c = candidate('cand_complete-01', 18_500n, 25);
    expect(() => evaluateRecoveryPlan(planInput([c, { ...c }]))).toThrow(/candidate/i);
    const many = Array.from({ length: 51 }, (_, i) => candidate(`cand_many-${String(i).padStart(5, '0')}`, 1n, 1));
    expect(() => evaluateRecoveryPlan(planInput(many))).toThrow();
  });
});
