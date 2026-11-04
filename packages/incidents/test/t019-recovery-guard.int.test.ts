// T-019 coordinator-review regressions (INV-01, INV-14, FR-04, FR-16):
// - no caller of M04's public API (worker service, admin, operator, outbox worker) can move an incident to RECOVERED;
//   only the internal recovery hook, given a PASSED evaluation for this incident from a recovery evaluator, can;
// - a REOPENED incident never presents a deadline that already passed as running: reopening after the pinned deadline
//   appends EXPIRE under the pinned procedure (original deadline unchanged), and an already-expired deadline stays so.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  advanceIncident,
  expireIncidentDeadlines,
  getIncident,
  getIncidentTimeline,
  reopenIncident,
  submitManualReport,
  type IncidentView,
} from '../src/index.js';
import * as publicApi from '../src/index.js';
import { recoverIncidentWithEvaluation } from '../src/recovery.js';
import {
  HIGH_TEMP_RULE,
  createIncidentWorld,
  fakeEvaluator,
  freshAsset,
  isoAt,
  recoverForTest,
  rejection,
  type IncidentWorld,
} from './helpers.js';

let w: IncidentWorld;
const minute = 60_000;

async function verifying(observedAgoMs = 0): Promise<IncidentView> {
  const { assetId } = await freshAsset(w);
  const r = await submitManualReport(w.db.pool, w.people.operator!.ctx, {
    idempotencyKey: w.key('open'),
    assetId,
    ruleKey: HIGH_TEMP_RULE.ruleKey,
    reasonCode: 'ALARM_PANEL_RED',
    ...(observedAgoMs ? { observedAt: isoAt(Date.now() - observedAgoMs) } : {}),
  });
  let inc = await getIncident(w.db.pool, w.admin, r.incidentId);
  for (const to of ['PLANNING', 'AWAITING_APPROVAL', 'EXECUTING', 'VERIFYING'] as const) {
    await advanceIncident(w.db.pool, w.service, inc.incidentId, {
      to,
      reasonCode: `FIXTURE_${to}`,
      guardRef: 'evr_fixture-guard-0001',
      expectedVersion: inc.version,
      idempotencyKey: w.key(to),
    });
    inc = await getIncident(w.db.pool, w.admin, inc.incidentId);
  }
  return inc;
}

