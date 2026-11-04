// T-034 — Configured containment deadline changes priority (persisted). For an open incident planning reads only its
// `current_response_deadline_at` projection: publishing a later SOP revision neither moves nor re-ranks it, while a
// procedure-permitted authorized append-only deadline event changes the projection, invalidates the open plan and
// re-ranks when the expected delay cost exceeds the price difference. A new incident uses the newly effective
// procedure, and an optional model estimate cannot move either deadline.
import { createHash } from 'node:crypto';
import {
  adjustIncidentDeadline,
  getIncident,
  publishOperatingProcedure,
  recordRiskEstimate,
} from '@uptimebuyer/incidents';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRecoveryPlan, getRecoveryPlan, handlePlanningEvent } from '../src/index.js';
import { COLD_CHAIN_PROCEDURE } from '../../incidents/test/helpers.js';
import {
  createPlanningWorld,
  labelsInOrder,
  outboxEvents,
  scenario,
  type PlanningWorld,
  type Scenario,
} from './helpers.js';

let w: PlanningWorld;
let s: Scenario;
let firstPlanId: string;
const OFFERS = [
  { label: 'cheap-slow', priceMinor: 18_500n, etaMinutes: 25 },
  { label: 'pricey-fast', priceMinor: 24_000n, etaMinutes: 10 },
];

describe('T-034 configured containment deadline changes priority (persisted)', () => {
  beforeAll(async () => {
    w = await createPlanningWorld('t034');
    s = await scenario(w, OFFERS);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('plans against the incident projection; a later SOP publication does not move or re-rank it', async () => {
    const incident = await getIncident(w.db.pool, w.people.operator!.ctx, s.incidentId);
    const plan = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: s.refs },
      w.signing,
    );
    firstPlanId = plan.planId;
    expect(plan.deadline).toMatchObject({
      currentResponseDeadlineAt: incident.currentResponseDeadlineAt,
      status: 'RUNNING',
      eventSequence: 1,
      procedureRevisionId: incident.procedureRevisionId,
    });
    expect(labelsInOrder(plan, s)).toEqual(['cheap-slow', 'pricey-fast']);

    const sop2 = await publishOperatingProcedure(w.db.pool, w.admin, {
      ...COLD_CHAIN_PROCEDURE,
      responseDeadlineMs: 20 * 60_000,
      initialAssigneeUserId: w.people.oncall!.userId,
    });
    expect(sop2.revision).toBe(2);
    for (const e of await outboxEvents(w, 'plan.invalidated.v1')) await handlePlanningEvent(w.db.pool, e as never);
    const again = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: s.refs },
      w.signing,
    );
    expect(again).toMatchObject({ created: false, planId: plan.planId, planHash: plan.planHash, state: 'APPROVABLE' });
    expect(again.deadline.currentResponseDeadlineAt).toBe(incident.currentResponseDeadlineAt);
    expect((await getIncident(w.db.pool, w.people.operator!.ctx, s.incidentId)).currentResponseDeadlineAt).toBe(
      incident.currentResponseDeadlineAt,
    );
  });

  it('a new incident uses the newly effective procedure and ranks against its shorter deadline', async () => {
    const s2 = await scenario(w, OFFERS);
    const inc2 = await getIncident(w.db.pool, w.people.operator!.ctx, s2.incidentId);
    const inc1 = await getIncident(w.db.pool, w.people.operator!.ctx, s.incidentId);
    expect(inc2.procedureRevisionId).not.toBe(inc1.procedureRevisionId);
    const plan = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s2.incidentId, candidates: s2.refs },
      w.signing,
    );
    expect(plan.deadline.procedureRevisionId).toBe(inc2.procedureRevisionId);
    // The 25 min repair misses a 20 min containment deadline: 60% inventory loss outweighs the $55 price gap.
    expect(labelsInOrder(plan, s2)).toEqual(['pricey-fast', 'cheap-slow']);
    const slow = plan.actions.find((a) => a.candidateActionId === s2.byLabel['cheap-slow']!.candidateActionId)!;
    expect(slow.deadlineFit).toBe('MISSES_DEADLINE');
  });

  it('an authorized SHORTEN deadline event re-ranks: the open plan is invalidated and the new revision binds it', async () => {
    const before = await getIncident(w.db.pool, w.people.operator!.ctx, s.incidentId);
    const shortened = new Date(Date.now() + 15 * 60_000).toISOString();
    await adjustIncidentDeadline(w.db.pool, w.people.operator!.ctx, s.incidentId, {
      expectedVersion: before.version,
      idempotencyKey: w.key('shorten'),
      eventType: 'SHORTEN',
      newDeadlineAt: shortened,
      reasonCode: 'CONTAINMENT_RISK_RAISED',
    });
    for (const e of await outboxEvents(w, 'incident.deadline_changed.v1'))
      await handlePlanningEvent(w.db.pool, e as never);
    const old = await getRecoveryPlan(w.db.pool, w.people.viewer!.ctx, firstPlanId);
    expect(old.state).toBe('INVALIDATED');
    expect(old.invalidatedReason).toBe('DEADLINE_CHANGED');
    const inv = (await outboxEvents(w, 'plan.invalidated.v1', s.incidentId)).filter(
      (e) => e.payload.reasonCode === 'PLAN_INPUT_STALE',
    );
    expect(inv.at(-1)?.payload).toMatchObject({ invalidatedPlanIds: [firstPlanId], staleInputs: ['DEADLINE'] });

    const plan = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: s.refs },
      w.signing,
    );
    expect(plan).toMatchObject({ created: true, revision: 2, state: 'APPROVABLE' });
    expect(plan.deadline).toMatchObject({ currentResponseDeadlineAt: shortened, eventSequence: 2 });
    expect(labelsInOrder(plan, s)).toEqual(['pricey-fast', 'cheap-slow']);
    const after = await getIncident(w.db.pool, w.people.operator!.ctx, s.incidentId);
    expect(after.originalResponseDeadlineAt).toBe(before.originalResponseDeadlineAt);
  });

  it('an optional model estimate is exposed as non-authoritative and cannot move the deadline or the ranking', async () => {
    const before = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: s.refs },
      w.signing,
    );
    await recordRiskEstimate(w.db.pool, w.service, s.incidentId, {
      estimatorKind: 'MODEL',
      sourceRevision: 'spoilage-model.v7',
      asOf: new Date().toISOString(),
      safeTimeRemainingMs: 6 * 3_600_000,
      lowerBoundMs: 3 * 3_600_000,
      upperBoundMs: 9 * 3_600_000,
      confidencePpm: 950_000,
      provenanceDigest: `sha256:${createHash('sha256').update('synthetic model run').digest('hex')}`,
    });
    const after = await createRecoveryPlan(
      w.db.pool,
      w.service,
      { incidentId: s.incidentId, candidates: s.refs },
      w.signing,
    );
    expect(after).toMatchObject({ created: false, planId: before.planId, planHash: before.planHash });
    expect(after.deadline.currentResponseDeadlineAt).toBe(before.deadline.currentResponseDeadlineAt);
    expect(labelsInOrder(after, s)).toEqual(['pricey-fast', 'cheap-slow']);
    expect(after.advisory.optionalRiskEstimates).toEqual([
      expect.objectContaining({
        estimatorKind: 'MODEL',
        safeTimeRemainingMs: 6 * 3_600_000,
        authority: 'NON_AUTHORITATIVE',
        usedInCost: false,
        canMoveDeadline: false,
      }),
    ]);
  });
});
