// T-048 — Repeat fault reopens a closed incident (FR-16, FR-17, INV-01, INV-10). A qualifying repeat fault inside the
// pinned watch window, a lost recovery signal, or disputed recovery evidence after closeout reopens the incident through
// M04 (RECOVERED -> REOPENED -> TRIAGING) and links the reopen to the closeout without deleting or rewriting it: the
// PASSED evaluation, its pinned samples/signoffs and the closeout manifest stay byte-identical, a REOPEN update is
// queued for the CMMS, and the recovery metrics stop counting the closeout as a stable recovery. Disputed evidence
// before closeout fails the open evaluation and escalates instead.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateIncidentRules, getIncident } from '@uptimebuyer/incidents';
import {
  disputeRecoveryEvidence,
  getRecoveryGate,
  handleIncidentReopenedEvent,
  monitorRecoveredIncidents,
  recoveryMetrics,
} from '@uptimebuyer/recovery';
import { deliver } from '../../../packages/planning/test/helpers.js';
import {
  assess,
  createRecoveryWorld,
  dbNowMs,
  iso,
  milestoneAt,
  readings,
  recoveredIncident,
  steady,
  transitionPath,
  verifyingIncident,
  type RecoveryWorld,
} from './m11-helpers.js';

let w: RecoveryWorld;
beforeAll(async () => {
  w = await createRecoveryWorld('t048');
});
afterAll(async () => w?.close());

const t = () => w.tenant.tenantId;
async function snapshot(closeoutId: string) {
  const c = (
    await w.db.pool.query(`SELECT * FROM recovery_closeouts WHERE tenant_id = $1 AND id = $2`, [t(), closeoutId])
  ).rows[0];
  const ev = (
    await w.db.pool.query(`SELECT * FROM recovery_evaluations WHERE tenant_id = $1 AND id = $2`, [t(), c.evaluation_id])
  ).rows[0];
  const samples = (
    await w.db.pool.query(
      `SELECT sample_id FROM recovery_evaluation_samples WHERE tenant_id = $1 AND evaluation_id = $2 ORDER BY ordinal`,
      [t(), c.evaluation_id],
    )
  ).rows.map((r) => r.sample_id);
  const { reopened_at, reopen_reason_code, reopen_ref, ...immutable } = c;
  void reopened_at;
  void reopen_reason_code;
  void reopen_ref;
  return { closeout: c, immutable, evaluation: ev, samples };
}

async function reopenUpdates(incidentId: string) {
  return (
    await w.db.pool.query(
      `SELECT update_kind, payload FROM cmms_work_order_updates WHERE tenant_id = $1 AND incident_id = $2 AND update_kind = 'REOPEN'`,
      [t(), incidentId],
    )
  ).rows;
}

