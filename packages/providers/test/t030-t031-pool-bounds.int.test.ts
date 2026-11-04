// T-030 / T-031 pool-bound regressions (coordinator review): serialization locks must never hold one pooled
// connection while waiting for another. With a 2-connection pool, more concurrent excerpt promotions (racing a
// consent withdrawal) and more concurrent paid hand-offs than the pool size all complete within the test bound, the
// withdrawal still wins atomically, and exactly one broker-port intent request is made.
import { money } from '@uptimebuyer/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executeContactRequest,
  getContactRequest,
  prepareContactRequest,
  promoteExcerptToEvidence,
  recordCommunication,
  recordConsent,
  runContactDispatch,
} from '../src/index.js';
import {
  CountingBroker,
  approvePaidContact,
  createProviderWorld,
  discover,
  fx,
  pointOf,
  type ProviderWorld,
} from './helpers.js';

let w: ProviderWorld;
let small: pg.Pool;

describe('T-030 / T-031 serialization under a bounded connection pool', () => {
  beforeAll(async () => {
    w = await createProviderWorld('poolb');
    small = new pg.Pool({ connectionString: w.db.url, max: 2 });
  });
  afterAll(async () => {
    await small?.end();
    await w?.close();
  });

  it(
    'promotions above pool size complete and a racing withdrawal still leaves no active document',
    { timeout: 30_000 },
    async () => {
      const { byRef } = await discover(w);
      w.api.on('POST /v1/contact-requests', () => fx('contactAccepted'));
      const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
        incidentId: w.incident.incidentId,
        serviceProviderId: byRef['cl-001']!,
        contactPointId: pointOf(byRef['cl-001']!, 'API'),
        providerAccountId: w.unpaid.providerAccountId,
        channel: 'API',
        purposeCode: 'QUOTE',
        idempotencyKey: w.key('p'),
      });
      await executeContactRequest(
        w.db.pool,
        w.operator.ctx,
        prepared.contactRequestId,
        { idempotencyKey: w.key('e') },
        {},
      );
      await runContactDispatch(w.db.pool, { adapters: w.adapters, credentials: w.creds, workerId: 'poolb' });
      const attempt = (await getContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId)).attempts[0]!;
      const comms = [];
      for (let i = 0; i < 6; i++)
        comms.push(
          await recordCommunication(w.db.pool, w.operator.ctx, {
            contactAttemptId: attempt.contactAttemptId,
            direction: 'INBOUND',
            commType: 'API_MESSAGE',
            transcriptSource: 'ADAPTER_CAPTURE',
            recordingDisclosure: 'NOT_APPLICABLE',
            rawText: `Callout ${300 + i}.00 GBP, ETA ${i + 1} hours.`,
            observedAt: new Date().toISOString(),
          }),
        );
      const first = await Promise.all(
        comms
          .slice(0, 3)
          .map((c) => promoteExcerptToEvidence(small, w.operator.ctx, w.store, { communicationId: c.communicationId })),
      );
      expect(first).toHaveLength(3);
      const outcomes = await Promise.allSettled([
        ...comms
          .slice(3)
          .map((c) => promoteExcerptToEvidence(small, w.operator.ctx, w.store, { communicationId: c.communicationId })),
        recordConsent(small, w.service, {
          contactRequestId: prepared.contactRequestId,
          consentKind: 'PROCESSING',
          purpose: 'EVIDENCE_REASONING',
          status: 'WITHDRAWN',
          capturedVia: 'PROVIDER_API',
        }),
      ]);
      expect(outcomes.at(-1)!.status).toBe('fulfilled');
      for (const o of outcomes.slice(0, -1))
        if (o.status === 'rejected')
          expect(o.reason).toMatchObject({ details: { reasonCode: 'PROCESSING_CONSENT_REQUIRED' } });
      const { rows } = await w.db.pool.query(
        `SELECT count(*)::int AS n FROM evidence_documents d
        WHERE d.tenant_id = $1 AND d.consent_ref IN (SELECT id FROM provider_consents WHERE tenant_id = $1
                AND contact_request_id = $2 AND consent_kind = 'PROCESSING')
          AND NOT EXISTS (SELECT 1 FROM evidence_document_events e WHERE e.tenant_id = d.tenant_id AND e.document_id = d.id)`,
        [w.tenant.tenantId, prepared.contactRequestId],
      );
      expect(rows[0].n).toBe(0);
      // Every pooled connection came back usable and unlocked.
      const locks = await w.db.pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`);
      expect(locks.rows[0].n).toBe(0);
    },
  );

  it('paid hand-offs above pool size complete with one broker-port intent request', { timeout: 30_000 }, async () => {
    const { byRef } = await discover(w);
    const broker = new CountingBroker();
    const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: byRef['cl-001']!,
      contactPointId: pointOf(byRef['cl-001']!, 'PHONE'),
      providerAccountId: w.paid.providerAccountId,
      channel: 'PHONE',
      purposeCode: 'AVAILABILITY',
      paid: { merchantId: 'mer_stablephone-0001', maxCost: money(800n, 'USD') },
      idempotencyKey: w.key('pp'),
    });
    const approval = await approvePaidContact(w, prepared);
    const xau = await broker.confirmedAuthority(w.tenant.tenantId);
    const runs = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        executeContactRequest(
          small,
          w.operator.ctx,
          prepared.contactRequestId,
          { idempotencyKey: w.key('e'), authority: { approvalId: approval.approvalId, executionAuthorityId: xau } },
          { broker },
        ),
      ),
    );
    expect(new Set(runs.map((r) => r.attempt.commercialIntentId)).size).toBe(1);
    expect(broker.calls.createIntent).toHaveLength(1);
    expect(broker.calls.execute).toBe(1);
    const locks = await w.db.pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`);
    expect(locks.rows[0].n).toBe(0);
  });
});
