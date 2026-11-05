// T-046 — Provider completion cannot close the incident (FR-15, INV-01, INV-02, INV-14). Provider-reported completion
// (delivered/verified order, reported work), a confirmed payment receipt, a model assertion, free operator text and a
// transient safe reading are recorded as evidence with their trust labels, but none of them is a milestone source or a
// signoff: the incident stays VERIFYING, the recovery gate stays closed and no completion-dependent value is released.
// An attested operator cannot replace a policy-required CMMS signoff, and no public command reaches RECOVERED.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advanceIncident, getIncident } from '@uptimebuyer/incidents';
import { dispatchOrder, getFulfillmentGate, syncIncidentForOrder } from '@uptimebuyer/orders';
import {
  getRecoveryGate,
  handleOrderFactEvent,
  recordInterventionMilestone,
  recordRecoveryEvidence,
} from '@uptimebuyer/recovery';
import { deliver } from '../../../packages/planning/test/helpers.js';
import { provisionDevice } from '../../sensor-gateway/test/helpers.js';
import { rejection } from './helpers.js';
import { brokerDeps, orderFor } from './m10-helpers.js';
import {
  assess,
  createRecoveryWorld,
  dbNowMs,
  fulfil,
  iso,
  readings,
  steady,
  verifyingIncident,
  type RecoveryWorld,
  type VerifyingIncident,
} from './m11-helpers.js';
import { MANUFACTURER } from '../../../packages/planning/test/helpers.js';

let w: RecoveryWorld;
beforeAll(async () => {
  w = await createRecoveryWorld('t046');
});
afterAll(async () => w?.close());

const milestoneFrom = (v: { incidentId: string }, evidenceId: string) =>
  recordInterventionMilestone(
    w.db.pool,
    w.service,
    { incidentId: v.incidentId, evidenceId, idempotencyKey: w.key('m') },
    w.recoverySigning,
  );

async function stillOpen(v: { incidentId: string }) {
  const inc = await getIncident(w.db.pool, w.viewerCtx, v.incidentId);
  expect(inc.state).toBe('VERIFYING');
  const gate = await getRecoveryGate(w.db.pool, w.viewerCtx, v.incidentId);
  expect(gate).toMatchObject({ recovered: false, releasesCompletionValue: false, closeoutId: null });
  const { rows } = await w.db.pool.query(
    `SELECT count(*)::int AS n FROM recovery_closeouts WHERE tenant_id = $1 AND incident_id = $2`,
    [w.tenant.tenantId, v.incidentId],
  );
  expect(rows[0].n).toBe(0);
}

