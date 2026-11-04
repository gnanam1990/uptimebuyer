// T-033 — Cost-to-recovery formula correctness (FR-09, M08). Golden vectors for
//   expected_cost = purchase_or_service_minor
//                 + expected_delay_ms * downtime_cost_minor_per_hour / 3_600_000
//                 + versioned_tenant_risk_ppm * inventory_value_minor / 1_000_000
//                 + repeat_failure_probability_ppm * repeat_failure_cost_minor / 1_000_000
// computed with exact rational intermediates and rounded half-up once; every component, unit, provenance and
// uncertainty is exposed, and a missing mandatory input holds instead of pricing.
import { describe, expect, it } from 'vitest';
import { INT64_MAX } from '@uptimebuyer/contracts';
import { COST_DENOMINATOR, PLANNING_RULE_VERSION, computeCostToRecovery } from '../src/index.js';
import { EVALUATED_AT, MINUTE, deadlineAt, ppmOf, prng, prov, usd, v1Inputs, zeroInputs } from './planning-fixtures.js';

const ctx = (deadline = '2026-11-05T10:30:00.000Z') => ({ evaluatedAt: EVALUATED_AT, deadline: deadlineAt(deadline) });
const component = (r: ReturnType<typeof computeCostToRecovery>, key: string) =>
  r.components.find((c) => c.key === key)!;

