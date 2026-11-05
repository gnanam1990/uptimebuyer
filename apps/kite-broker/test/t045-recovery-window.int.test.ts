// T-045 — Stable sensor recovery window, end to end (FR-14, FR-15, INV-01, INV-03, INV-11). The policy-designated
// verified intervention-completion milestone (a signed CMMS signoff for the approved action) freezes
// `observation_boundary_at`; the evaluation pins the tenant, incident, asset revision, plan/action digest, evidence,
// recovery-policy and rule revisions, the milestone and the exact assignment/channel revisions. Only authenticated
// exact-revision LIVE samples with source event time strictly after the boundary, continuously in range and ending in
// a fresh tail, pass; boundary-equal, pre-work, late, backfill-plus-fresh-tail, stale, excursion, wrong-asset,
// superseded-channel and revoked-device cases do not, and the database refuses to pin a non-qualifying sample or a
// boundary other than the milestone's normalized occurred time.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviseSensorChannel, setDeviceStatus } from '@uptimebuyer/data';
import { getIncident } from '@uptimebuyer/incidents';
import { getRecoveryStatus } from '@uptimebuyer/recovery';
import { provisionDevice } from '../../sensor-gateway/test/helpers.js';
import { rejection } from './helpers.js';
import {
  assess,
  cmmsRecord,
  createRecoveryWorld,
  dbNowMs,
  incidentRow,
  milestoneAt,
  readings,
  recoveredIncident,
  sendCmms,
  steady,
  transitionPath,
  verifyingIncident,
  type RecoveryWorld,
} from './m11-helpers.js';
import { recordInterventionMilestone } from '@uptimebuyer/recovery';

let w: RecoveryWorld;
beforeAll(async () => {
  w = await createRecoveryWorld('t045');
});
afterAll(async () => w?.close());

const q = async (sql: string, params: unknown[] = []) => (await w.db.pool.query(sql, params)).rows;

