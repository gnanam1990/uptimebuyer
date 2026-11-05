// T-053 FR-23 / INV-10 / NFR-06 — retention, legal hold, export and erasure per tenant. Raw fulfillment-webhook bodies
// (M10, including the transient copy in job payloads) and raw CMMS record bodies (M11) are erased by a retention sweep
// once the tenant's RETENTION policy window passes, or by an executed DELETION privacy request; an active legal hold
// blocks both (also at the database), erasure leaves a non-sensitive tombstone plus a legal audit record, and the
// evidence ledger hash chain, evidence seals and recovery decisions stay byte-for-byte reproducible. Tests age rows by
// briefly suspending the append-only stamp trigger as the database owner (test-only manipulation; product code has no
// clock override). Encryption posture is reported honestly (the local database connection is plaintext).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPrivacyRequest,
  executePrivacyRequest,
  exportEvidenceLedger,
  placeLegalHold,
  publishPolicyRevision,
  releaseLegalHold,
  runRetentionSweep,
  sha256Digest,
} from '@uptimebuyer/data';
import { getRecoveryStatus } from '@uptimebuyer/recovery';
import { checkEncryptionPosture } from '@uptimebuyer/operations';
import { evidenceSealValid } from '../../../packages/recovery/src/evidence.js';
import { seedTenant } from '../../../packages/data/test/helpers.js';
import {
  createRecoveryWorld,
  recoveredIncident,
  verifyingIncident,
  milestoneAt,
  dbNowMs,
  type RecoveryWorld,
} from './m11-helpers.js';

let w: RecoveryWorld;
const RETENTION = { telemetryDays: 30, communicationDays: 30, auditDays: 365, fulfillmentRawDays: 7, cmmsRawDays: 14 };

const q = (sql: string, params: unknown[] = []) => w.db.pool.query(sql, [w.tenant.tenantId, ...params]);
/** Age every row of `table` matching `where` by `days` (owner-only test manipulation of the stamp columns). */
async function age(table: string, where: string, params: unknown[], days: number) {
  const trig = `${table}_guard`;
  const c = await w.db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trig}`);
    await c.query(
      `UPDATE ${table} SET recorded_at = recorded_at - make_interval(days => $2) WHERE tenant_id = $1 AND ${where}`,
      [w.tenant.tenantId, days, ...params],
    );
    await c.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trig}`);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}
const observationsOf = (orderId: string) =>
  q(
    `SELECT * FROM fulfillment_observations WHERE tenant_id = $1 AND (purchase_order_id = $2 OR service_job_id = $2) ORDER BY recorded_at`,
    [orderId],
  ).then((r) => r.rows);
const cmmsOf = (incidentId: string) =>
  q(`SELECT * FROM recovery_evidence WHERE tenant_id = $1 AND incident_id = $2 AND source_kind = 'CMMS'`, [
    incidentId,
  ]).then((r) => r.rows);
const jobsOf = (orderId: string) =>
  q(
    `SELECT * FROM jobs WHERE tenant_id = $1 AND kind = 'orders.fulfillment_observation' AND payload->>'orderId' = $2`,
    [orderId],
  ).then((r) => r.rows);
const tombstones = () =>
  q(`SELECT * FROM redaction_tombstones WHERE tenant_id = $1 ORDER BY redacted_at, id`).then((r) => r.rows);

let first: Awaited<ReturnType<typeof recoveredIncident>>;
let second: Awaited<ReturnType<typeof verifyingIncident>>;

beforeAll(async () => {
  w = await createRecoveryWorld('t053fr23');
  first = await recoveredIncident(w);
  expect(first.r.outcome).toBe('PASSED');
  second = await verifyingIncident(w);
  await milestoneAt(w, second, (await dbNowMs(w)) + 5_000);
  await publishPolicyRevision(w.db.pool, w.admin, { policyKey: 'RETENTION', body: RETENTION, source: 'API' });
});
afterAll(async () => {
  await w?.close();
});