describe('T-033 cost-to-recovery formula correctness', () => {
  it('golden vector V1: every component, unit and the single rounded total', () => {
    const r = computeCostToRecovery(v1Inputs(), ctx());
    expect(r.complete).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.currency).toBe('USD');
    expect(r.ruleVersion).toBe(PLANNING_RULE_VERSION);
    expect(r.expectedCostMinor).toBe(46_800n);
    expect(r.exactTotal).toEqual({ num: 46_800n, den: 1n });
    expect(r.components.map((c) => c.key)).toEqual([
      'PURCHASE_OR_SERVICE',
      'DELAY_DOWNTIME',
      'INVENTORY_RISK',
      'REPEAT_FAILURE',
    ]);
    expect(component(r, 'PURCHASE_OR_SERVICE')).toMatchObject({
      exact: { num: 18_500n, den: 1n },
      unit: 'MINOR_UNITS',
    });
    expect(component(r, 'DELAY_DOWNTIME')).toMatchObject({ exact: { num: 2_500n, den: 1n }, unit: 'MINOR_UNITS' });
    expect(component(r, 'INVENTORY_RISK')).toMatchObject({ exact: { num: 25_000n, den: 1n }, unit: 'MINOR_UNITS' });
    expect(component(r, 'REPEAT_FAILURE')).toMatchObject({ exact: { num: 800n, den: 1n }, unit: 'MINOR_UNITS' });
    for (const c of r.components) expect(c.formula.length).toBeGreaterThan(0);
    expect(r.deadlineFit).toBe('WITHIN_DEADLINE');
    expect(r.recoveryEtaAt).toBe('2026-11-05T10:25:00.000Z');
  });

  it('exposes every input with unit, provenance (source, ref, revision, as_of) and uncertainty where applicable', () => {
    const r = computeCostToRecovery(v1Inputs(), ctx());
    const byField = Object.fromEntries(r.inputs.map((i) => [i.field, i]));
    expect(Object.keys(byField).sort()).toEqual(
      [
        'deadline',
        'downtimeCostPerHour',
        'expectedDelay',
        'inventoryLossPastDeadline',
        'inventoryLossWithinDeadline',
        'inventoryValue',
        'purchaseOrService',
        'repeatFailureCost',
        'repeatFailureProbability',
      ].sort(),
    );
    expect(byField.purchaseOrService).toMatchObject({
      value: '18500',
      unit: 'MINOR_UNITS',
      status: 'PRESENT',
      provenance: {
        source: 'CANDIDATE_ACTION',
        ref: 'cand_golden-0001',
        revision: 1,
        asOf: '2026-11-05T09:30:00.000Z',
      },
      uncertainty: null,
    });
    expect(byField.expectedDelay).toMatchObject({ value: String(25 * MINUTE), unit: 'MILLISECONDS' });
    expect(byField.downtimeCostPerHour).toMatchObject({ value: '6000', unit: 'MINOR_UNITS_PER_HOUR' });
    expect(byField.inventoryLossWithinDeadline).toMatchObject({
      value: '50000',
      unit: 'PPM',
      uncertainty: { low: '30000', high: '80000' },
      provenance: { source: 'TENANT_RISK_ESTIMATE' },
    });
    expect(byField.repeatFailureProbability).toMatchObject({
      unit: 'PPM',
      uncertainty: { low: '10000', high: '40000' },
    });
    expect(byField.inventoryValue).toMatchObject({ provenance: { source: 'REGISTRY_FOOD_AT_RISK' } });
    expect(byField.deadline).toMatchObject({
      value: '2026-11-05T10:30:00.000Z',
      unit: 'UTC_INSTANT',
      provenance: { source: 'INCIDENT_DEADLINE_PROJECTION' },
    });
  });

  it('reports the uncertainty range (low/high bounds) and the deadline sensitivity', () => {
    const r = computeCostToRecovery(v1Inputs(), ctx());
    // low: 18500 + 2500 + 0.03*500000 + 0.01*40000 = 36400; high: 18500 + 2500 + 40000 + 1600 = 62600
    expect(r.range).toEqual({ lowMinor: 36_400n, highMinor: 62_600n });
    // Missing the deadline would move inventory risk from 5% to 60% of $5,000.
    expect(r.deadlinePenaltyMinor).toBe(275_000n);
  });

  it('a tiny per-millisecond downtime rate never truncates to zero (exact rational, not a per-ms rate)', () => {
    // 1 minor unit per hour for 2,000,000 ms = 0.5555... -> 1. A precomputed per-ms rate (1/3.6e6) would be 0.
    const r = computeCostToRecovery(
      zeroInputs({
        expectedDelay: { ms: 2_000_000, provenance: prov('PROVIDER_QUOTE', 'pqt_tiny') },
        downtimeCostPerHour: usd(1n, 'TENANT_RISK_ESTIMATE', 'tre_golden-0001'),
      }),
      ctx(),
    );
    expect(component(r, 'DELAY_DOWNTIME').exact).toEqual({ num: 5n, den: 9n });
    expect(r.expectedCostMinor).toBe(1n);
  });

  it('rounds half-up exactly once on the final sum, never per component', () => {
    // 100 + 0.4 + 0.4 + 0.4 = 101.2 -> 101; rounding each component first would give 100.
    const r = computeCostToRecovery(
      zeroInputs({
        purchaseOrService: usd(100n, 'CANDIDATE_ACTION', 'cand_round'),
        expectedDelay: { ms: 1_440_000, provenance: prov('PROVIDER_QUOTE', 'pqt_round') },
        downtimeCostPerHour: usd(1n, 'TENANT_RISK_ESTIMATE', 'tre_golden-0001'),
        inventoryLossWithinDeadline: ppmOf(4, 'tre_golden-0001'),
        inventoryValue: usd(100_000n, 'REGISTRY_FOOD_AT_RISK', 'rrv_golden-0001'),
        repeatFailureProbability: ppmOf(4, 'tre_golden-0001'),
        repeatFailureCost: usd(100_000n, 'TENANT_RISK_ESTIMATE', 'tre_golden-0001'),
      }),
      ctx(),
    );
    expect(r.exactTotal).toEqual({ num: 506n, den: 5n });
    expect(r.components.map((c) => c.displayMinor)).toEqual([100n, 0n, 0n, 0n]);
    expect(r.expectedCostMinor).toBe(101n);
  });

  it('ties round half-up (away from zero), not to even', () => {
    const half = (rate: bigint) =>
      computeCostToRecovery(
        zeroInputs({
          expectedDelay: { ms: 1_800_000, provenance: prov('PROVIDER_QUOTE', 'pqt_half') },
          downtimeCostPerHour: usd(rate, 'TENANT_RISK_ESTIMATE', 'tre_golden-0001'),
        }),
        ctx(),
      ).expectedCostMinor;
    expect(half(1n)).toBe(1n); // 0.5 -> 1
    expect(half(5n)).toBe(3n); // 2.5 -> 3 (half-even would give 2)
    expect(half(3n)).toBe(2n); // 1.5 -> 2
  });

  it('a missed deadline prices inventory risk with the past-deadline estimate', () => {
    const r = computeCostToRecovery(v1Inputs(), ctx('2026-11-05T10:20:00.000Z'));
    expect(r.deadlineFit).toBe('MISSES_DEADLINE');
    expect(component(r, 'INVENTORY_RISK').exact).toEqual({ num: 300_000n, den: 1n });
    expect(r.expectedCostMinor).toBe(321_800n);
    const expired = computeCostToRecovery(v1Inputs(), {
      evaluatedAt: EVALUATED_AT,
      deadline: deadlineAt('2026-11-05T09:50:00.000Z', { status: 'EXPIRED' }),
    });
    expect(expired.deadlineFit).toBe('DEADLINE_PASSED');
    expect(expired.expectedCostMinor).toBe(321_800n);
  });

  it('matches an independent exact evaluation on random vectors (property)', () => {
    const rand = prng(33);
    for (let i = 0; i < 500; i++) {
      const p = BigInt(rand.int(0, 10_000_000));
      const delay = rand.int(0, 7 * 86_400_000);
      const rate = BigInt(rand.int(0, 5_000_000));
      const risk = rand.int(0, 1_000_000);
      const inv = BigInt(rand.int(0, 100_000_000));
      const rep = rand.int(0, 1_000_000);
      const repCost = BigInt(rand.int(0, 10_000_000));
      const r = computeCostToRecovery(
        zeroInputs({
          purchaseOrService: usd(p, 'CANDIDATE_ACTION', 'cand_prop'),
          expectedDelay: { ms: delay, provenance: prov('PROVIDER_QUOTE', 'pqt_prop') },
          downtimeCostPerHour: usd(rate, 'TENANT_RISK_ESTIMATE', 'tre_golden-0001'),
          inventoryLossWithinDeadline: ppmOf(risk, 'tre_golden-0001'),
          inventoryLossPastDeadline: ppmOf(risk, 'tre_golden-0001'),
          inventoryValue: usd(inv, 'REGISTRY_FOOD_AT_RISK', 'rrv_golden-0001'),
          repeatFailureProbability: ppmOf(rep, 'tre_golden-0001'),
          repeatFailureCost: usd(repCost, 'TENANT_RISK_ESTIMATE', 'tre_golden-0001'),
        }),
        ctx(),
      );
      const num =
        p * COST_DENOMINATOR +
        BigInt(delay) * rate * 1_000_000n +
        BigInt(risk) * inv * 3_600_000n +
        BigInt(rep) * repCost * 3_600_000n;
      const q = num / COST_DENOMINATOR;
      const rem = num - q * COST_DENOMINATOR;
      const expected = 2n * rem >= COST_DENOMINATOR ? q + 1n : q;
      expect(r.expectedCostMinor, `vector ${i}`).toBe(expected);
    }
  });

  it('stays exact at the int64 edge and holds (never wraps) when the result is not representable', () => {
    const edge = computeCostToRecovery(
      zeroInputs({ purchaseOrService: usd(INT64_MAX - 10n, 'CANDIDATE_ACTION', 'cand_edge') }),
      ctx(),
    );
    expect(edge.expectedCostMinor).toBe(INT64_MAX - 10n);
    const over = computeCostToRecovery(
      zeroInputs({
        purchaseOrService: usd(INT64_MAX, 'CANDIDATE_ACTION', 'cand_edge'),
        repeatFailureProbability: ppmOf(1_000_000, 'tre_golden-0001'),
        repeatFailureCost: usd(1n, 'TENANT_RISK_ESTIMATE', 'tre_golden-0001'),
      }),
      ctx(),
    );
    expect(over.complete).toBe(false);
    expect(over.expectedCostMinor).toBeNull();
    expect(over.issues).toContainEqual(expect.objectContaining({ field: 'expectedCost', reason: 'OUT_OF_BOUNDS' }));
  });

  it('a missing mandatory input holds: no total, no zero, the gap is named', () => {
    const r = computeCostToRecovery(v1Inputs({ inventoryValue: null }), ctx());
    expect(r.complete).toBe(false);
    expect(r.expectedCostMinor).toBeNull();
    expect(r.exactTotal).toBeNull();
    expect(r.components).toEqual([]);
    expect(r.issues).toEqual([{ field: 'inventoryValue', reason: 'MISSING' }]);
    expect(r.inputs.find((i) => i.field === 'inventoryValue')).toMatchObject({ status: 'MISSING', value: null });
  });
});
