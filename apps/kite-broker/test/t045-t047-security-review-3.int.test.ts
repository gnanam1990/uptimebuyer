// T-045 / T-047 security review regression, round 3 (coordinator: PASSED branch ignored attester-role revocation).
// S7: for every authorized-operator evidence row behind a PASSED decision (pinned signoffs and the milestone source),
//     the database requires, at decision time and under share locks on the attester's role assignment and membership,
//     an unrevoked assignment of exactly the stored role at the incident's site (or tenant-wide), an ACTIVE membership
//     and a role the pinned policy names. Role revocation and membership suspension update those rows, so a racing
//     revocation either commits first (PASSED is refused) or waits for PASSED to commit.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { setMembershipStatus } from '@uptimebuyer/data';
import { assessRecovery, recordRecoveryEvidence } from '@uptimebuyer/recovery';
import { person, type Person } from '../../../packages/compatibility/test/helpers.js';
import { MANUFACTURER } from '../../../packages/planning/test/helpers.js';
import {
  createRecoveryWorld,
  dbNowMs,
  iso,
  milestoneAt,
  readings,
  steady,
  verifyingIncident,
  type RecoveryWorld,
} from './m11-helpers.js';

let w: RecoveryWorld;
beforeAll(async () => {
  w = await createRecoveryWorld('t047t');
});
afterAll(async () => w?.close());

const t = () => w.tenant.tenantId;
type Stmt = [string, unknown[]];

/** An OBSERVING evaluation with a complete window and an attestation by `attester`, nothing pinned yet. */
async function prepared(attester: Person) {
  const v = await verifyingIncident(w);
  const m = await milestoneAt(w, v, (await dbNowMs(w)) + 2_000);
  const att = await recordRecoveryEvidence(
    w.db.pool,
    attester.ctx,
    {
      incidentId: v.incidentId,
      idempotencyKey: w.key('att'),
      kind: 'OPERATOR_ATTESTATION',
      occurredAt: iso(m.boundaryMs + 500),
      planId: v.planId,
      actionDigest: v.actionDigest,
      installedPart: { manufacturer: MANUFACTURER, partNumber: '5A1-0402', serial: 'SN-ATT-1' },
    },
    w.recoverySigning,
  );
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
  const evaluationId = (
    await w.db.pool.query(
      `SELECT id FROM recovery_evaluations WHERE tenant_id = $1 AND incident_id = $2 AND state = 'OBSERVING'`,
      [t(), v.incidentId],
    )
  ).rows[0].id as string;
  const pins: Stmt[] = [
    ...ids.map((id, i): Stmt => [
      `INSERT INTO recovery_evaluation_samples (tenant_id, evaluation_id, sample_id, ordinal) VALUES ($1, $2, $3, $4)`,
      [t(), evaluationId, id, i + 1],
    ]),
    [
      `INSERT INTO recovery_evaluation_signoffs (tenant_id, evaluation_id, requirement, evidence_id) VALUES ($1, $2, 'CMMS_WORK_ORDER', $3)`,
      [t(), evaluationId, m.evidenceId],
    ],
    [
      `INSERT INTO recovery_evaluation_signoffs (tenant_id, evaluation_id, requirement, evidence_id) VALUES ($1, $2, 'OPERATOR_ATTESTATION', $3)`,
      [t(), evaluationId, att.evidenceId],
    ],
    [
      `INSERT INTO recovery_evaluation_signoffs (tenant_id, evaluation_id, requirement, evidence_id) VALUES ($1, $2, 'INSTALLED_PART', $3)`,
      [t(), evaluationId, att.evidenceId],
    ],
  ];
  const pass: Stmt = [
    `UPDATE recovery_evaluations SET state = 'PASSED', decided_at = clock_timestamp(), version = version + 1
      WHERE tenant_id = $1 AND id = $2`,
    [t(), evaluationId],
  ];
  return { pins, pass, evaluationId };
}

