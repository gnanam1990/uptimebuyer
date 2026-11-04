// T-010 / T-011 re-run on the M07 surfaces (TEST-PLAN coverage rule): provider searches, service providers, contact
// requests/attempts, communications, quotes, provider webhooks, broker result events and notifications. Tenant A
// data and callbacks can never be read, inferred or changed from tenant B; denial is audited without leaking
// existence; every privileged M07 action is role- and site-scoped.
import { money, newId } from '@uptimebuyer/contracts';
import { createSite, listAuditEntries } from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executeContactRequest,
  getCommunication,
  getContactRequest,
  getProviderSearch,
  handleBrokerResultEvent,
  ingestProviderWebhook,
  listIncidentQuotes,
  prepareContactRequest,
  recordCommunication,
  recordConsent,
  recordQuote,
  runContactDispatch,
  runProviderSearch,
  signProviderWebhook,
} from '../src/index.js';
import {
  CountingBroker,
  brokerAttempt,
  brokerEvent,
  createProviderWorld,
  discover,
  fx,
  person,
  publishBrokerEvents,
  rejection,
  type Person,
  type ProviderWorld,
} from './helpers.js';

let a: ProviderWorld;
let b: ProviderWorld;
let ids: {
  searchId: string;
  requestId: string;
  attemptId: string;
  communicationId: string;
  serviceProviderId: string;
  clientOperationId: string;
};
let farOperator: Person;

const webhookBody = (o: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(o));

