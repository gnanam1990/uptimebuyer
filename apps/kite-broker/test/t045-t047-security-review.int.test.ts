// T-045 / T-047 security review regressions (coordinator automated review of 0019, three MEDIUM findings).
// S1 unbound policy pin: an evaluation must pin exactly its milestone's recovery-policy revision, that revision's stable
//    window and boundary + max observation as expiry; a milestone must pin the revision in force for the incident's
//    scope (site over tenant) at its observed time — never a weaker, foreign-site or superseded one.
// S2 TOCTOU on PASSED: a dispute of pinned signoff or milestone-source evidence, or a revoked CMMS integration behind
//    it, refuses the PASSED transition; a dispute racing a closeout is serialized so PASSED never commits with disputed
//    evidence.
// S3 attestation role: an attestation backs a milestone or a signoff only when its stored attester holds a role the
//    pinned policy names (a viewer or a plain operator cannot); the service layer refuses other roles and other sites.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SiteId } from '@uptimebuyer/contracts';
import {
  assessRecovery,
  disputeRecoveryEvidence,
  publishRecoveryPolicy,
  recordRecoveryEvidence,
} from '@uptimebuyer/recovery';
import { MANUFACTURER } from '../../../packages/planning/test/helpers.js';
import { rejection } from './helpers.js';
import {
  POLICY,
  cmmsRecord,
  createRecoveryWorld,
  dbNowMs,
  iso,
  milestoneAt,
  readings,
  sendCmms,
  steady,
  verifyingIncident,
  type RecoveryWorld,
  type VerifyingIncident,
} from './m11-helpers.js';

let w: RecoveryWorld;
beforeAll(async () => {
  w = await createRecoveryWorld('t047s');
});
afterAll(async () => w?.close());

const t = () => w.tenant.tenantId;

