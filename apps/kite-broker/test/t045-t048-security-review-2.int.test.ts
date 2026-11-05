// T-045 / T-047 / T-048 security review regressions, round 2 (coordinator automated review of packages/recovery).
// S4 unverified milestone seal: a milestone row written directly in the database with a bad or unknown-key signature
//    is never the binding milestone; the assessment ignores it and no closeout happens.
// S5 attester role revocation: an operator-attested milestone stops authorizing as soon as the attester no longer holds
//    a policy-named role at the site; PASSED/closeout are refused.
// S6 dispute effect before receipt: a dispute whose reopen fails after the dispute committed must not be replayed as a
//    success while the incident is still RECOVERED; the gate fails closed on disputed pinned evidence, and a retry (same
//    or new key) completes the reopen.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeRole } from '@uptimebuyer/data';
import { getIncident } from '@uptimebuyer/incidents';
import {
  disputeRecoveryEvidence,
  getRecoveryGate,
  recordInterventionMilestone,
  recordRecoveryEvidence,
} from '@uptimebuyer/recovery';
import { person } from '../../../packages/compatibility/test/helpers.js';
import { MANUFACTURER } from '../../../packages/planning/test/helpers.js';
import {
  assess,
  cmmsRecord,
  createRecoveryWorld,
  dbNowMs,
  iso,
  readings,
  recoveredIncident,
  sendCmms,
  steady,
  verifyingIncident,
  type RecoveryWorld,
} from './m11-helpers.js';

let w: RecoveryWorld;
beforeAll(async () => {
  w = await createRecoveryWorld('t048s');
});
afterAll(async () => w?.close());

const t = () => w.tenant.tenantId;
const closeouts = async (incidentId: string) =>
  (
    await w.db.pool.query(`SELECT id FROM recovery_closeouts WHERE tenant_id = $1 AND incident_id = $2`, [
      t(),
      incidentId,
    ])
  ).rows;

describe('S4 milestone seals are verified before a milestone can bind an evaluation', () => {
  for (const [label, signature, keyId] of [
    ['a bad signature', `hmac-sha256:${'a'.repeat(64)}`, 'recovery-k1'],
    ['an unknown signing key', `hmac-sha256:${'b'.repeat(64)}`, 'forged-key'],
  ] as const)
    it(`a milestone inserted directly with ${label} is ignored and nothing closes`, async () => {
      const v = await verifyingIncident(w);
      const at = (await dbNowMs(w)) + 2_000;
      const ev = await sendCmms(w, w.cmms, cmmsRecord(v, at));
      await w.db.admin(
        `INSERT INTO intervention_milestones (tenant_id, id, incident_id, site_id, asset_id, asset_revision_id, recovery_cycle,
           plan_id, plan_action_id, action_digest, milestone_type, source_evidence_id, source_kind, recovery_policy_revision_id,
           occurred_at, observed_at, signature, signature_key_id, milestone_digest, verified_by_kind, verified_by_id)
         SELECT e.tenant_id, $3, i.id, i.site_id, i.asset_id, i.asset_revision_id, i.reopen_count, e.plan_id, pa.id,
           e.action_digest, e.milestone_type, e.id, e.source_kind, $4, date_trunc('milliseconds', e.occurred_at),
           e.observed_at, $5, $6, 'intervention-milestone.v1:sha256:' || repeat('c', 64), 'SERVICE', 'svc-forged'
           FROM recovery_evidence e
           JOIN incidents i ON i.tenant_id = e.tenant_id AND i.id = e.incident_id
           JOIN plan_actions pa ON pa.tenant_id = e.tenant_id AND pa.plan_id = e.plan_id AND pa.action_digest = e.action_digest
          WHERE e.tenant_id = $1 AND e.id = $2`,
        [t(), ev.evidenceId, `iml_${randomUUID()}`, w.recoveryPolicyRevisionId, signature, keyId],
      );
      await readings(w, v.device, steady(at + 1_000, at + 61_000));
      const r = await assess(w, v, at + 61_500);
      expect(r.outcome).toBe('NOT_READY');
      expect(r.reasonCodes).toContain('MILESTONE_MISSING');
      expect(await closeouts(v.incidentId)).toEqual([]);
      expect((await getIncident(w.db.pool, w.viewerCtx, v.incidentId)).state).toBe('VERIFYING');
    });
});