describe('T-019 recovery authority and reopened deadlines', () => {
  beforeAll(async () => {
    w = await createIncidentWorld('t019rec');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('no public caller can reach RECOVERED; the recovery hook is not exported', async () => {
    const inc = await verifying();
    for (const ctx of [w.service, w.admin, w.people.operator!.ctx])
      for (const guardRef of ['rev_fixture-passed-0001', 'evr_fixture-guard-0001'])
        expect(
          await rejection(
            advanceIncident(w.db.pool, ctx, inc.incidentId, {
              to: 'RECOVERED',
              reasonCode: 'RECOVERY_PASSED',
              guardRef,
              expectedVersion: inc.version,
              idempotencyKey: w.key('adv'),
            }),
          ),
        ).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'RECOVERY_EVALUATOR_REQUIRED' });
    expect(Object.keys(publicApi)).not.toContain('recoverIncidentWithEvaluation');
    expect((await getIncident(w.db.pool, w.admin, inc.incidentId)).state).toBe('VERIFYING');
  });

  it('the internal hook needs a PASSED evaluation for this very incident, from a worker, in VERIFYING', async () => {
    const inc = await verifying();
    const input = (key: string) => ({
      recoveryEvaluationId: 'rev_fixture-passed-0001',
      reasonCode: 'RECOVERY_PASSED',
      expectedVersion: inc.version,
      idempotencyKey: w.key(key),
    });
    expect(
      await rejection(
        recoverIncidentWithEvaluation(w.db.pool, w.service, inc.incidentId, input('failed'), fakeEvaluator('FAILED')),
      ),
    ).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'RECOVERY_EVALUATION_NOT_PASSED' });
    expect(
      await rejection(
        recoverIncidentWithEvaluation(
          w.db.pool,
          w.service,
          inc.incidentId,
          input('other'),
          fakeEvaluator('PASSED', 'inc_some-other-incident-0001'),
        ),
      ),
    ).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'RECOVERY_EVALUATION_NOT_PASSED' });
    expect(
      await rejection(
        recoverIncidentWithEvaluation(w.db.pool, w.admin, inc.incidentId, input('admin'), fakeEvaluator()),
      ),
    ).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'PRINCIPAL_KIND_NOT_PERMITTED' });
    await recoverIncidentWithEvaluation(w.db.pool, w.service, inc.incidentId, input('ok'), fakeEvaluator());
    const after = await getIncident(w.db.pool, w.admin, inc.incidentId);
    expect(after.state).toBe('RECOVERED');
    const timeline = await getIncidentTimeline(w.db.pool, w.admin, inc.incidentId);
    expect(timeline.transitions.at(-1)).toMatchObject({ toState: 'RECOVERED', guardRef: 'rev_fixture-passed-0001' });
  });

  it('reopening after the pinned deadline passed surfaces it as EXPIRED, never as a running or met deadline', async () => {
    // Observed 2 h ago under a 30 min containment procedure: the original deadline is already behind us.
    const inc = await verifying(2 * 60 * minute);
    expect(Date.parse(inc.originalResponseDeadlineAt)).toBeLessThan(Date.now());
    await recoverForTest(w, inc.incidentId, inc.version);
    const recovered = await getIncident(w.db.pool, w.admin, inc.incidentId);
    expect(recovered.deadlineStatus).toBe('RUNNING');
    await reopenIncident(w.db.pool, w.people.operator!.ctx, inc.incidentId, {
      reasonCode: 'RECURRENCE',
      expectedVersion: recovered.version,
      idempotencyKey: w.key('reopen'),
    });
    const after = await getIncident(w.db.pool, w.admin, inc.incidentId);
    expect(after).toMatchObject({
      state: 'TRIAGING',
      deadlineStatus: 'EXPIRED',
      deadlineOverdue: true,
      originalResponseDeadlineAt: inc.originalResponseDeadlineAt,
      currentResponseDeadlineAt: inc.currentResponseDeadlineAt,
      procedureRevisionId: inc.procedureRevisionId,
    });
    const timeline = await getIncidentTimeline(w.db.pool, w.admin, inc.incidentId);
    expect(timeline.deadlineEvents.at(-1)).toMatchObject({
      eventType: 'EXPIRE',
      reasonCode: 'DEADLINE_PASSED_BEFORE_REOPEN',
      procedureRevisionId: inc.procedureRevisionId,
    });
  });

  it('an already-expired deadline stays expired through recovery and reopen; a future one keeps running', async () => {
    const inc = await verifying(2 * 60 * minute);
    await recoverForTest(w, inc.incidentId, inc.version);
    // The sweep expires the overdue deadline of the recovered incident (no escalation from RECOVERED).
    expect((await expireIncidentDeadlines(w.db.pool, w.service, {})).expired).toContain(inc.incidentId);
    let cur = await getIncident(w.db.pool, w.admin, inc.incidentId);
    expect(cur).toMatchObject({ state: 'RECOVERED', deadlineStatus: 'EXPIRED' });
    await reopenIncident(w.db.pool, w.people.operator!.ctx, inc.incidentId, {
      reasonCode: 'RECURRENCE',
      expectedVersion: cur.version,
      idempotencyKey: w.key('reopen-expired'),
    });
    cur = await getIncident(w.db.pool, w.admin, inc.incidentId);
    expect(cur).toMatchObject({ state: 'TRIAGING', deadlineStatus: 'EXPIRED', deadlineOverdue: true });
    const events = (await getIncidentTimeline(w.db.pool, w.admin, inc.incidentId)).deadlineEvents;
    expect(events.map((e) => e.eventType)).toEqual(['SET', 'EXPIRE']);

    const fresh = await verifying();
    await recoverForTest(w, fresh.incidentId, fresh.version);
    const rec = await getIncident(w.db.pool, w.admin, fresh.incidentId);
    await reopenIncident(w.db.pool, w.people.operator!.ctx, fresh.incidentId, {
      reasonCode: 'RECURRENCE',
      expectedVersion: rec.version,
      idempotencyKey: w.key('reopen-fresh'),
    });
    expect(await getIncident(w.db.pool, w.admin, fresh.incidentId)).toMatchObject({
      deadlineStatus: 'RUNNING',
      deadlineOverdue: false,
    });
  });
});