describe('T-053 FR-23 retention sweep', () => {
  it('scrubs only the transient job copies of raw bodies while nothing is past retention', async () => {
    expect((await observationsOf(first.inc.orderId)).every((o) => o.raw_body !== null)).toBe(true);
    expect((await jobsOf(first.inc.orderId)).some((j) => typeof j.payload.rawBody === 'string')).toBe(true);
    const r = await runRetentionSweep(w.db.pool, w.service);
    expect(r.erased).toEqual({ fulfillment_observations: 0, recovery_evidence: 0, provider_communication_bodies: 0 });
    expect(r.scrubbedJobs).toBeGreaterThanOrEqual(3);
    for (const j of await jobsOf(first.inc.orderId)) {
      expect(j.payload.rawBody).toBeUndefined();
      expect(j.payload.rawBodyErased).toBe(true);
      expect(j.payload.rawBodyDigest).toMatch(/^sha256:/);
    }
    expect((await observationsOf(first.inc.orderId)).every((o) => o.raw_body !== null)).toBe(true);
  });

  it('erases expired raw bodies, skips legally held ones, and keeps ledger, seals and decisions reproducible', async () => {
    const hold = await placeLegalHold(w.db.pool, w.admin, {
      scopeType: 'INCIDENT',
      scopeId: second.incidentId,
      reasonCode: 'LITIGATION',
    });
    for (const inc of [first.inc, second]) {
      await age('fulfillment_observations', '(purchase_order_id = $3 OR service_job_id = $3)', [inc.orderId], 8);
      await age('recovery_evidence', 'incident_id = $3', [inc.incidentId], 15);
    }
    const ledgerBefore = await exportEvidenceLedger(w.db.pool, w.admin);
    const statusBefore = await getRecoveryStatus(w.db.pool, w.admin, first.inc.incidentId);
    const obsBefore = await observationsOf(first.inc.orderId);

    const r = await runRetentionSweep(w.db.pool, w.service);
    expect(r.erased.fulfillment_observations).toBe(obsBefore.filter((o) => o.raw_body !== null).length);
    expect(r.erased.recovery_evidence).toBeGreaterThanOrEqual(1);
    expect(r.heldSkipped).toBeGreaterThanOrEqual(2);

    for (const o of await observationsOf(first.inc.orderId)) {
      expect(o.raw_body).toBeNull();
      expect(o.raw_body_erased_at).not.toBeNull();
      expect(o.raw_body_digest).toMatch(/^sha256:/);
    }
    for (const e of await cmmsOf(first.inc.incidentId)) {
      expect(e.body).toEqual({ erased: true });
      expect(e.body_erased_at).not.toBeNull();
      expect(evidenceSealValid(w.recoverySigning, e)).toBe(true);
    }
    // The held incident's raw bodies are untouched.
    expect((await observationsOf(second.orderId)).every((o) => o.raw_body !== null)).toBe(true);
    expect((await cmmsOf(second.incidentId)).every((e) => e.body_erased_at === null)).toBe(true);

    const ts = await tombstones();
    const retention = ts.filter((t) => t.basis === 'RETENTION_EXPIRED');
    expect(retention.length).toBe(r.erased.fulfillment_observations + r.erased.recovery_evidence);
    for (const t of retention) {
      expect(t.privacy_request_id).toBeNull();
      expect(t.retention_policy_revision_id).toMatch(/^pol_/);
      expect(t.erased_digest).toMatch(/^sha256:/);
      expect(Object.keys(t)).not.toContain('raw_body');
    }
    const ledgerAfter = await exportEvidenceLedger(w.db.pool, w.admin);
    expect(ledgerAfter.chain).toEqual({ ok: true });
    expect(ledgerAfter.entries.slice(0, ledgerBefore.entries.length)).toEqual(ledgerBefore.entries);
    expect(await getRecoveryStatus(w.db.pool, w.admin, first.inc.incidentId)).toEqual(statusBefore);
    expect(statusBefore.incidentState).toBe('RECOVERED');
    const audit = await q(
      `SELECT result FROM audit_entries WHERE tenant_id = $1 AND action = 'privacy.retention_sweep' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.result).toBe('SUCCEEDED');
    // Idempotent: a second sweep erases nothing more.
    const again = await runRetentionSweep(w.db.pool, w.service);
    expect(again.erased).toEqual({
      fulfillment_observations: 0,
      recovery_evidence: 0,
      provider_communication_bodies: 0,
    });
    await releaseLegalHold(w.db.pool, w.admin, hold.legalHoldId);
  });

  it('the database permits only the one erasure transition and refuses erasure under an active hold', async () => {
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'OK',
        (e: { code?: string }) => e.code,
      );
    const erased = (await observationsOf(first.inc.orderId))[0]!;
    expect(
      await code(
        q(`UPDATE fulfillment_observations SET raw_status = 'x' WHERE tenant_id = $1 AND id = $2`, [erased.id]),
      ),
    ).toBe('UB001');
    expect(
      await code(
        q(`UPDATE fulfillment_observations SET raw_body = '\\x00' WHERE tenant_id = $1 AND id = $2`, [erased.id]),
      ),
    ).toBe('UB001');
    expect(
      await code(q(`DELETE FROM recovery_evidence WHERE tenant_id = $1 AND incident_id = $2`, [first.inc.incidentId])),
    ).toBe('UB001');
    const hold = await placeLegalHold(w.db.pool, w.admin, {
      scopeType: 'ASSET',
      scopeId: second.assetId,
      reasonCode: 'REGULATOR',
    });
    const target = (await observationsOf(second.orderId))[0]!;
    const tomb = await q(
      `INSERT INTO redaction_tombstones (tenant_id, id, target_table, target_id, reason_code, basis, retention_policy_revision_id)
       SELECT $1, 'rdt_' || gen_random_uuid(), 'fulfillment_observations', $2, 'RETENTION_EXPIRED', 'RETENTION_EXPIRED', r.id
         FROM policy_revisions r JOIN policies p ON p.tenant_id = r.tenant_id AND p.id = r.policy_id
        WHERE r.tenant_id = $1 AND p.policy_key = 'RETENTION' LIMIT 1 RETURNING id`,
      [target.id],
    );
    expect(
      await code(
        q(
          `UPDATE fulfillment_observations SET raw_body = NULL, raw_body_erased_at = clock_timestamp(), raw_body_erasure_id = $3
            WHERE tenant_id = $1 AND id = $2`,
          [target.id, tomb.rows[0].id],
        ),
      ),
    ).toBe('UB132');
    await releaseLegalHold(w.db.pool, w.admin, hold.legalHoldId);
  });
});

describe('T-053 FR-23 privacy requests', () => {
  it('a hold placed after the request blocks execution; after release the deletion erases and tombstones', async () => {
    const subject = sha256Digest(`contact:${second.incidentId}`);
    const req = await createPrivacyRequest(w.db.pool, w.admin, {
      requestType: 'DELETION',
      subjectKind: 'CONTACT',
      subjectRefDigest: subject,
      scopeType: 'INCIDENT',
      scopeId: second.incidentId,
    });
    expect(req.state).toBe('RECEIVED');
    const hold = await placeLegalHold(w.db.pool, w.admin, {
      scopeType: 'SITE',
      scopeId: w.siteId,
      reasonCode: 'AUDIT',
    });
    const blocked = await executePrivacyRequest(w.db.pool, w.admin, req.privacyRequestId);
    expect(blocked.state).toBe('BLOCKED_LEGAL_HOLD');
    expect((await observationsOf(second.orderId)).every((o) => o.raw_body !== null)).toBe(true);
    await releaseLegalHold(w.db.pool, w.admin, hold.legalHoldId);
    const done = await executePrivacyRequest(w.db.pool, w.admin, req.privacyRequestId);
    expect(done.state).toBe('COMPLETED');
    expect(done.erased.fulfillment_observations).toBeGreaterThanOrEqual(3);
    expect(done.erased.recovery_evidence).toBeGreaterThanOrEqual(1);
    expect((await observationsOf(second.orderId)).every((o) => o.raw_body === null)).toBe(true);
    const ts = (await tombstones()).filter((t) => t.privacy_request_id === req.privacyRequestId);
    expect(ts.length).toBe(done.erased.fulfillment_observations + done.erased.recovery_evidence);
    expect(ts.every((t) => t.basis === 'PRIVACY_REQUEST')).toBe(true);
    const again = await executePrivacyRequest(w.db.pool, w.admin, req.privacyRequestId);
    expect(again.state).toBe('COMPLETED');
    expect((await tombstones()).filter((t) => t.privacy_request_id === req.privacyRequestId).length).toBe(ts.length);
    const row = (await q(`SELECT state FROM privacy_requests WHERE tenant_id = $1 AND id = $2`, [req.privacyRequestId]))
      .rows[0];
    expect(row.state).toBe('COMPLETED');
  });

  it('an export request returns a minimized manifest by digest, never raw content', async () => {
    const req = await createPrivacyRequest(w.db.pool, w.admin, {
      requestType: 'EXPORT',
      subjectKind: 'CONTACT',
      subjectRefDigest: sha256Digest('contact:export'),
      scopeType: 'TENANT',
      scopeId: w.tenant.tenantId,
    });
    const out = await executePrivacyRequest(w.db.pool, w.admin, req.privacyRequestId);
    expect(out.state).toBe('COMPLETED');
    const items = out.manifest!.items;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(Object.keys(i).sort()).toEqual(['digest', 'erased', 'recordedAt', 'targetId', 'targetTable']);
      expect(i.digest).toMatch(/^sha256:/);
    }
    expect(JSON.stringify(out)).not.toMatch(/clientOperationId|eventId|technicianRef|serial/);
  });

  it('only an administrator of the same tenant can execute, and another tenant sweep never touches these rows', async () => {
    const req = await createPrivacyRequest(w.db.pool, w.admin, {
      requestType: 'DELETION',
      subjectKind: 'CONTACT',
      subjectRefDigest: sha256Digest('contact:x'),
      scopeType: 'INCIDENT',
      scopeId: first.inc.incidentId,
    });
    await expect(executePrivacyRequest(w.db.pool, w.operator, req.privacyRequestId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const other = await seedTenant(w.db.pool, w.idp, 't053fr23-other');
    await expect(executePrivacyRequest(w.db.pool, other.admin, req.privacyRequestId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const before = (await tombstones()).length;
    await runRetentionSweep(w.db.pool, other.admin);
    expect((await tombstones()).length).toBe(before);
    await expect(runRetentionSweep(w.db.pool, w.operator)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('T-053 NFR-06 encryption posture is reported, never assumed', () => {
  it('reports the database transport truthfully and leaves at-rest and backups NOT_RUN locally', async () => {
    const p = await checkEncryptionPosture(w.db.pool);
    expect(['TLS', 'PLAINTEXT']).toContain(p.database.inTransit);
    expect(p.database.atRest).toBe('NOT_VERIFIABLE_FROM_SQL');
    expect(p.objectStore).toBe('NOT_RUN');
    expect(p.backups).toBe('NOT_RUN');
    const local = new URL(process.env.DATABASE_URL!).hostname;
    if (['localhost', '127.0.0.1'].includes(local)) expect(p.database.inTransit).toBe('PLAINTEXT');
  });
});