describe('T-045 stable sensor recovery window (integration)', () => {
  it('a continuous LIVE window strictly after the frozen boundary closes the incident with every binding pinned', async () => {
    const { inc, m, ids, r } = await recoveredIncident(w);
    expect(r).toMatchObject({ outcome: 'PASSED', incidentState: 'RECOVERED' });
    expect(r.closeoutId).toMatch(/^rco_/);
    const ev = (
      await q(`SELECT * FROM recovery_evaluations WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        r.recoveryEvaluationId,
      ])
    )[0];
    const incident = await incidentRow(w, inc.incidentId);
    const milestone = (
      await q(`SELECT * FROM intervention_milestones WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        m.milestoneId,
      ])
    )[0];
    expect(ev).toMatchObject({
      state: 'PASSED',
      incident_id: inc.incidentId,
      asset_id: inc.assetId,
      asset_revision_id: incident.asset_revision_id,
      plan_id: inc.planId,
      plan_action_id: inc.planActionId,
      action_digest: inc.actionDigest,
      milestone_id: m.milestoneId,
      rule_revision_id: incident.rule_revision_id,
      recovery_policy_revision_id: w.recoveryPolicyRevisionId,
      recovery_cycle: 0,
    });
    expect(ev.evidence_revision_id).toMatch(/^evr_/);
    expect(ev.observation_boundary_at.getTime()).toBe(milestone.occurred_at.getTime());
    expect(ev.observation_boundary_at.getTime()).toBe(m.boundaryMs);
    // Exact assignment/channel revisions and the exact qualifying sample ids, all strictly after the boundary.
    const pins = await q(`SELECT * FROM recovery_evaluation_channels WHERE tenant_id = $1 AND evaluation_id = $2`, [
      w.tenant.tenantId,
      ev.id,
    ]);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      channel_id: inc.device.channels.temp,
      device_assignment_id: inc.device.assignmentId,
    });
    const samples = await q(
      `SELECT s.id, s.event_at, s.ingestion_class FROM recovery_evaluation_samples e
         JOIN telemetry_samples s ON s.tenant_id = e.tenant_id AND s.id = e.sample_id
        WHERE e.tenant_id = $1 AND e.evaluation_id = $2 ORDER BY s.event_at`,
      [w.tenant.tenantId, ev.id],
    );
    expect(samples.map((s) => s.id)).toEqual(ids);
    expect(samples.every((s) => s.event_at.getTime() > m.boundaryMs && s.ingestion_class === 'LIVE')).toBe(true);
    const signoffs = await q(`SELECT * FROM recovery_evaluation_signoffs WHERE tenant_id = $1 AND evaluation_id = $2`, [
      w.tenant.tenantId,
      ev.id,
    ]);
    expect(signoffs.map((s) => s.requirement).sort()).toEqual(['CMMS_WORK_ORDER', 'INSTALLED_PART']);
    expect(signoffs.every((s) => s.evidence_id === m.evidenceId)).toBe(true);
    // The RECOVERED edge names the evaluation; the closeout carries the complete manifest.
    expect((await transitionPath(w, inc.incidentId)).slice(-1)).toEqual(['VERIFYING>RECOVERED']);
    const tr = await q(
      `SELECT guard_ref FROM incident_transitions WHERE tenant_id = $1 AND incident_id = $2 AND to_state = 'RECOVERED'`,
      [w.tenant.tenantId, inc.incidentId],
    );
    expect(tr).toEqual([{ guard_ref: ev.id }]);
    const closeout = (
      await q(`SELECT * FROM recovery_closeouts WHERE tenant_id = $1 AND id = $2`, [w.tenant.tenantId, r.closeoutId])
    )[0];
    expect(closeout).toMatchObject({
      evaluation_id: ev.id,
      incident_id: inc.incidentId,
      recovery_cycle: 0,
      milestone_id: m.milestoneId,
    });
    expect(closeout.manifest).toMatchObject({
      incidentId: inc.incidentId,
      actionDigest: inc.actionDigest,
      observationBoundaryAt: new Date(m.boundaryMs).toISOString(),
      sampleIds: ids,
      signoffEvidenceIds: [m.evidenceId],
      installedPart: { manufacturer: 'Northwind Refrigeration', partNumber: '5A1-0402' },
    });
    expect(closeout.manifest_digest).toMatch(/^recovery-closeout\.v1:sha256:[0-9a-f]{64}$/);
    expect(closeout.decision_signature).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    const events = await q(
      `SELECT event_type FROM outbox_events WHERE tenant_id = $1 AND event_type IN ('recovery.assessed.v1', 'incident.recovered.v1', 'intervention.milestone_recorded.v1')
         AND (aggregate_id = $2 OR aggregate_id = $3 OR aggregate_id = $4) ORDER BY seq`,
      [w.tenant.tenantId, ev.id, inc.incidentId, m.milestoneId],
    );
    // Opening the evaluation (PENDING -> OBSERVING) and passing it (OBSERVING -> PASSED) are both assessed events.
    expect(events.map((e) => e.event_type)).toEqual([
      'intervention.milestone_recorded.v1',
      'recovery.assessed.v1',
      'recovery.assessed.v1',
      'incident.recovered.v1',
    ]);
    const ledger = await q(
      `SELECT kind, trust FROM evidence_ledger_entries WHERE tenant_id = $1 AND incident_id = $2 AND kind = 'RECOVERY_DECISION'`,
      [w.tenant.tenantId, inc.incidentId],
    );
    expect(ledger).toEqual([{ kind: 'RECOVERY_DECISION', trust: 'AUTHORITATIVE' }]);
    // Re-assessing a recovered incident changes nothing.
    const again = await assess(w, inc, m.boundaryMs + 62_000);
    expect(again).toMatchObject({ outcome: 'ALREADY_RECOVERED', closeoutId: r.closeoutId });
    expect(
      await q(`SELECT id FROM recovery_closeouts WHERE tenant_id = $1 AND incident_id = $2`, [
        w.tenant.tenantId,
        inc.incidentId,
      ]),
    ).toHaveLength(1);
  });

  it('a sample at exactly the boundary does not count; the window must be complete without it', async () => {
    const v = await verifyingIncident(w);
    const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    const ids = await readings(w, v.device, steady(m.boundaryMs, m.boundaryMs + 60_000));
    const r1 = await assess(w, v, m.boundaryMs + 60_500);
    expect(r1).toMatchObject({ outcome: 'OBSERVING', incidentState: 'VERIFYING', closeoutId: null });
    expect(r1.reasonCodes).toEqual(expect.arrayContaining(['BOUNDARY_EQUAL_SAMPLE', 'WINDOW_TOO_SHORT']));
    const more = await readings(w, v.device, [{ at: m.boundaryMs + 70_000 }]);
    const r2 = await assess(w, v, m.boundaryMs + 70_500);
    expect(r2.outcome).toBe('PASSED');
    const pinned = await q(
      `SELECT sample_id FROM recovery_evaluation_samples WHERE tenant_id = $1 AND evaluation_id = $2`,
      [w.tenant.tenantId, r2.recoveryEvaluationId],
    );
    expect(pinned.map((p) => p.sample_id).sort()).toEqual([...ids.slice(1), ...more].sort());
    expect(pinned.map((p) => p.sample_id)).not.toContain(ids[0]);
  });

  it('pre-work samples (before the milestone) never satisfy the window', async () => {
    const v = await verifyingIncident(w);
    const now = await dbNowMs(w);
    const m = await milestoneAt(w, v, now + 100_000);
    await readings(w, v.device, steady(now + 2_000, now + 92_000));
    const r = await assess(w, v, now + 92_500);
    expect(r).toMatchObject({ outcome: 'OBSERVING', incidentState: 'VERIFYING' });
    expect(r.reasonCodes).toContain('NO_POST_BOUNDARY_SAMPLE');
    expect(m.boundaryMs).toBe(now + 100_000);
  });

  it('the milestone type is policy-designated: another type starts no evaluation', async () => {
    const v = await verifyingIncident(w);
    const at = (await dbNowMs(w)) + 5_000;
    const ev = await sendCmms(w, w.cmms, cmmsRecord(v, at, { milestoneType: 'PART_RECEIVED' }));
    expect(
      await rejection(
        recordInterventionMilestone(
          w.db.pool,
          w.service,
          { incidentId: v.incidentId, evidenceId: ev.evidenceId, idempotencyKey: w.key('m') },
          w.recoverySigning,
        ),
      ),
    ).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'WRONG_MILESTONE_TYPE' });
    await readings(w, v.device, steady(at + 1_000, at + 61_000));
    const r = await assess(w, v, at + 61_500);
    expect(r).toMatchObject({ outcome: 'NOT_READY', recoveryEvaluationId: null, incidentState: 'VERIFYING' });
    expect(r.reasonCodes).toContain('MILESTONE_MISSING');
  });

  it('a LATE reading inside the window resets it', async () => {
    const v = await verifyingIncident(w);
    const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    const pts = steady(m.boundaryMs + 1_000, m.boundaryMs + 61_000);
    pts[3] = { ...pts[3]!, lagMs: 45_000 };
    await readings(w, v.device, pts);
    const r = await assess(w, v, m.boundaryMs + 61_500);
    expect(r.outcome).toBe('OBSERVING');
    expect(r.reasonCodes).toEqual(expect.arrayContaining(['NON_LIVE_SAMPLE', 'WINDOW_TOO_SHORT']));
  });

  it('backfilled readings followed by a fresh LIVE tail do not pass', async () => {
    const v = await verifyingIncident(w);
    const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    await readings(w, v.device, [
      ...steady(m.boundaryMs + 1_000, m.boundaryMs + 41_000, { delivery: 'BACKFILL' }),
      ...steady(m.boundaryMs + 51_000, m.boundaryMs + 61_000),
    ]);
    const r = await assess(w, v, m.boundaryMs + 61_500);
    expect(r.outcome).toBe('OBSERVING');
    expect(r.reasonCodes).toEqual(expect.arrayContaining(['NON_LIVE_SAMPLE', 'WINDOW_TOO_SHORT']));
  });

  it('a stale tail and an excursion both fail; a gap resets', async () => {
    const v = await verifyingIncident(w);
    const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    const pts = steady(m.boundaryMs + 1_000, m.boundaryMs + 61_000);
    await readings(w, v.device, pts);
    const stale = await assess(w, v, m.boundaryMs + 61_000 + 31_000);
    expect(stale.outcome).toBe('OBSERVING');
    expect(stale.reasonCodes).toContain('TAIL_STALE');
    // An excursion and then a gap: neither lets a later short run pass.
    await readings(w, v.device, [
      { at: m.boundaryMs + 95_000, value: 7_600 },
      { at: m.boundaryMs + 105_000 },
      { at: m.boundaryMs + 140_000 },
    ]);
    const r = await assess(w, v, m.boundaryMs + 140_500);
    expect(r.outcome).toBe('OBSERVING');
    expect(r.reasonCodes).toEqual(expect.arrayContaining(['SAFE_RANGE_EXCURSION', 'GAP_EXCEEDED']));
    expect((await getIncident(w.db.pool, w.viewerCtx, v.incidentId)).state).toBe('VERIFYING');
  });

  it('readings from another asset never count for this incident', async () => {
    const v = await verifyingIncident(w);
    const other = await verifyingIncident(w);
    const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    await readings(w, other.device, steady(m.boundaryMs + 1_000, m.boundaryMs + 61_000));
    const r = await assess(w, v, m.boundaryMs + 61_500);
    expect(r.outcome).toBe('OBSERVING');
    expect(r.reasonCodes).toContain('NO_POST_BOUNDARY_SAMPLE');
    // A second device later assigned to the asset is not a pinned channel of the open evaluation.
    const extra = await provisionDevice(w, { siteId: w.siteId, assetId: v.assetId as never });
    void extra;
    const r2 = await assess(w, v, m.boundaryMs + 62_000);
    expect(r2.outcome).not.toBe('PASSED');
  });

  it('a recalibrated channel supersedes the open evaluation; only samples on the new revision count', async () => {
    const v = await verifyingIncident(w);
    const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    const first = await assess(w, v, m.boundaryMs + 1_000);
    expect(first.outcome).toBe('OBSERVING');
    await reviseSensorChannel(w.db.pool, w.admin, v.device.channels.temp as never, {
      kind: 'TEMPERATURE',
      unit: 'MILLI_CELSIUS',
      sourceUnit: 'CELSIUS',
      calibrationRevision: 2,
      source: 'API',
    });
    await readings(w, v.device, steady(m.boundaryMs + 1_000, m.boundaryMs + 61_000));
    const r = await assess(w, v, m.boundaryMs + 61_500);
    expect(r.outcome).toBe('PASSED');
    expect(r.recoveryEvaluationId).not.toBe(first.recoveryEvaluationId);
    const old = (
      await q(`SELECT state, state_reason FROM recovery_evaluations WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        first.recoveryEvaluationId,
      ])
    )[0];
    expect(old).toEqual({ state: 'FAILED', state_reason: 'BINDING_SUPERSEDED' });
    const pins = await q(
      `SELECT p.channel_revision_id, s.current_revision_id FROM recovery_evaluation_channels p
         JOIN sensor_channels s ON s.tenant_id = p.tenant_id AND s.id = p.channel_id
        WHERE p.tenant_id = $1 AND p.evaluation_id = $2`,
      [w.tenant.tenantId, r.recoveryEvaluationId],
    );
    expect(pins).toHaveLength(1);
    expect(pins[0].channel_revision_id).toBe(pins[0].current_revision_id);
  });

  it('a revoked device cannot contribute proof: the evaluation fails and the incident escalates', async () => {
    const v = await verifyingIncident(w);
    const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    expect((await assess(w, v, m.boundaryMs + 500)).outcome).toBe('OBSERVING');
    await readings(w, v.device, steady(m.boundaryMs + 1_000, m.boundaryMs + 61_000));
    await setDeviceStatus(w.db.pool, w.admin, v.device.deviceId, 'REVOKED');
    const r = await assess(w, v, m.boundaryMs + 61_500);
    expect(r).toMatchObject({ outcome: 'FAILED', incidentState: 'ESCALATED', closeoutId: null });
    expect(r.reasonCodes).toContain('BINDING_REVOKED');
    expect((await transitionPath(w, v.incidentId)).slice(-1)).toEqual(['VERIFYING>ESCALATED']);
  });

  it('an evaluation past its policy observation limit EXPIRES and escalates instead of hiding as healthy', async () => {
    const v = await verifyingIncident(w);
    const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    const r = await assess(w, v, m.boundaryMs + 30 * 60_000 + 1_000);
    expect(r).toMatchObject({ outcome: 'EXPIRED', incidentState: 'ESCALATED' });
    const st = await getRecoveryStatus(w.db.pool, w.viewerCtx, v.incidentId);
    expect(st.gate).toMatchObject({ recovered: false, releasesCompletionValue: false });
  });

  it('the database refuses a boundary other than the milestone time and pins only qualifying samples', async () => {
    const v = await verifyingIncident(w);
    const m = await milestoneAt(w, v, (await dbNowMs(w)) + 5_000);
    const ids = await readings(w, v.device, [
      { at: m.boundaryMs },
      { at: m.boundaryMs + 10_000, lagMs: 45_000 },
      { at: m.boundaryMs + 20_000 },
    ]);
    const open = await assess(w, v, m.boundaryMs + 20_500);
    expect(open.outcome).toBe('OBSERVING');
    const t = w.tenant.tenantId;
    const ev = (
      await q(`SELECT * FROM recovery_evaluations WHERE tenant_id = $1 AND id = $2`, [t, open.recoveryEvaluationId])
    )[0];
    // Boundary-equal and LATE samples cannot be pinned; a qualifying one can (it is rolled back here).
    for (const sampleId of [ids[0], ids[1]])
      await expect(
        w.db.admin(
          `INSERT INTO recovery_evaluation_samples (tenant_id, evaluation_id, sample_id, ordinal) VALUES ($1, $2, $3, 1)`,
          [t, ev.id, sampleId],
        ),
      ).rejects.toMatchObject({ code: 'UB201' });
    await w.db.admin(
      `BEGIN; INSERT INTO recovery_evaluation_samples (tenant_id, evaluation_id, sample_id, ordinal) VALUES ('${t}', '${ev.id}', '${ids[2]}', 1); ROLLBACK;`,
    );
    // An evaluation whose boundary is not its milestone's normalized occurred time is refused.
    await expect(
      w.db.admin(
        `INSERT INTO recovery_evaluations (tenant_id, id, incident_id, site_id, asset_id, asset_revision_id, recovery_cycle,
           plan_id, plan_action_id, action_digest, evidence_revision_id, recovery_policy_revision_id, rule_revision_id,
           milestone_id, observation_boundary_at, stable_window_ms, expires_at, binding_digest, state)
         SELECT tenant_id, 'rev_forged-boundary-0001', incident_id, site_id, asset_id, asset_revision_id, recovery_cycle,
           plan_id, plan_action_id, action_digest, evidence_revision_id, recovery_policy_revision_id, rule_revision_id,
           milestone_id, observation_boundary_at - interval '1 second', stable_window_ms, expires_at, binding_digest, 'PENDING'
           FROM recovery_evaluations WHERE tenant_id = $1 AND id = $2`,
        [t, ev.id],
      ),
    ).rejects.toMatchObject({ code: 'UB201' });
    // Pinned bindings never change.
    await expect(
      w.db.admin(
        `UPDATE recovery_evaluations SET observation_boundary_at = observation_boundary_at + interval '1 ms' WHERE tenant_id = $1 AND id = $2`,
        [t, ev.id],
      ),
    ).rejects.toMatchObject({ code: 'UB201' });
  });
});
