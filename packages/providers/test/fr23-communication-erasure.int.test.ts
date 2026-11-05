// FR-23 / T-053 for raw provider communications (M07): the retention sweep erases a raw transcript body once the
// tenant's communicationDays window passes, an executed COMMUNICATION deletion request erases bodies in its scope, an
// active legal hold blocks both (also in the database), and each erasure leaves a non-sensitive tombstone while the
// redacted communication row and its digests stay. Rows are aged by briefly suspending the communication row's
// append-only trigger as the database owner (test-only); product code has no clock override.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPrivacyRequest,
  executePrivacyRequest,
  placeLegalHold,
  publishPolicyRevision,
  releaseLegalHold,
  runRetentionSweep,
  sha256Digest,
} from '@uptimebuyer/data';
import {
  executeContactRequest,
  getContactRequest,
  prepareContactRequest,
  recordCommunication,
  recordConsent,
  runContactDispatch,
} from '../src/index.js';
import { createProviderWorld, discover, pointOf, type ProviderWorld } from './helpers.js';

let w: ProviderWorld;
let attemptId: string;
let requestId: string;

const body = async (communicationId: string) =>
  (
    await w.db.pool.query(
      `SELECT raw_text, erased_at, erasure_reason FROM provider_communication_bodies WHERE communication_id = $1`,
      [communicationId],
    )
  ).rows[0];
async function ageCommunication(communicationId: string, days: number) {
  const c = await w.db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE provider_communications DISABLE TRIGGER provider_communications_no_update');
    await c.query(
      `UPDATE provider_communications SET recorded_at = recorded_at - make_interval(days => $2) WHERE id = $1`,
      [communicationId, days],
    );
    await c.query('ALTER TABLE provider_communications ENABLE TRIGGER provider_communications_no_update');
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}
const record = async (text: string) =>
  (
    await recordCommunication(w.db.pool, w.operator.ctx, {
      contactAttemptId: attemptId,
      direction: 'INBOUND',
      commType: 'PHONE_TRANSCRIPT',
      transcriptSource: 'PROVIDER_TRANSCRIPTION',
      recordingDisclosure: 'GIVEN',
      rawText: text,
      observedAt: new Date(Date.now() - 1_000).toISOString(),
    })
  ).communicationId;

beforeAll(async () => {
  w = await createProviderWorld('fr23comm');
  const { byRef } = await discover(w);
  const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
    incidentId: w.incident.incidentId,
    serviceProviderId: byRef['cl-001']!,
    contactPointId: pointOf(byRef['cl-001']!, 'PHONE'),
    providerAccountId: w.unpaid.providerAccountId,
    channel: 'PHONE',
    purposeCode: 'QUOTE',
    idempotencyKey: w.key('prep'),
  });
  requestId = prepared.contactRequestId;
  await executeContactRequest(w.db.pool, w.operator.ctx, requestId, { idempotencyKey: w.key('e') }, {});
  await runContactDispatch(w.db.pool, { adapters: w.adapters, credentials: w.creds, workerId: 'fr23' });
  attemptId = (await getContactRequest(w.db.pool, w.operator.ctx, requestId)).attempts[0]!.contactAttemptId;
  await recordConsent(w.db.pool, w.operator.ctx, {
    contactRequestId: requestId,
    consentKind: 'RECORDING',
    purpose: 'QUOTE_RECORDING',
    status: 'GRANTED',
    capturedVia: 'PHONE_DISCLOSURE_ACK',
    disclosureText: 'This call is recorded for quality and quoting purposes.',
    sourceAttemptId: attemptId,
  });
  await publishPolicyRevision(w.db.pool, w.admin, {
    policyKey: 'RETENTION',
    body: { telemetryDays: 30, communicationDays: 10, auditDays: 365 },
    source: 'API',
  });
});
afterAll(async () => {
  await w?.close();
});

describe('FR-23 raw communication retention and erasure', () => {
  it('the sweep erases an expired transcript body (tombstoned) and keeps unexpired and held ones', async () => {
    const expired = await record('Technician: my direct line is +44 7700 900123; call-out fee 185.00 GBP.');
    const fresh = await record('Technician: ETA two hours.');
    await ageCommunication(expired, 11);
    const r = await runRetentionSweep(w.db.pool, w.admin);
    expect(r.erased.provider_communication_bodies).toBe(1);
    expect(await body(expired)).toMatchObject({ raw_text: null, erasure_reason: 'RETENTION_EXPIRED' });
    expect((await body(fresh)).raw_text).not.toBeNull();
    const t = (
      await w.db.pool.query(`SELECT * FROM redaction_tombstones WHERE target_table = 'provider_communication_bodies'`)
    ).rows;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ basis: 'RETENTION_EXPIRED', privacy_request_id: null });
    const held = await record('Technician: held transcript.');
    await ageCommunication(held, 11);
    const hold = await placeLegalHold(w.db.pool, w.admin, {
      scopeType: 'INCIDENT',
      scopeId: w.incident.incidentId,
      reasonCode: 'LITIGATION',
    });
    const r2 = await runRetentionSweep(w.db.pool, w.admin);
    expect(r2.erased.provider_communication_bodies).toBe(0);
    expect(r2.heldSkipped).toBeGreaterThanOrEqual(1);
    expect((await body(held)).raw_text).not.toBeNull();
    // The database refuses the erasure transition itself under the hold.
    const code = await w.db.pool
      .query(
        `UPDATE provider_communication_bodies SET raw_text = NULL, erased_at = clock_timestamp(), erasure_reason = 'MANUAL'
          WHERE communication_id = $1`,
        [held],
      )
      .then(
        () => 'OK',
        (e: { code?: string }) => e.code,
      );
    expect(code).toBe('UB132');
    await releaseLegalHold(w.db.pool, w.admin, hold.legalHoldId);
  });

  it('a COMMUNICATION deletion request erases bodies in its scope and leaves the redacted record', async () => {
    const id = await record('Technician: please call me back on +44 7700 900456.');
    const req = await createPrivacyRequest(w.db.pool, w.admin, {
      requestType: 'DELETION',
      subjectKind: 'COMMUNICATION',
      subjectRefDigest: sha256Digest(`communication:${id}`),
      scopeType: 'INCIDENT',
      scopeId: w.incident.incidentId,
    });
    const out = await executePrivacyRequest(w.db.pool, w.admin, req.privacyRequestId);
    expect(out.state).toBe('COMPLETED');
    expect(out.erased.provider_communication_bodies).toBeGreaterThanOrEqual(1);
    expect(await body(id)).toMatchObject({ raw_text: null, erasure_reason: 'PRIVACY_REQUEST' });
    const comm = (await w.db.pool.query(`SELECT * FROM provider_communications WHERE id = $1`, [id])).rows[0];
    expect(comm.redacted_text ?? comm.redacted_excerpt ?? '').not.toContain('900456');
  });
});
