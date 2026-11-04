// T-034 — Configured containment deadline changes priority (pure layer). Planning prices inventory risk against the
// incident's projected deadline only (`current_response_deadline_at`); a deadline change re-ranks exactly when the
// cost of missing it (expected delay cost) exceeds the price difference, and inventory/delay changes move priority
// in the expected direction. The DB layer (SOP publication vs authorized deadline events) is in packages/planning.
import { describe, expect, it } from 'vitest';
import { evaluateRecoveryPlan } from '../src/index.js';
import { candidate, deadlineAt, economics, planInput, ppmOf, prng, usd } from './planning-fixtures.js';

const CHEAP_SLOW = 'cand_cheap-slow';
const FAST = 'cand_pricey-fast';

describe('T-034 configured containment deadline changes priority', () => {
  it('a later projected deadline keeps the cheap slow repair first; a shortened one moves the fast repair ahead', () => {
    const cands = [candidate(CHEAP_SLOW, 18_500n, 25), candidate(FAST, 24_000n, 10)];
    const relaxed = evaluateRecoveryPlan(planInput(cands, { deadline: deadlineAt('2026-11-05T10:30:00.000Z') }));
    expect(relaxed.outcome).toBe('RANKED');
    expect(relaxed.ranking).toEqual([CHEAP_SLOW, FAST]);
    const shortened = evaluateRecoveryPlan(
      planInput(cands, { deadline: deadlineAt('2026-11-05T10:15:00.000Z', { eventSequence: 2 }) }),
    );
    expect(shortened.ranking).toEqual([FAST, CHEAP_SLOW]);
    const slow = shortened.candidates.find((c) => c.candidateId === CHEAP_SLOW)!;
    expect(slow.cost?.deadlineFit).toBe('MISSES_DEADLINE');
    expect(shortened.planHash).not.toBe(relaxed.planHash);
  });

  it('re-ranks only when the missed-deadline cost exceeds the price difference (property)', () => {
    const rand = prng(34);
    for (let i = 0; i < 300; i++) {
      const fastPrice = BigInt(rand.int(10_000, 200_000));
      const slowPrice = BigInt(rand.int(1_000, Number(fastPrice) - 1));
      const inventory = BigInt(rand.int(0, 2_000_000));
      const within = rand.int(0, 100_000);
      const past = rand.int(within, 1_000_000);
      const econ = economics({
        downtimeCostPerHour: usd(0n, 'TENANT_RISK_ESTIMATE', 'tre_golden-0001'),
        inventoryLossWithinDeadline: ppmOf(within, 'tre_golden-0001'),
        inventoryLossPastDeadline: ppmOf(past, 'tre_golden-0001'),
      });
      const cands = [
        candidate(CHEAP_SLOW, slowPrice, 25, { repeatFailureProbability: ppmOf(0, 'tre_golden-0001') }),
        candidate(FAST, fastPrice, 10, { repeatFailureProbability: ppmOf(0, 'tre_golden-0001') }),
      ];
      const inv = usd(inventory, 'REGISTRY_FOOD_AT_RISK', 'rrv_golden-0001');
      const before = evaluateRecoveryPlan(
        planInput(cands, { economics: econ, inventoryValue: inv, deadline: deadlineAt('2026-11-05T10:30:00.000Z') }),
      );
      expect(before.ranking![0], `vector ${i} before`).toBe(CHEAP_SLOW);
      const after = evaluateRecoveryPlan(
        planInput(cands, {
          economics: econ,
          inventoryValue: inv,
          deadline: deadlineAt('2026-11-05T10:15:00.000Z', { eventSequence: 2 }),
        }),
      );
      // Missing the deadline costs (past - within) * inventory / 1e6; the fast repair overtakes exactly when that
      // exceeds the price difference (compared after the single half-up rounding; an exact tie falls to the
      // shorter recovery ETA, i.e. the fast repair).
      const half = (num: bigint) => (2n * num + 1_000_000n) / 2_000_000n;
      const slowTotal = half(slowPrice * 1_000_000n + BigInt(past) * inventory);
      const fastTotal = half(fastPrice * 1_000_000n + BigInt(within) * inventory);
      const expectedFirst = slowTotal >= fastTotal ? FAST : CHEAP_SLOW;
      expect(after.ranking![0], `vector ${i} after`).toBe(expectedFirst);
      if (BigInt(past - within) * inventory < (fastPrice - slowPrice - 1n) * 1_000_000n)
        expect(after.ranking![0], `vector ${i}: penalty below the price gap`).toBe(CHEAP_SLOW);
    }
  });

  it('higher inventory value and longer delay never improve a candidate (monotone priority)', () => {
    const rand = prng(3401);
    for (let i = 0; i < 200; i++) {
      const price = BigInt(rand.int(1_000, 100_000));
      const eta = rand.int(1, 120);
      const base = candidate('cand_probe-0001', price, eta);
      const inv = BigInt(rand.int(0, 1_000_000));
      const run = (c: typeof base, inventory: bigint) =>
        evaluateRecoveryPlan(planInput([c], { inventoryValue: usd(inventory, 'REGISTRY_FOOD_AT_RISK', 'rrv_x') }))
          .candidates[0]!.cost!.expectedCostMinor!;
      const c0 = run(base, inv);
      expect(run(base, inv + BigInt(rand.int(0, 1_000_000)))).toBeGreaterThanOrEqual(c0);
      expect(run(candidate('cand_probe-0001', price, eta + rand.int(0, 120)), inv)).toBeGreaterThanOrEqual(c0);
    }
  });

  it('the deadline is a mandatory input: without the projection the plan holds instead of guessing', () => {
    const r = evaluateRecoveryPlan(planInput([candidate(CHEAP_SLOW, 18_500n, 25)], { deadline: null }));
    expect(r.outcome).toBe('INCOMPLETE');
    expect(r.ranking).toBeNull();
    expect(r.candidates[0]!.cost!.issues).toContainEqual({ field: 'deadline', reason: 'MISSING' });
  });
});