describe('S5 an attested milestone needs the attester to keep the policy role', () => {
  it('revoking the attester role refuses PASSED and closeout', async () => {
    const attester = await person(w, 'attester', ['maintenance_approver', 'operator'], w.siteId);
    const v = await verifyingIncident(w);
    const at = (await dbNowMs(w)) + 2_000;
    const att = await recordRecoveryEvidence(
      w.db.pool,
      attester.ctx,
      {
        incidentId: v.incidentId,
        idempotencyKey: w.key('att'),
        kind: 'OPERATOR_ATTESTATION',
        occurredAt: iso(at),
        planId: v.planId,
        actionDigest: v.actionDigest,
        milestoneType: 'WORK_COMPLETED',
      },
      w.recoverySigning,
    );
    await recordInterventionMilestone(
      w.db.pool,
      w.service,
      { incidentId: v.incidentId, evidenceId: att.evidenceId, idempotencyKey: w.key('m') },
      w.recoverySigning,
    );
    // Everything else the policy needs comes from the CMMS (work-order signoff with the exact part).
    await sendCmms(w, w.cmms, cmmsRecord(v, at + 500, { milestoneType: undefined }));
    expect((await assess(w, v, at + 500)).outcome).toBe('OBSERVING');
    const { rows } = await w.db.pool.query(
      `SELECT id FROM role_assignments WHERE tenant_id = $1 AND user_id = $2 AND role = 'maintenance_approver' AND revoked_at IS NULL`,
      [t(), attester.userId],
    );
    await revokeRole(w.db.pool, w.admin, rows[0].id);
    await readings(w, v.device, steady(at + 1_000, at + 61_000));
    const r = await assess(w, v, at + 61_500);
    expect(r.outcome).not.toBe('PASSED');
    expect(await closeouts(v.incidentId)).toEqual([]);
    expect((await getIncident(w.db.pool, w.viewerCtx, v.incidentId)).state).toBe('VERIFYING');
  });
});

describe('S6 a dispute is reported done only when its effect is durable', () => {
  it('a reopen failing after the dispute commits is retried, never replayed as success; the gate fails closed', async () => {
    const { inc, m } = await recoveredIncident(w);
    const input = { evidenceId: m.evidenceId, reasonCode: 'SIGNOFF_FORGED', idempotencyKey: w.key('dispute') };
    await expect(
      disputeRecoveryEvidence(w.db.pool, w.operator, input, {
        faults: {
          beforeEffect() {
            throw new Error('crashed before the reopen');
          },
        },
      }),
    ).rejects.toThrow('crashed before the reopen');
    expect((await getIncident(w.db.pool, w.viewerCtx, inc.incidentId)).state).toBe('RECOVERED');
    // The dispute is durable: completion-dependent value must not be released on disputed pinned evidence.
    const gate = await getRecoveryGate(w.db.pool, w.viewerCtx, inc.incidentId);
    expect(gate).toMatchObject({ recovered: false, releasesCompletionValue: false });
    expect(gate.reasons).toContain('PINNED_EVIDENCE_DISPUTED');
    // The replay re-derives the effect from durable state and completes the reopen.
    const replay = await disputeRecoveryEvidence(w.db.pool, w.operator, input);
    expect(replay.incidentEffect).toBe('REOPENED');
    expect((await getIncident(w.db.pool, w.viewerCtx, inc.incidentId)).state).toBe('TRIAGING');
    const co = (
      await w.db.pool.query(
        `SELECT reopen_reason_code, reopen_ref FROM recovery_closeouts WHERE tenant_id = $1 AND incident_id = $2`,
        [t(), inc.incidentId],
      )
    ).rows[0];
    expect(co).toEqual({ reopen_reason_code: 'RECOVERY_EVIDENCE_DISPUTED', reopen_ref: replay.disputeId });
    // A later replay is still the same, settled answer.
    expect(await disputeRecoveryEvidence(w.db.pool, w.operator, input)).toEqual(replay);
  });

  it('a new dispute request on already-disputed evidence also completes a pending reopen', async () => {
    const { inc, m } = await recoveredIncident(w);
    await expect(
      disputeRecoveryEvidence(
        w.db.pool,
        w.operator,
        { evidenceId: m.evidenceId, reasonCode: 'SIGNOFF_FORGED', idempotencyKey: w.key('dispute') },
        {
          faults: {
            beforeEffect() {
              throw new Error('crashed before the reopen');
            },
          },
        },
      ),
    ).rejects.toThrow('crashed before the reopen');
    const again = await disputeRecoveryEvidence(w.db.pool, w.operator, {
      evidenceId: m.evidenceId,
      reasonCode: 'SIGNOFF_FORGED',
      idempotencyKey: w.key('dispute'),
    });
    expect(again.incidentEffect).toBe('REOPENED');
    expect((await getIncident(w.db.pool, w.viewerCtx, inc.incidentId)).state).toBe('TRIAGING');
    void MANUFACTURER;
  });
});