describe('T-010 / T-011 provider, contact, communication, quote and webhook scope', () => {
  beforeAll(async () => {
    a = await createProviderWorld('t010pa');
    b = await createProviderWorld('t010pb');
    const { search, byRef } = await discover(a);
    a.api.on('POST /v1/contact-requests', () => fx('contactAccepted'));
    const prepared = await prepareContactRequest(a.db.pool, a.operator.ctx, {
      incidentId: a.incident.incidentId,
      serviceProviderId: byRef['cl-001']!,
      providerAccountId: a.unpaid.providerAccountId,
      channel: 'API',
      purposeCode: 'QUOTE',
      idempotencyKey: a.key('p'),
    });
    await executeContactRequest(
      a.db.pool,
      a.operator.ctx,
      prepared.contactRequestId,
      { idempotencyKey: a.key('e') },
      {},
    );
    await runContactDispatch(a.db.pool, { adapters: a.adapters, credentials: a.creds, workerId: 't010' });
    const view = await getContactRequest(a.db.pool, a.operator.ctx, prepared.contactRequestId);
    await recordConsent(a.db.pool, a.operator.ctx, {
      contactRequestId: prepared.contactRequestId,
      consentKind: 'PROCESSING',
      purpose: 'EVIDENCE_REASONING',
      status: 'GRANTED',
      capturedVia: 'PROVIDER_API',
    });
    const comm = await recordCommunication(a.db.pool, a.operator.ctx, {
      contactAttemptId: view.attempts[0]!.contactAttemptId,
      direction: 'INBOUND',
      commType: 'API_MESSAGE',
      transcriptSource: 'ADAPTER_CAPTURE',
      sourceAdapterClass: 'SYNTHETIC_FIXTURE',
      recordingDisclosure: 'NOT_APPLICABLE',
      rawText: 'Callout 95.00 GBP, ETA 90 minutes.',
      observedAt: new Date().toISOString(),
    });
    ids = {
      searchId: search.searchId,
      requestId: prepared.contactRequestId,
      attemptId: view.attempts[0]!.contactAttemptId,
      communicationId: comm.communicationId,
      serviceProviderId: byRef['cl-001']!,
      clientOperationId: view.attempts[0]!.clientOperationId,
    };
    const depot = await createSite(a.db.pool, a.admin, { name: 'Depot', timezone: 'Europe/London', source: 'API' });
    farOperator = await person(a, 'far-op', ['operator'], depot.siteId);
  });
  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  it('T-010: tenant B cannot read or act on tenant A provider data, and denial does not leak existence', async () => {
    const B = b.operator.ctx;
    const probes: (() => Promise<unknown>)[] = [
      () => getProviderSearch(b.db.pool, B, ids.searchId),
      () => getContactRequest(b.db.pool, B, ids.requestId),
      () => getCommunication(b.db.pool, B, ids.communicationId),
      () => executeContactRequest(b.db.pool, B, ids.requestId, { idempotencyKey: b.key('x') }, {}),
      () =>
        recordQuote(b.db.pool, B, {
          contactRequestId: ids.requestId,
          sourceKind: 'OPERATOR_ENTRY',
          scopeKind: 'DIAGNOSTIC_VISIT',
          amount: money(1n, 'GBP'),
          taxMinor: null,
          etaMinutes: null,
          availabilityStatus: 'UNKNOWN',
          validUntil: null,
          sourceEvidence: { note: 'x' },
        }),
      () =>
        recordConsent(b.db.pool, B, {
          contactRequestId: ids.requestId,
          consentKind: 'PROCESSING',
          purpose: 'EVIDENCE_REASONING',
          status: 'GRANTED',
          capturedVia: 'OPERATOR_ATTESTED',
        }),
      () =>
        prepareContactRequest(b.db.pool, B, {
          incidentId: a.incident.incidentId,
          serviceProviderId: ids.serviceProviderId,
          providerAccountId: a.unpaid.providerAccountId,
          channel: 'API',
          purposeCode: 'QUOTE',
          idempotencyKey: b.key('p'),
        }),
      () =>
        runProviderSearch(
          b.db.pool,
          B,
          {
            incidentId: a.incident.incidentId,
            providerAccountId: a.unpaid.providerAccountId,
            query: { providerKinds: ['TECHNICIAN'], country: 'GB', postalCode: 'SW1A 1AA' },
            idempotencyKey: b.key('s'),
          },
          { adapters: b.adapters, credentials: b.creds },
        ),
    ];
    const nonexistent = await rejection(getContactRequest(b.db.pool, B, newId('providerContactRequest')));
    for (const p of probes) {
      const r = await rejection(p());
      expect(r).toEqual(nonexistent);
      expect(r).toMatchObject({ code: 'FORBIDDEN', reasonCode: 'RESOURCE_UNAVAILABLE' });
    }
    expect(await listIncidentQuotes(b.db.pool, B, b.incident.incidentId)).toEqual([]);
    const audit = await listAuditEntries(b.db.pool, b.admin, { limit: 500 });
    const denied = audit.filter((e) => e.result === 'DENIED');
    expect(denied.length).toBeGreaterThanOrEqual(probes.length);
    expect(JSON.stringify(denied)).not.toContain(ids.requestId);
  });

  it('T-010: a webhook resolves its tenant only from the endpoint binding; body fields cannot select a tenant', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const event = {
      eventId: 'evt-provider-1001',
      type: 'contact.status',
      clientOperationId: ids.clientOperationId,
      status: 'received',
      providerRef: 'cr-77801',
      observedAt: new Date().toISOString(),
    };
    const body = webhookBody(event);
    const sig = signProviderWebhook(a.verifierKey, ts, body);
    // Tenant B's binding with tenant A's operation id: signature is checked with B's verifier and fails.
    const crossed = await ingestProviderWebhook(
      b.db.pool,
      { binding: b.unpaid.webhookBinding, signature: sig, rawBody: body },
      { credentials: b.creds },
    );
    expect(crossed.status).toBe('REJECTED');
    // Re-signed with B's own key, the A operation id is simply not found in B's namespace (quarantined, no mutation).
    const reSigned = await ingestProviderWebhook(
      b.db.pool,
      { binding: b.unpaid.webhookBinding, signature: signProviderWebhook(b.verifierKey, ts, body), rawBody: body },
      { credentials: b.creds },
    );
    expect(reSigned).toMatchObject({ status: 'QUARANTINED', reasonCode: 'TARGET_NOT_FOUND' });
    // A body that names a tenant is a schema violation, not a routing input.
    const withTenant = webhookBody({ ...event, eventId: 'evt-provider-1002', tenantId: b.tenant.tenantId });
    const r = await ingestProviderWebhook(
      a.db.pool,
      {
        binding: a.unpaid.webhookBinding,
        signature: signProviderWebhook(a.verifierKey, ts, withTenant),
        rawBody: withTenant,
      },
      { credentials: a.creds },
    );
    expect(r).toMatchObject({ status: 'REJECTED', reasonCode: 'PAYLOAD_SCHEMA_INVALID' });
    const before = await getContactRequest(a.db.pool, a.operator.ctx, ids.requestId);
    expect(before.attempts[0]!.externalOutcomeState).toBe('ACCEPTED');
  });

  it('T-010: a broker result event for tenant A cannot mutate tenant B even when replayed under B', async () => {
    const broker = new CountingBroker();
    const xau = await broker.confirmedAuthority(a.tenant.tenantId);
    const fakeIntent = {
      commercialIntentId: newId('commercialIntent'),
      tenantId: b.tenant.tenantId,
      incidentId: b.incident.incidentId,
      assetRevisionId: b.nwr.assetRevisionId,
      subject: { type: 'PROVIDER_CONTACT_REQUEST' as const, id: ids.requestId },
      approvalId: newId('approval'),
      executionAuthorityId: xau,
      providerAccountRevisionId: a.paid.providerAccountRevisionId,
      actionDigest: `action.v1:sha256:${'a'.repeat(64)}`,
      maxAmount: money(1n, 'USD'),
      state: 'CREATED' as const,
      supersedesIntentId: null,
      version: 1,
      createdAt: new Date().toISOString(),
    };
    const [evt] = await publishBrokerEvents(
      b,
      [brokerEvent(fakeIntent as never, 'CREATED', 'RESERVED', brokerAttempt(), { version: 2 })],
      b.service,
    );
    expect(await handleBrokerResultEvent(b.db.pool, evt as never)).toBe('PROCESSED');
    const receipt = (
      await b.db.pool.query(
        `SELECT disposition, reason_code FROM provider_broker_event_receipts WHERE tenant_id = $1 AND event_id = $2`,
        [b.tenant.tenantId, evt!.eventId],
      )
    ).rows[0];
    expect(receipt).toEqual({ disposition: 'QUARANTINED', reason_code: 'UNKNOWN_INTENT' });
    // And the envelope cannot be redirected to tenant A.
    expect(
      (await rejection(handleBrokerResultEvent(a.db.pool, { ...evt, tenantId: a.tenant.tenantId } as never))).code,
    ).toBe('FORBIDDEN');
  });

  it('T-011: every privileged M07 action is role- and site-scoped', async () => {
    const pool = a.db.pool;
    const viewer = a.viewer.ctx;
    // Viewers read searches but cannot search, contact, consent or quote.
    await expect(getProviderSearch(pool, viewer, ids.searchId)).resolves.toBeDefined();
    const deniedForViewer: (() => Promise<unknown>)[] = [
      () =>
        runProviderSearch(
          pool,
          viewer,
          {
            incidentId: a.incident.incidentId,
            providerAccountId: a.unpaid.providerAccountId,
            query: { providerKinds: ['TECHNICIAN'], country: 'GB', postalCode: 'SW1A 1AA' },
            idempotencyKey: a.key('s'),
          },
          { adapters: a.adapters, credentials: a.creds },
        ),
      () =>
        prepareContactRequest(pool, viewer, {
          incidentId: a.incident.incidentId,
          serviceProviderId: ids.serviceProviderId,
          providerAccountId: a.unpaid.providerAccountId,
          channel: 'EMAIL',
          purposeCode: 'QUOTE',
          idempotencyKey: a.key('p'),
        }),
      () => executeContactRequest(pool, viewer, ids.requestId, { idempotencyKey: a.key('e') }, {}),
      () =>
        recordConsent(pool, viewer, {
          contactRequestId: ids.requestId,
          consentKind: 'PROCESSING',
          purpose: 'EVIDENCE_REASONING',
          status: 'GRANTED',
          capturedVia: 'OPERATOR_ATTESTED',
        }),
      () =>
        recordQuote(pool, viewer, {
          contactRequestId: ids.requestId,
          sourceKind: 'OPERATOR_ENTRY',
          scopeKind: 'DIAGNOSTIC_VISIT',
          amount: null,
          taxMinor: null,
          etaMinutes: null,
          availabilityStatus: 'UNKNOWN',
          validUntil: null,
          sourceEvidence: { note: 'x' },
        }),
      () => getCommunication(pool, viewer, ids.communicationId),
    ];
    for (const p of deniedForViewer) expect((await rejection(p())).code).toBe('FORBIDDEN');
    // An operator at another site of the same tenant is out of scope.
    expect((await rejection(getContactRequest(pool, farOperator.ctx, ids.requestId))).code).toBe('FORBIDDEN');
    expect(
      (await rejection(executeContactRequest(pool, farOperator.ctx, ids.requestId, { idempotencyKey: a.key('e') }, {})))
        .code,
    ).toBe('FORBIDDEN');
    // Operators can record a manual quote; it never carries approval authority.
    const q = await recordQuote(pool, a.operator.ctx, {
      contactRequestId: ids.requestId,
      sourceKind: 'OPERATOR_ENTRY',
      scopeKind: 'DIAGNOSTIC_VISIT',
      amount: money(9_500n, 'GBP'),
      taxMinor: null,
      etaMinutes: 90,
      availabilityStatus: 'AVAILABLE',
      validUntil: null,
      sourceEvidence: { note: 'phoned dispatcher' },
    });
    expect(q).toMatchObject({ authority: 'NONE', compatibilityApproved: false, missingFields: ['tax', 'validity'] });
    // Services and workers act through the engine only; humans cannot.
    expect((await rejection(getCommunication(pool, a.service, ids.communicationId))).code).toBe('FORBIDDEN');
  });
});