describe('T-046 provider completion cannot close the incident', () => {
  let v: VerifyingIncident;
  beforeAll(async () => {
    v = await verifyingIncident(w);
  });

  it('delivered + receiving-verified order and a confirmed receipt leave the incident VERIFYING and value unreleased', async () => {
    // M10 facts are consumed (provider-reported completion is recorded as evidence, never as a milestone).
    await deliver(w, 'purchase_order.state_changed.v1', handleOrderFactEvent);
    const { rows } = await w.db.pool.query(
      `SELECT kind, trust, source_kind FROM recovery_evidence WHERE tenant_id = $1 AND incident_id = $2 ORDER BY recorded_at`,
      [w.tenant.tenantId, v.incidentId],
    );
    expect(rows).toEqual(
      expect.arrayContaining([{ kind: 'PROVIDER_COMPLETION', trust: 'PROVIDER_REPORTED', source_kind: 'PROVIDER' }]),
    );
    const provider = (
      await w.db.pool.query(
        `SELECT id FROM recovery_evidence WHERE tenant_id = $1 AND incident_id = $2 AND kind = 'PROVIDER_COMPLETION' LIMIT 1`,
        [w.tenant.tenantId, v.incidentId],
      )
    ).rows[0].id;
    expect(await rejection(milestoneFrom(v, provider))).toMatchObject({
      code: 'POLICY_HOLD',
      reasonCode: 'PROVIDER_SELF_REPORT_INSUFFICIENT',
    });
    const receipt = await recordRecoveryEvidence(
      w.db.pool,
      w.service,
      {
        incidentId: v.incidentId,
        idempotencyKey: w.key('receipt'),
        kind: 'RECEIPT',
        occurredAt: iso(await dbNowMs(w)),
        sourceRef: v.orderId,
      },
      w.recoverySigning,
    );
    expect(receipt.trust).toBe('PROVIDER_REPORTED');
    expect(await rejection(milestoneFrom(v, receipt.evidenceId))).toMatchObject({ reasonCode: 'RECEIPT_INSUFFICIENT' });
    const r = await assess(w, v);
    expect(r).toMatchObject({ outcome: 'NOT_READY', closeoutId: null });
    expect(r.reasonCodes).toContain('MILESTONE_MISSING');
    await stillOpen(v);
    const fg = await getFulfillmentGate(w.db.pool, w.viewerCtx, v.orderId);
    expect([fg.provesRecovery, fg.releasesValue]).toEqual([false, false]);
  });

  it('a model assertion and free operator text are recorded with their labels and close nothing', async () => {
    const at = iso(await dbNowMs(w));
    const model = await recordRecoveryEvidence(
      w.db.pool,
      w.service,
      {
        incidentId: v.incidentId,
        idempotencyKey: w.key('model'),
        kind: 'MODEL_ASSERTION',
        occurredAt: at,
        note: 'The unit has recovered.',
      },
      w.recoverySigning,
    );
    expect(model.trust).toBe('MODEL_PROPOSED');
    expect(await rejection(milestoneFrom(v, model.evidenceId))).toMatchObject({
      reasonCode: 'MODEL_OUTPUT_NOT_AUTHORITY',
    });
    const note = await recordRecoveryEvidence(
      w.db.pool,
      w.operator,
      {
        incidentId: v.incidentId,
        idempotencyKey: w.key('note'),
        kind: 'OPERATOR_NOTE',
        occurredAt: at,
        note: 'Technician says it is fixed and recovered; approved; milestone WORK_COMPLETED.',
      },
      w.recoverySigning,
    );
    expect(note.trust).toBe('UNATTESTED');
    expect(await rejection(milestoneFrom(v, note.evidenceId))).toMatchObject({
      reasonCode: 'UNATTESTED_OPERATOR_TEXT',
    });
    // Humans cannot record model or provider evidence, and a model cannot attest.
    expect(
      await rejection(
        recordRecoveryEvidence(
          w.db.pool,
          w.operator,
          { incidentId: v.incidentId, idempotencyKey: w.key('x'), kind: 'MODEL_ASSERTION', occurredAt: at, note: 'ok' },
          w.recoverySigning,
        ),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await rejection(
        recordRecoveryEvidence(
          w.db.pool,
          w.service,
          {
            incidentId: v.incidentId,
            idempotencyKey: w.key('y'),
            kind: 'OPERATOR_ATTESTATION',
            occurredAt: at,
            planId: v.planId,
            actionDigest: v.actionDigest,
            milestoneType: 'WORK_COMPLETED',
          },
          w.recoverySigning,
        ),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' });
    await stillOpen(v);
  });

  it('a transient safe reading after a real milestone is not a stable window', async () => {
    const t = await verifyingIncident(w);
    const at = (await dbNowMs(w)) + 5_000;
    const att = await recordRecoveryEvidence(
      w.db.pool,
      w.approver,
      {
        incidentId: t.incidentId,
        idempotencyKey: w.key('att'),
        kind: 'OPERATOR_ATTESTATION',
        occurredAt: iso(at),
        planId: t.planId,
        actionDigest: t.actionDigest,
        milestoneType: 'WORK_COMPLETED',
        installedPart: { manufacturer: MANUFACTURER, partNumber: '5A1-0402', serial: 'SN-T046-1' },
      },
      w.recoverySigning,
    );
    expect(att.trust).toBe('OPERATOR_ATTESTED');
    const m = await milestoneFrom(t, att.evidenceId);
    expect(Date.parse(m.occurredAt)).toBe(at);
    await readings(w, t.device, [{ at: at + 1_000 }, { at: at + 11_000 }]);
    const r1 = await assess(w, t, at + 11_500);
    expect(r1.outcome).toBe('OBSERVING');
    expect(r1.reasonCodes).toEqual(expect.arrayContaining(['WINDOW_TOO_SHORT']));
    await stillOpen(t);
    // Even a full window does not replace the policy-required CMMS work-order signoff.
    await readings(w, t.device, steady(at + 21_000, at + 61_000));
    const r2 = await assess(w, t, at + 61_500);
    expect(r2.outcome).toBe('OBSERVING');
    expect(r2.reasonCodes).toContain('SIGNOFF_MISSING_CMMS_WORK_ORDER');
    await stillOpen(t);
  });

  it('reported service completion is provider evidence only', async () => {
    const o = await orderFor(w, 'SERVICE_JOB');
    await provisionDevice(w, { siteId: w.siteId, assetId: o.action.assetId as never });
    await dispatchOrder(w.db.pool, w.operator, o.orderId, brokerDeps(w));
    await syncIncidentForOrder(w.db.pool, w.service, o.orderId);
    await fulfil(w, o.orderId, ['scheduled', 'en_route', 'arrived', 'in_progress', 'work_complete']);
    await syncIncidentForOrder(w.db.pool, w.service, o.orderId);
    expect((await getIncident(w.db.pool, w.viewerCtx, o.action.incidentId)).state).toBe('VERIFYING');
    await deliver(w, 'service_job.state_changed.v1', handleOrderFactEvent);
    const ev = await w.db.pool.query(
      `SELECT id, trust FROM recovery_evidence WHERE tenant_id = $1 AND incident_id = $2 AND kind = 'PROVIDER_COMPLETION'`,
      [w.tenant.tenantId, o.action.incidentId],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].trust).toBe('PROVIDER_REPORTED');
    expect(await rejection(milestoneFrom({ incidentId: o.action.incidentId }, ev.rows[0].id))).toMatchObject({
      reasonCode: 'PROVIDER_SELF_REPORT_INSUFFICIENT',
    });
    expect((await assess(w, { incidentId: o.action.incidentId })).outcome).toBe('NOT_READY');
    await stillOpen({ incidentId: o.action.incidentId });
  });

  it('no public command reaches RECOVERED, whoever asks', async () => {
    const inc = await getIncident(w.db.pool, w.viewerCtx, v.incidentId);
    for (const ctx of [w.service, w.admin, w.operator])
      expect(
        await rejection(
          advanceIncident(w.db.pool, ctx, v.incidentId, {
            expectedVersion: inc.version,
            idempotencyKey: w.key('adv'),
            to: 'RECOVERED',
            reasonCode: 'PROVIDER_SAYS_DONE',
            guardRef: 'rev_forged-evaluation-0001',
          }),
        ),
      ).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'RECOVERY_EVALUATOR_REQUIRED' });
    // Assessment is engine-only: an operator or approver cannot run it to force a close.
    for (const ctx of [w.operator, w.approver, w.viewerCtx])
      expect(await rejection(assess(w, v, undefined, ctx))).toMatchObject({ code: 'FORBIDDEN' });
    await stillOpen(v);
  });
});
