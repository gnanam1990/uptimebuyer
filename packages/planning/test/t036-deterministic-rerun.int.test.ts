// T-036 — Deterministic ranking tie break (persisted). Candidates whose expected cost, recovery ETA and provider score
// tie exactly are ordered by candidate ID (UTF-16 code units); rebuilding from any input order, from a fresh
// connection pool, returns the same immutable plan revision, ordinals and plan hash.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRecoveryPlan, getRecoveryPlan } from '../src/index.js';
import { createPlanningWorld, scenario, type PlanningWorld, type Scenario } from './helpers.js';

let w: PlanningWorld;
let s: Scenario;

describe('T-036 deterministic ranking tie break (persisted)', () => {
  beforeAll(async () => {
    w = await createPlanningWorld('t036');
    s = await scenario(w, [
      { label: 'tie-1', priceMinor: 18_500n, etaMinutes: 25 },
      { label: 'tie-2', priceMinor: 18_500n, etaMinutes: 25 },
      { label: 'tie-3', priceMinor: 18_500n, etaMinutes: 25 },
      { label: 'limited', priceMinor: 18_500n, etaMinutes: 25, availability: 'LIMITED' },
      { label: 'faster-same-cost', priceMinor: 20_000n, etaMinutes: 10 },
    ]);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('orders exact ties by ETA, provider score, then candidate ID, and reruns reproduce the same revision', async () => {
    const plan = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: s.refs },
      w.signing,
    );
    expect(plan.outcome).toBe('RANKED');
    const ranked = plan.actions.filter((a) => a.ordinal !== null).sort((a, b) => a.ordinal! - b.ordinal!);
    expect(new Set(ranked.map((a) => String(a.expectedCostMinor)))).toEqual(new Set(['46800']));
    const ties = s.pairs
      .filter((p) => p.label.startsWith('tie-'))
      .map((p) => p.candidateActionId)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(ranked.map((a) => a.candidateActionId)).toEqual([
      s.byLabel['faster-same-cost']!.candidateActionId,
      ...ties,
      s.byLabel['limited']!.candidateActionId,
    ]);
    for (let i = 0; i < 4; i++) {
      const order = [...s.refs].reverse().sort(() => (i % 2 === 0 ? 1 : -1));
      const again = await createRecoveryPlan(
        w.db.pool,
        w.service,
        { incidentId: s.incidentId, candidates: order },
        w.signing,
      );
      expect(again).toMatchObject({ created: false, planId: plan.planId, planHash: plan.planHash });
    }
    // A separate connection pool (fresh sessions, different client settings) reads back the identical ordering.
    const other = new pg.Pool({ connectionString: w.db.url, max: 2, options: '-c TimeZone=Pacific/Chatham' });
    try {
      const view = await getRecoveryPlan(other, w.people.viewer!.ctx, plan.planId);
      expect(view.actions.map((a) => [a.ordinal, a.candidateActionId])).toEqual(
        plan.actions.map((a) => [a.ordinal, a.candidateActionId]),
      );
      expect(view.planHash).toBe(plan.planHash);
    } finally {
      await other.end();
    }
  });
});