describe('T-048 repeat fault reopens a closed incident', () => {
  it('a qualifying repeat fault inside the watch window reopens and links without rewriting the closeout', async () => {
    const { inc, m, r } = await recoveredIncident(w);
    const before = await snapshot(r.closeoutId!);
    const m0 = await recoveryMetrics(w.db.pool, w.admin, { siteId: w.siteId });
    // Breach again: 13 readings at 9 C over two minutes, after the closeout window.
    const breach = steady(m.boundaryMs + 70_000, m.boundaryMs + 190_000, { value: 9_000 });
    await readings(w, inc.device, breach);
    const ev = await evaluateIncidentRules(w.db.pool, w.service, {
      assetId: inc.assetId,
      at: iso(m.boundaryMs + 190_000),
    });
    expect(ev.evaluations.some((e) => e.outcome === 'REOPENED')).toBe(true);
    expect((await transitionPath(w, inc.incidentId)).slice(-3)).toEqual([
      'VERIFYING>RECOVERED',
      'RECOVERED>REOPENED',
      'REOPENED>TRIAGING',
    ]);
    await deliver(w, 'incident.reopened.v1', handleIncidentReopenedEvent);
    const replay = await deliver(w, 'incident.reopened.v1', handleIncidentReopenedEvent);
    expect(replay.every((x) => x === 'DUPLICATE')).toBe(true);
    const after = await snapshot(r.closeoutId!);
    expect(after.immutable).toEqual(before.immutable);
    expect(after.evaluation).toEqual(before.evaluation);
    expect(after.samples).toEqual(before.samples);
    expect(after.closeout).toMatchObject({ reopen_reason_code: 'RECURRENCE_IN_WATCH_WINDOW' });
    expect(after.closeout.reopened_at).toBeInstanceOf(Date);
    expect(after.closeout.reopen_ref).toMatch(/^evt_/);
    expect(await reopenUpdates(inc.incidentId)).toHaveLength(1);
    // Metrics: the closeout no longer counts as a stable (or pending) recovery.
    const m1 = await recoveryMetrics(w.db.pool, w.admin, { siteId: w.siteId });
    expect(m1.reopened).toBe(m0.reopened + 1);
    expect(m1.stable + m1.pendingWatch).toBe(m0.stable + m0.pendingWatch - 1);
    expect(m1.closeouts).toBe(m0.closeouts);
    const gate = await getRecoveryGate(w.db.pool, w.viewerCtx, inc.incidentId);
    expect(gate).toMatchObject({ recovered: false, releasesCompletionValue: false });
    expect(gate.reasons).toContain('CLOSEOUT_REOPENED');
    // History cannot be deleted or rewritten.
    await expect(
      w.db.admin(`DELETE FROM recovery_closeouts WHERE tenant_id = $1 AND id = $2`, [t(), r.closeoutId]),
    ).rejects.toMatchObject({
      code: 'UB001',
    });
    await expect(
      w.db.admin(`UPDATE recovery_closeouts SET reopen_reason_code = 'OTHER' WHERE tenant_id = $1 AND id = $2`, [
        t(),
        r.closeoutId,
      ]),
    ).rejects.toMatchObject({ code: 'UB001' });
    await expect(
      w.db.admin(`UPDATE recovery_evaluations SET state = 'FAILED' WHERE tenant_id = $1 AND id = $2`, [
        t(),
        r.recoveryEvaluationId,
      ]),
    ).rejects.toMatchObject({ code: 'UB201' });
    // A second closeout for the same incident and recovery cycle is impossible.
    await expect(
      w.db.admin(
        `INSERT INTO recovery_closeouts (tenant_id, id, incident_id, site_id, evaluation_id, recovery_cycle, plan_id,
           action_digest, milestone_id, manifest, manifest_digest, decision_signature, signature_key_id, decided_at)
         SELECT tenant_id, 'rco_forged-second-0001', incident_id, site_id, evaluation_id, recovery_cycle, plan_id,
           action_digest, milestone_id, manifest, manifest_digest, decision_signature, signature_key_id, decided_at
           FROM recovery_closeouts WHERE tenant_id = $1 AND id = $2`,
        [t(), r.closeoutId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('a lost recovery signal inside the watch window reopens the incident', async () => {
    const { inc, m, r } = await recoveredIncident(w);
    const last = m.boundaryMs + 61_000;
    expect(
      (await monitorRecoveredIncidents(w.db.pool, w.service, { asOf: iso(last + 10_000) })).reopened,
    ).not.toContain(inc.incidentId);
    expect((await getIncident(w.db.pool, w.viewerCtx, inc.incidentId)).state).toBe('RECOVERED');
    const out = await monitorRecoveredIncidents(w.db.pool, w.service, { asOf: iso(last + 31_000) });
    expect(out.reopened).toContain(inc.incidentId);
    expect((await transitionPath(w, inc.incidentId)).slice(-2)).toEqual(['RECOVERED>REOPENED', 'REOPENED>TRIAGING']);
    const c = await snapshot(r.closeoutId!);
    expect(c.closeout.reopen_reason_code).toBe('RECOVERY_SIGNAL_LOST');
    expect(c.evaluation.state).toBe('PASSED');
    // Idempotent: a second sweep does nothing more.
    const again = await monitorRecoveredIncidents(w.db.pool, w.service, { asOf: iso(last + 32_000) });
    expect(again.reopened).not.toContain(inc.incidentId);
    expect(await reopenUpdates(inc.incidentId)).toHaveLength(1);
    // Only the engine may sweep.
    await expect(monitorRecoveredIncidents(w.db.pool, w.operator, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('disputed recovery evidence after closeout reopens; before closeout it fails the evaluation and escalates', async () => {
    const { inc, m, r } = await recoveredIncident(w);
    const d = await disputeRecoveryEvidence(w.db.pool, w.operator, {
      evidenceId: m.evidenceId,
      reasonCode: 'SIGNOFF_FORGED_BY_CONTRACTOR',
      idempotencyKey: w.key('dispute'),
    });
    expect(d.incidentEffect).toBe('REOPENED');
    expect((await getIncident(w.db.pool, w.viewerCtx, inc.incidentId)).state).toBe('TRIAGING');
    const c = await snapshot(r.closeoutId!);
    expect(c.closeout.reopen_reason_code).toBe('RECOVERY_EVIDENCE_DISPUTED');
    expect(c.closeout.reopen_ref).toBe(d.disputeId);
    expect(c.evaluation.state).toBe('PASSED');

    const v = await verifyingIncident(w);
    const mv = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    await readings(w, v.device, steady(mv.boundaryMs + 1_000, mv.boundaryMs + 31_000));
    const open = await assess(w, v, mv.boundaryMs + 31_500);
    expect(open.outcome).toBe('OBSERVING');
    const d2 = await disputeRecoveryEvidence(w.db.pool, w.operator, {
      evidenceId: mv.evidenceId,
      reasonCode: 'WRONG_UNIT_SERVICED',
      idempotencyKey: w.key('dispute'),
    });
    expect(d2.incidentEffect).toBe('ESCALATED');
    const ev = (
      await w.db.pool.query(`SELECT state, state_reason FROM recovery_evaluations WHERE tenant_id = $1 AND id = $2`, [
        t(),
        open.recoveryEvaluationId,
      ])
    ).rows[0];
    expect(ev).toEqual({ state: 'FAILED', state_reason: 'EVIDENCE_DISPUTED' });
    expect((await transitionPath(w, v.incidentId)).slice(-1)).toEqual(['VERIFYING>ESCALATED']);
    // A duplicate dispute is the same dispute; a viewer cannot dispute.
    const dup = await disputeRecoveryEvidence(w.db.pool, w.operator, {
      evidenceId: mv.evidenceId,
      reasonCode: 'WRONG_UNIT_SERVICED',
      idempotencyKey: w.key('dispute'),
    });
    expect(dup.disputeId).toBe(d2.disputeId);
    await expect(
      disputeRecoveryEvidence(w.db.pool, w.viewerCtx, {
        evidenceId: mv.evidenceId,
        reasonCode: 'X',
        idempotencyKey: w.key('d'),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