/** Run statements in one transaction that is always rolled back; resolves 'OK' or the SQLSTATE that refused. */
async function attempt(stmts: [string, unknown[]][]): Promise<string> {
  const c = await w.db.pool.connect();
  try {
    await c.query('BEGIN');
    for (const [sql, params] of stmts) await c.query(sql, params);
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERROR';
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

function forgeEvaluation(
  milestoneId: string,
  o: { policyId?: string; windowMs?: string; expiresSql?: string } = {},
): [string, unknown[]] {
  return [
    `INSERT INTO recovery_evaluations (tenant_id, id, incident_id, site_id, asset_id, asset_revision_id, recovery_cycle,
       plan_id, plan_action_id, action_digest, evidence_revision_id, recovery_policy_revision_id, rule_revision_id,
       milestone_id, observation_boundary_at, stable_window_ms, expires_at, binding_digest, state)
     SELECT i.tenant_id, $3, i.id, i.site_id, i.asset_id, i.asset_revision_id, i.reopen_count, m.plan_id, m.plan_action_id,
       m.action_digest,
       (SELECT er.id FROM evidence_revisions er WHERE er.tenant_id = i.tenant_id AND er.incident_id = i.id ORDER BY er.revision DESC LIMIT 1),
       p.id, i.rule_revision_id, m.id, m.occurred_at, ${o.windowMs ?? 'p.stable_window_ms'},
       ${o.expiresSql ?? "m.occurred_at + p.max_observation_ms * interval '1 millisecond'"},
       'recovery-binding.v1:sha256:' || repeat('0', 64), 'PENDING'
       FROM intervention_milestones m
       JOIN incidents i ON i.tenant_id = m.tenant_id AND i.id = m.incident_id
       JOIN recovery_policy_revisions p ON p.tenant_id = m.tenant_id AND p.id = coalesce($4, m.recovery_policy_revision_id)
      WHERE m.tenant_id = $1 AND m.id = $2`,
    [t(), milestoneId, `rev_${randomUUID()}`, o.policyId ?? null],
  ];
}

function forgeMilestone(evidenceId: string, policyId: string): [string, unknown[]] {
  return [
    `INSERT INTO intervention_milestones (tenant_id, id, incident_id, site_id, asset_id, asset_revision_id, recovery_cycle,
       plan_id, plan_action_id, action_digest, milestone_type, source_evidence_id, source_kind, recovery_policy_revision_id,
       occurred_at, observed_at, signature, signature_key_id, milestone_digest, verified_by_kind, verified_by_id)
     SELECT e.tenant_id, $3, i.id, i.site_id, i.asset_id, i.asset_revision_id, i.reopen_count, e.plan_id, pa.id,
       e.action_digest, e.milestone_type, e.id, e.source_kind, $4, date_trunc('milliseconds', e.occurred_at), e.observed_at,
       'hmac-sha256:' || repeat('a', 64), 'k1', 'intervention-milestone.v1:sha256:' || repeat('b', 64), 'SERVICE', 'svc-forged'
       FROM recovery_evidence e
       JOIN incidents i ON i.tenant_id = e.tenant_id AND i.id = e.incident_id
       JOIN plan_actions pa ON pa.tenant_id = e.tenant_id AND pa.plan_id = e.plan_id AND pa.action_digest = e.action_digest
      WHERE e.tenant_id = $1 AND e.id = $2`,
    [t(), evidenceId, `iml_${randomUUID()}`, policyId],
  ];
}

describe('S1 policy pins are bound to the milestone and the incident scope', () => {
  let v: VerifyingIncident;
  let milestoneId: string;
  let weakId: string;
  beforeAll(async () => {
    v = await verifyingIncident(w);
    milestoneId = (await milestoneAt(w, v, (await dbNowMs(w)) + 2_000)).milestoneId;
    weakId = (
      await publishRecoveryPolicy(w.db.pool, w.admin, {
        siteId: null,
        body: {
          ...POLICY,
          minSamples: 2,
          maxObservationMs: 7 * 86_400_000,
          requiredSignoffs: ['OPERATOR_ATTESTATION'],
        },
      })
    ).recoveryPolicyRevisionId;
  });

  it('an evaluation cannot pin a weaker policy, another window or a later expiry than its milestone', async () => {
    expect(await attempt([forgeEvaluation(milestoneId)])).toBe('OK');
    expect(await attempt([forgeEvaluation(milestoneId, { policyId: weakId })])).toBe('UB201');
    expect(await attempt([forgeEvaluation(milestoneId, { windowMs: '120000' })])).toBe('UB201');
    expect(
      await attempt([
        forgeEvaluation(milestoneId, {
          expiresSql: "m.occurred_at + 2 * p.max_observation_ms * interval '1 millisecond'",
        }),
      ]),
    ).toBe('UB201');
  });

  it('a milestone cannot pin a foreign-site, superseded or less specific policy revision', async () => {
    const siteTwo = (await publishRecoveryPolicy(w.db.pool, w.admin, { siteId: w.otherSiteId as SiteId, body: POLICY }))
      .recoveryPolicyRevisionId;
    const v2 = await verifyingIncident(w);
    const ev = await sendCmms(w, w.cmms, cmmsRecord(v2, (await dbNowMs(w)) + 1_000));
    const original = w.recoveryPolicyRevisionId; // superseded by the weak tenant-wide revision
    expect(await attempt([forgeMilestone(ev.evidenceId, weakId)])).toBe('OK');
    expect(await attempt([forgeMilestone(ev.evidenceId, siteTwo)])).toBe('UB204');
    expect(await attempt([forgeMilestone(ev.evidenceId, original)])).toBe('UB204');
    // A site-specific revision takes precedence over the tenant-wide one.
    const siteOne = (await publishRecoveryPolicy(w.db.pool, w.admin, { siteId: w.siteId, body: POLICY }))
      .recoveryPolicyRevisionId;
    const ev2 = await sendCmms(w, w.cmms, cmmsRecord(v2, (await dbNowMs(w)) + 1_000));
    expect(await attempt([forgeMilestone(ev2.evidenceId, siteOne)])).toBe('OK');
    expect(await attempt([forgeMilestone(ev2.evidenceId, weakId)])).toBe('UB204');
  });
});

/** A VERIFYING incident with an OBSERVING evaluation whose window is complete but nothing is pinned yet. */
async function readyButUnpinned() {
  const v = await verifyingIncident(w);
  const m = await milestoneAt(w, v, (await dbNowMs(w)) + 2_000);
  const ids = await readings(w, v.device, steady(m.boundaryMs + 1_000, m.boundaryMs + 61_000));
  await expect(
    assessRecovery(
      w.db.pool,
      w.service,
      { incidentId: v.incidentId, idempotencyKey: w.key('crash'), asOf: iso(m.boundaryMs + 61_500) },
      w.recoverySigning,
      {
        faults: {
          afterCloseout() {
            throw new Error('stop before commit');
          },
        },
      },
    ),
  ).rejects.toThrow('stop before commit');
  const ev = (
    await w.db.pool.query(
      `SELECT id FROM recovery_evaluations WHERE tenant_id = $1 AND incident_id = $2 AND state = 'OBSERVING'`,
      [t(), v.incidentId],
    )
  ).rows[0].id as string;
  return { v, m, ids, evaluationId: ev };
}

const pinSamples = (evaluationId: string, ids: string[]): [string, unknown[]][] =>
  ids.map((id, i) => [
    `INSERT INTO recovery_evaluation_samples (tenant_id, evaluation_id, sample_id, ordinal) VALUES ($1, $2, $3, $4)`,
    [t(), evaluationId, id, i + 1],
  ]);
const pinSignoff = (evaluationId: string, requirement: string, evidenceId: string): [string, unknown[]] => [
  `INSERT INTO recovery_evaluation_signoffs (tenant_id, evaluation_id, requirement, evidence_id) VALUES ($1, $2, $3, $4)`,
  [t(), evaluationId, requirement, evidenceId],
];
const dispute = (evidenceId: string, incidentId: string): [string, unknown[]] => [
  `INSERT INTO recovery_evidence_disputes (tenant_id, id, evidence_id, incident_id, reason_code, actor_kind, actor_id)
   VALUES ($1, $2, $3, $4, 'FORGED_SIGNOFF', 'HUMAN', 'usr_reviewer')`,
  [t(), `rcd_${randomUUID()}`, evidenceId, incidentId],
];
const pass = (evaluationId: string): [string, unknown[]] => [
  `UPDATE recovery_evaluations SET state = 'PASSED', decided_at = clock_timestamp(), version = version + 1
    WHERE tenant_id = $1 AND id = $2`,
  [t(), evaluationId],
];

describe('S2 PASSED re-checks disputes and revocation and serializes with disputes', () => {
  beforeAll(async () => {
    // Whatever S1 left in force, S2/S3 run under the standard policy as the site's own revision.
    await publishRecoveryPolicy(w.db.pool, w.admin, { siteId: w.siteId, body: POLICY });
  });

  it('PASSED is refused when pinned signoff or milestone-source evidence is disputed or its integration revoked', async () => {
    const r = await readyButUnpinned();
    const pins = [
      ...pinSamples(r.evaluationId, r.ids),
      pinSignoff(r.evaluationId, 'CMMS_WORK_ORDER', r.m.evidenceId),
      pinSignoff(r.evaluationId, 'INSTALLED_PART', r.m.evidenceId),
    ];
    expect(await attempt([...pins, pass(r.evaluationId)])).toBe('OK');
    expect(await attempt([...pins, dispute(r.m.evidenceId, r.v.incidentId), pass(r.evaluationId)])).toBe('UB201');
    expect(
      await attempt([
        ...pins,
        [
          `UPDATE cmms_integrations SET revoked_at = clock_timestamp(), revoked_reason = 'KEY_COMPROMISED' WHERE tenant_id = $1 AND id = $2`,
          [t(), w.cmms.cmmsIntegrationId],
        ],
        pass(r.evaluationId),
      ]),
    ).toBe('UB201');
    // Signoffs from another record, but the milestone's own source evidence disputed.
    const other = await sendCmms(w, w.cmms, cmmsRecord(r.v, r.m.boundaryMs + 3_000));
    const otherPins = [
      ...pinSamples(r.evaluationId, r.ids),
      pinSignoff(r.evaluationId, 'CMMS_WORK_ORDER', other.evidenceId),
      pinSignoff(r.evaluationId, 'INSTALLED_PART', other.evidenceId),
    ];
    expect(await attempt([...otherPins, pass(r.evaluationId)])).toBe('OK');
    expect(await attempt([...otherPins, dispute(r.m.evidenceId, r.v.incidentId), pass(r.evaluationId)])).toBe('UB201');
  });

  it('a dispute racing the closeout: exactly one wins and PASSED never commits with disputed evidence', async () => {
    for (let round = 0; round < 3; round++) {
      const v = await verifyingIncident(w);
      const m = await milestoneAt(w, v, (await dbNowMs(w)) + 2_000);
      await readings(w, v.device, steady(m.boundaryMs + 1_000, m.boundaryMs + 61_000));
      const [a, d] = await Promise.allSettled([
        assessRecovery(
          w.db.pool,
          w.service,
          { incidentId: v.incidentId, idempotencyKey: w.key('race'), asOf: iso(m.boundaryMs + 61_500) },
          w.recoverySigning,
        ),
        disputeRecoveryEvidence(w.db.pool, w.operator, {
          evidenceId: m.evidenceId,
          reasonCode: 'TECHNICIAN_NOT_ONSITE',
          idempotencyKey: w.key('race-dispute'),
        }),
      ]);
      expect(d.status).toBe('fulfilled');
      expect(a.status).toBe('fulfilled');
      const { rows } = await w.db.pool.query(
        `SELECT co.decided_at, co.reopened_at, co.reopen_ref, d.id AS dispute_id, d.recorded_at
           FROM recovery_evidence_disputes d
           LEFT JOIN recovery_closeouts co ON co.tenant_id = d.tenant_id AND co.incident_id = d.incident_id
          WHERE d.tenant_id = $1 AND d.evidence_id = $2`,
        [t(), m.evidenceId],
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row.decided_at) {
        // The closeout won: the dispute committed after it and reopened the incident, linked to the dispute.
        expect(row.recorded_at.getTime()).toBeGreaterThanOrEqual(row.decided_at.getTime());
        expect(row.reopen_ref).toBe(row.dispute_id);
      } else {
        // The dispute won: no PASSED evaluation exists for this incident.
        const passed = await w.db.pool.query(
          `SELECT count(*)::int AS n FROM recovery_evaluations WHERE tenant_id = $1 AND incident_id = $2 AND state = 'PASSED'`,
          [t(), v.incidentId],
        );
        expect(passed.rows[0].n).toBe(0);
      }
    }
  });
});

describe('S3 attestations need a policy-named attester role', () => {
  const forgedAttestation = (v: VerifyingIncident, userId: string): [string, unknown[]] => {
    const id = `rce_${randomUUID()}`;
    return [
      `INSERT INTO recovery_evidence (tenant_id, id, incident_id, site_id, asset_id, kind, source_kind, trust, actor_kind,
         actor_id, plan_id, action_digest, milestone_type, occurred_at, observed_at, part_manufacturer, part_number,
         part_serial, body, body_digest, signature_digest, signature_key_id)
       SELECT i.tenant_id, $3, i.id, i.site_id, i.asset_id, 'OPERATOR_ATTESTATION', 'AUTHORIZED_OPERATOR',
         'OPERATOR_ATTESTED', 'HUMAN', $4, $5, $6, 'WORK_COMPLETED', clock_timestamp(), clock_timestamp(), $7, '5A1-0402',
         'SN-FORGED-1', '{}', 'sha256:' || repeat('0', 64), 'hmac-sha256:' || repeat('1', 64), 'k1'
         FROM incidents i WHERE i.tenant_id = $1 AND i.id = $2`,
      [t(), v.incidentId, id, userId, v.planId, v.actionDigest, MANUFACTURER],
    ];
  };
  const idOf = (stmt: [string, unknown[]]) => stmt[1][2] as string;

  it("a viewer's attestation cannot back a milestone", async () => {
    const v = await verifyingIncident(w);
    const ev = forgedAttestation(v, w.people.viewer!.userId);
    const policy = (
      await w.db.pool.query(
        `SELECT id FROM recovery_policy_revisions WHERE tenant_id = $1 AND scope_key IN ($2, 'TENANT') AND effective_at <= clock_timestamp()
          ORDER BY (scope_key = $2) DESC, effective_at DESC LIMIT 1`,
        [t(), w.siteId],
      )
    ).rows[0].id as string;
    expect(['UB204', '23514']).toContain(await attempt([ev, forgeMilestone(idOf(ev), policy)]));
  });

  it("a plain operator's attestation cannot be pinned as a signoff", async () => {
    const r = await readyButUnpinned();
    const ev = forgedAttestation(r.v, w.people.operator!.userId);
    expect(['UB201', '23514']).toContain(
      await attempt([ev, pinSignoff(r.evaluationId, 'OPERATOR_ATTESTATION', idOf(ev))]),
    );
    expect(['UB201', '23514']).toContain(await attempt([ev, pinSignoff(r.evaluationId, 'INSTALLED_PART', idOf(ev))]));
  });

  it('stored attester role must be one the pinned policy names, and the attester must still hold it', async () => {
    const r = await readyButUnpinned();
    const id = `rce_${randomUUID()}`;
    const insert = (userId: string, role: string): [string, unknown[]] => [
      `INSERT INTO recovery_evidence (tenant_id, id, incident_id, site_id, asset_id, kind, source_kind, trust, actor_kind,
         actor_id, attester_user_id, attester_role, plan_id, action_digest, milestone_type, occurred_at, observed_at,
         body, body_digest, signature_digest, signature_key_id)
       SELECT i.tenant_id, $3, i.id, i.site_id, i.asset_id, 'OPERATOR_ATTESTATION', 'AUTHORIZED_OPERATOR',
         'OPERATOR_ATTESTED', 'HUMAN', $4, $4, $5, $6, $7, 'WORK_COMPLETED', clock_timestamp(), clock_timestamp(), '{}',
         'sha256:' || repeat('0', 64), 'hmac-sha256:' || repeat('1', 64), 'k1'
         FROM incidents i WHERE i.tenant_id = $1 AND i.id = $2`,
      [t(), r.v.incidentId, id, userId, role, r.v.planId, r.v.actionDigest],
    ];
    expect(await attempt([insert(w.people.viewer!.userId, 'viewer')])).toBe('23514');
    // An operator claiming the operator role: allowed as a stored role, but this policy names approver/engineer only.
    expect(
      await attempt([
        insert(w.people.operator!.userId, 'operator'),
        pinSignoff(r.evaluationId, 'OPERATOR_ATTESTATION', id),
      ]),
    ).toBe('UB201');
    // Claiming a role the human does not hold is refused too.
    expect(
      await attempt([
        insert(w.people.operator!.userId, 'maintenance_approver'),
        pinSignoff(r.evaluationId, 'OPERATOR_ATTESTATION', id),
      ]),
    ).toBe('UB201');
    expect(
      await attempt([
        insert(w.people.approver!.userId, 'maintenance_approver'),
        pinSignoff(r.evaluationId, 'OPERATOR_ATTESTATION', id),
      ]),
    ).toBe('OK');
  });

  it('the service layer refuses a viewer and another site, and records the allowed role', async () => {
    const v = await verifyingIncident(w);
    const att = {
      incidentId: v.incidentId,
      kind: 'OPERATOR_ATTESTATION' as const,
      occurredAt: iso(Date.now()),
      planId: v.planId,
      actionDigest: v.actionDigest,
      milestoneType: 'WORK_COMPLETED' as const,
    };
    expect(
      (
        await rejection(
          recordRecoveryEvidence(w.db.pool, w.viewerCtx, { ...att, idempotencyKey: w.key('a') }, w.recoverySigning),
        )
      ).code,
    ).toBe('FORBIDDEN');
    expect(
      (
        await rejection(
          recordRecoveryEvidence(
            w.db.pool,
            w.farEngineer.ctx,
            { ...att, idempotencyKey: w.key('a') },
            w.recoverySigning,
          ),
        )
      ).code,
    ).toBe('FORBIDDEN');
    const ok = await recordRecoveryEvidence(
      w.db.pool,
      w.approver,
      { ...att, idempotencyKey: w.key('a') },
      w.recoverySigning,
    );
    const row = (
      await w.db.pool.query(
        `SELECT attester_user_id, attester_role FROM recovery_evidence WHERE tenant_id = $1 AND id = $2`,
        [t(), ok.evidenceId],
      )
    ).rows[0];
    expect(row).toEqual({ attester_user_id: w.people.approver!.userId, attester_role: 'maintenance_approver' });
  });
});