async function attempt(stmts: Stmt[]): Promise<string> {
  const c = await w.db.pool.connect();
  try {
    await c.query('BEGIN');
    for (const [sql, p] of stmts) await c.query(sql, p);
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERROR';
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

const revokeSql = (userId: string): Stmt => [
  `UPDATE role_assignments SET revoked_at = clock_timestamp(), revoked_by_user_id = $3 WHERE tenant_id = $1 AND user_id = $2
      AND role = 'maintenance_approver' AND revoked_at IS NULL`,
  [t(), userId, w.tenant.adminUserId],
];

describe('S7 PASSED re-checks the attester role and membership under lock', () => {
  it('a role revoked between assessment and decision refuses PASSED', async () => {
    const a = await person(w, `att-${randomUUID().slice(0, 6)}`, ['maintenance_approver', 'operator'], w.siteId);
    const p = await prepared(a);
    expect(await attempt([...p.pins, p.pass])).toBe('OK');
    expect(await attempt([...p.pins, revokeSql(a.userId), p.pass])).toBe('UB201');
  });

  it('a membership suspended between assessment and decision refuses PASSED (suspension updates the membership row)', async () => {
    const a = await person(w, `att-${randomUUID().slice(0, 6)}`, ['maintenance_approver', 'operator'], w.siteId);
    const p = await prepared(a);
    expect(
      await attempt([
        ...p.pins,
        [`UPDATE tenant_memberships SET status = 'SUSPENDED' WHERE tenant_id = $1 AND user_id = $2`, [t(), a.userId]],
        p.pass,
      ]),
    ).toBe('UB201');
    // The data layer's suspension is that same row update.
    await setMembershipStatus(w.db.pool, w.admin, a.userId, 'SUSPENDED');
    expect(
      (
        await w.db.pool.query(`SELECT status FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`, [
          t(),
          a.userId,
        ])
      ).rows[0].status,
    ).toBe('SUSPENDED');
    expect(await attempt([...p.pins, p.pass])).toBe('UB201');
  });

  it('a revocation racing the PASSED commit: PASSED never commits on a revoked attester', async () => {
    const a = await person(w, `att-${randomUUID().slice(0, 6)}`, ['maintenance_approver', 'operator'], w.siteId);
    const p = await prepared(a);
    const revoker: pg.PoolClient = await w.db.pool.connect();
    const decider: pg.PoolClient = await w.db.pool.connect();
    try {
      // Revocation first (uncommitted): the decision must wait for it, then see it and refuse.
      await revoker.query('BEGIN');
      await revoker.query(revokeSql(a.userId)[0], revokeSql(a.userId)[1]);
      await decider.query('BEGIN');
      for (const [sql, prm] of p.pins) await decider.query(sql, prm);
      let settled = false;
      const decision = decider
        .query(p.pass[0], p.pass[1])
        .then(() => 'OK')
        .catch((e: { code?: string }) => e.code ?? 'ERROR')
        .finally(() => {
          settled = true;
        });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await revoker.query('COMMIT');
      expect(await decision).toBe('UB201');
    } finally {
      await decider.query('ROLLBACK').catch(() => {});
      await revoker.query('ROLLBACK').catch(() => {});
      decider.release();
      revoker.release();
    }
  });

  it('a decision holding the attester locks makes a racing revocation wait until it commits', async () => {
    const a = await person(w, `att-${randomUUID().slice(0, 6)}`, ['maintenance_approver', 'operator'], w.siteId);
    const p = await prepared(a);
    const revoker: pg.PoolClient = await w.db.pool.connect();
    const decider: pg.PoolClient = await w.db.pool.connect();
    try {
      await decider.query('BEGIN');
      for (const [sql, prm] of p.pins) await decider.query(sql, prm);
      await decider.query(p.pass[0], p.pass[1]);
      await revoker.query('BEGIN');
      let settled = false;
      const revocation = revoker.query(revokeSql(a.userId)[0], revokeSql(a.userId)[1]).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await decider.query('ROLLBACK');
      await revocation;
      await revoker.query('ROLLBACK');
    } finally {
      await decider.query('ROLLBACK').catch(() => {});
      await revoker.query('ROLLBACK').catch(() => {});
      decider.release();
      revoker.release();
    }
  });
});
