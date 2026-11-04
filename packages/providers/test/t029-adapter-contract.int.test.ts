// T-029 — Live-shaped provider adapter contract (FR-07, FR-08, NFR-04, NFR-11, INV-06, INV-12).
// Tenant-bound immutable provider-account capability revisions route unpaid revisions only to M07 adapters and hand
// paid revisions only to the M01 commercial-intent broker port (CONTRACT FAKE; the real broker is re-asserted by
// T-039 in M09). Every M07 request/attempt and every broker-port intent request pins the exact revision;
// supersession invalidates unexecuted work without rewriting in-flight history. Synthetic live-shaped sandbox
// responses exercise search, contact, quote, pagination, price, availability, consent, rate-limit and error schemas;
// the real connectivity probe stays NOT_RUN.
import { money } from '@uptimebuyer/contracts';
import { appendProviderAccountRevision, getApprovalStatus } from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executeContactRequest,
  getContactRequest,
  getProviderSearch,
  invalidateSupersededContactWork,
  linkApprovedVendor,
  listIncidentQuotes,
  prepareContactRequest,
  reconcileContactAttempt,
  runContactDispatch,
  runProviderSearch,
  endpointPolicyDigest,
  FixtureProviderTransport,
  StaticAdapterRegistry,
  StructuredProviderApiAdapter,
} from '../src/index.js';
import {
  COLDLINE_POLICY,
  CountingBroker,
  approvePaidContact,
  count,
  createProviderWorld,
  discover,
  fx,
  providerAccount,
  rejection,
  type ProviderWorld,
} from './helpers.js';
import { recordRegistryEdit } from '@uptimebuyer/data';

let w: ProviderWorld;
const dispatch = () => runContactDispatch(w.db.pool, { adapters: w.adapters, credentials: w.creds, workerId: 't029' });

describe('T-029 live-shaped provider adapter contract', () => {
  beforeAll(async () => {
    w = await createProviderWorld('t029');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('paginates a bounded search, normalizes identity/area/availability/price/ETA and pins the exact revision', async () => {
    const { search } = await discover(w);
    expect(search.state).toBe('COMPLETED');
    expect(search.pagesFetched).toBe(2);
    expect(search.providerAccountRevisionId).toBe(w.unpaid.providerAccountRevisionId);
    expect(search.adapterClass).toBe('SYNTHETIC_FIXTURE');
    expect(search.results.map((r) => r.discovery.externalRef)).toEqual(['cl-001', 'fr-207', 'nw-330']);
    const [coldline, frostfix, northwind] = search.results;
    expect(coldline!.provider).toMatchObject({
      displayName: 'Coldline Service Co',
      normalizedName: 'coldline service co',
      country: 'GB',
      postalCode: 'SW1A1AA',
      websiteDomain: 'coldline.example',
    });
    expect(frostfix!.provider.normalizedName).toBe('frostfix refrigeration ltd');
    expect(coldline!.price).toEqual({ amount: money(9_500n, 'GBP'), basis: 'CALLOUT' });
    expect(frostfix!.price).toBeNull();
    expect(coldline!.availability).toEqual({ status: 'AVAILABLE', nextWindowAt: '2026-11-05T14:00:00.000Z' });
    expect(northwind!.availability.status).toBe('UNAVAILABLE');
    expect(coldline!.etaMinutes).toBe(90);
    expect(coldline!.serviceAreaMatch).toBe('IN_AREA');
    expect(frostfix!.serviceAreaMatch).toBe('OUT_OF_AREA');
    // The adapter received the pinned revision on every page call.
    const pages = w.api.requests.filter((r) => r.path === '/v1/providers');
    expect(pages).toHaveLength(2);
    expect(new Set(pages.map((r) => r.context.providerAccountRevisionId))).toEqual(
      new Set([w.unpaid.providerAccountRevisionId]),
    );
    expect(pages[1]!.query.cursor).toBe('page-2');
    // Contact values are never part of the search view.
    expect(JSON.stringify(search, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(
      'dispatch@coldline.example',
    );
    expect(await count(w, 'outbox_events', `event_type = 'provider.search_completed.v1'`)).toBeGreaterThanOrEqual(1);
  });

  it('keeps discovery source and approved-vendor status separate; rank never approves', async () => {
    const { search, byRef } = await discover(w);
    for (const r of search.results) {
      expect(r.rankAuthority).toBe('NONE');
      expect(r.vendorApproval.status).toBe('UNKNOWN');
      expect(r.discovery.sourceKind).toBe('PROVIDER_API');
    }
    const vendor = await recordRegistryEdit(w.db.pool, w.admin, {
      entityKind: 'APPROVED_VENDOR',
      entityId: null,
      body: { vendorName: 'Coldline Service Co', status: 'APPROVED', siteIds: [w.siteId] },
      source: 'API',
    });
    const linked = await linkApprovedVendor(w.db.pool, w.admin, {
      serviceProviderId: byRef['cl-001']!,
      vendorId: vendor.entityId,
    });
    expect(linked.approvedVendorStatus).toBe('APPROVED');
    const again = await getProviderSearch(w.db.pool, w.viewer.ctx, search.searchId);
    const c = again.results.find((r) => r.discovery.externalRef === 'cl-001')!;
    expect(c.vendorApproval).toMatchObject({ status: 'APPROVED', vendorId: vendor.entityId });
    expect(c.discovery.sourceKind).toBe('PROVIDER_API');
    // Rank 1 elsewhere is not approval.
    expect(again.results.find((r) => r.discovery.externalRef === 'fr-207')!.vendorApproval.status).toBe('UNKNOWN');
    // A search never rewrites the approval projection.
    await discover(w);
    const after = await getProviderSearch(w.db.pool, w.viewer.ctx, search.searchId);
    expect(after.results.find((r) => r.discovery.externalRef === 'cl-001')!.vendorApproval.status).toBe('APPROVED');
    // Operators cannot link vendors (admin only).
    expect(
      (
        await rejection(
          linkApprovedVendor(w.db.pool, w.operator.ctx, {
            serviceProviderId: byRef['cl-001']!,
            vendorId: vendor.entityId,
          }),
        )
      ).code,
    ).toBe('FORBIDDEN');
  });

  it('classifies rate-limit and provider-error schemas explicitly (no tight retry, no fabricated results)', async () => {
    const api = w.api;
    api.on('GET /v1/providers', (req) => (req.query.cursor === 'page-2' ? fx('rateLimited') : fx('first')));
    const partial = await runProviderSearch(
      w.db.pool,
      w.operator.ctx,
      {
        incidentId: w.incident.incidentId,
        providerAccountId: w.unpaid.providerAccountId,
        query: { providerKinds: ['TECHNICIAN'], country: 'GB', postalCode: 'SW1A 1AA' },
        bounds: { maxResults: 10, maxPages: 3, timeoutMs: 2_000 },
        idempotencyKey: w.key('search-429'),
      },
      { adapters: w.adapters, credentials: w.creds },
    );
    expect(partial.state).toBe('PARTIAL');
    expect(partial.stateReason).toBe('RATE_LIMITED');
    expect(partial.retryAfterMs).toBe(30_000);
    expect(partial.results).toHaveLength(2);

    api.on('GET /v1/providers', () => fx('providerError'));
    const failed = await runProviderSearch(
      w.db.pool,
      w.operator.ctx,
      {
        incidentId: w.incident.incidentId,
        providerAccountId: w.unpaid.providerAccountId,
        query: { providerKinds: ['TECHNICIAN'], country: 'GB', postalCode: 'SW1A 1AA' },
        bounds: { maxResults: 10, maxPages: 3, timeoutMs: 2_000 },
        idempotencyKey: w.key('search-503'),
      },
      { adapters: w.adapters, credentials: w.creds },
    );
    expect(failed.state).toBe('FAILED');
    expect(failed.stateReason).toBe('PROVIDER_ERROR');
    expect(failed.results).toHaveLength(0);

    api.on('GET /v1/providers', () => ({
      status: 200,
      body: { schema: 'provider-search-page.v1', items: [{ id: 'x' }] },
    }));
    const malformed = await runProviderSearch(
      w.db.pool,
      w.operator.ctx,
      {
        incidentId: w.incident.incidentId,
        providerAccountId: w.unpaid.providerAccountId,
        query: { providerKinds: ['TECHNICIAN'], country: 'GB', postalCode: 'SW1A 1AA' },
        bounds: { maxResults: 10, maxPages: 3, timeoutMs: 2_000 },
        idempotencyKey: w.key('search-bad'),
      },
      { adapters: w.adapters, credentials: w.creds },
    );
    expect(malformed.state).toBe('FAILED');
    expect(malformed.stateReason).toBe('RESPONSE_SCHEMA_INVALID');
    api.on('GET /v1/providers', (req) => (req.query.cursor === 'page-2' ? fx('second') : fx('first')));
  });

  it('routes an unpaid revision to the M07 adapter: contact, consent and quote schemas normalized', async () => {
    const { byRef } = await discover(w);
    w.api.on('POST /v1/contact-requests', () => fx('contactQuoted'));
    const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: byRef['cl-001']!,
      providerAccountId: w.unpaid.providerAccountId,
      channel: 'API',
      purposeCode: 'QUOTE',
      idempotencyKey: w.key('prep'),
    });
    expect(prepared.paid).toBe(false);
    expect(prepared.providerAccountRevisionId).toBe(w.unpaid.providerAccountRevisionId);
    const exec = await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      prepared.contactRequestId,
      { idempotencyKey: w.key('exec') },
      {},
    );
    expect(exec.route).toBe('M07_UNPAID');
    expect(exec.attempt.providerAccountRevisionId).toBe(w.unpaid.providerAccountRevisionId);
    await dispatch();
    const view = await getContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId);
    const a = view.attempts[0]!;
    expect(a).toMatchObject({
      transportState: 'ACKNOWLEDGED',
      externalOutcomeState: 'CONFIRMED',
      adapterCapability: 'ELIGIBLE',
      rawProviderStatus: 'quoted',
      providerRef: 'cr-77802',
      economicState: null,
      resultOrigin: 'M07_ADAPTER',
      adapterClass: 'SYNTHETIC_FIXTURE',
      providerAccountRevisionId: w.unpaid.providerAccountRevisionId,
    });
    const post = w.api.requests.find((r) => r.method === 'POST')!;
    expect(post.context.providerAccountRevisionId).toBe(w.unpaid.providerAccountRevisionId);
    expect(post.headers['idempotency-key']).toBe(a.idempotencyKey);
    expect(view.consents.map((c) => [c.consentKind, c.status, c.capturedVia])).toContainEqual([
      'PROCESSING',
      'GRANTED',
      'PROVIDER_API',
    ]);
    const quotes = await listIncidentQuotes(w.db.pool, w.operator.ctx, w.incident.incidentId);
    const q = quotes.find((x) => x.contactRequestId === prepared.contactRequestId)!;
    expect(q).toMatchObject({
      amount: money(18_500n, 'GBP'),
      taxMinor: 3_700n,
      etaMinutes: 120,
      validUntil: '2026-11-12T00:00:00.000Z',
      availabilityStatus: 'AVAILABLE',
      scopeKind: 'DIAGNOSTIC_VISIT',
      missingFields: [],
      authority: 'NONE',
      compatibilityApproved: false,
      sourceKind: 'ADAPTER_RESPONSE',
      sourceAdapterClass: 'SYNTHETIC_FIXTURE',
    });
    // CONFIRMED is a provider observation of the contact, never fulfilled work.
    expect(a.displayStatus).toBe('PROVIDER_CONFIRMED_CONTACT');
  });

  it('a definite provider decline is FAILED with no-effect proof (and only then)', async () => {
    const { byRef } = await discover(w);
    w.api.on('POST /v1/contact-requests', () => fx('contactDeclined'));
    const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: byRef['nw-330']!,
      providerAccountId: w.unpaid.providerAccountId,
      channel: 'API',
      purposeCode: 'AVAILABILITY',
      idempotencyKey: w.key('prep'),
    });
    await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      prepared.contactRequestId,
      { idempotencyKey: w.key('e') },
      {},
    );
    await dispatch();
    const a = (await getContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId)).attempts[0]!;
    expect(a).toMatchObject({
      transportState: 'ACKNOWLEDGED',
      externalOutcomeState: 'FAILED',
      rawProviderStatus: 'declined',
      definiteNoEffect: true,
      displayStatus: 'PROVIDER_DECLINED',
    });
  });

  it('routes a paid revision only to the broker port; the intent request pins the exact revision', async () => {
    const { byRef } = await discover(w);
    const broker = new CountingBroker();
    const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: byRef['cl-001']!,
      providerAccountId: w.paid.providerAccountId,
      channel: 'PHONE',
      purposeCode: 'ARRIVAL_ESTIMATE',
      paid: { merchantId: 'mer_stablephone-0001', maxCost: money(1_200n, 'USD') },
      idempotencyKey: w.key('prep-paid'),
    });
    expect(prepared.paid).toBe(true);
    expect(prepared.actionDigest).toMatch(/^action\.v1:sha256:/);
    expect(prepared.providerAccountRevisionId).toBe(w.paid.providerAccountRevisionId);
    const approval = await approvePaidContact(w, prepared);
    const xau = await broker.confirmedAuthority(w.tenant.tenantId);
    const before = w.api.requests.length + w.phone.sent.length;
    const exec = await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      prepared.contactRequestId,
      { idempotencyKey: w.key('exec-paid'), authority: { approvalId: approval.approvalId, executionAuthorityId: xau } },
      { broker },
    );
    expect(exec.route).toBe('KITE_BROKER');
    expect(broker.calls.createIntent).toHaveLength(1);
    const req = broker.calls.createIntent[0]!;
    expect(req).toMatchObject({
      tenantId: w.tenant.tenantId,
      providerAccountRevisionId: w.paid.providerAccountRevisionId,
      actionDigest: prepared.actionDigest,
      planHash: prepared.planHash,
      approvalId: approval.approvalId,
      executionAuthorityId: xau,
      subject: { type: 'PROVIDER_CONTACT_REQUEST', id: prepared.contactRequestId },
      semanticOperation: 'PAID_CONTACT',
      expectedMax: money(1_200n, 'USD'),
    });
    // No M07 adapter egress for a paid revision.
    expect(w.api.requests.length + w.phone.sent.length).toBe(before);
    const a = (await getContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId)).attempts[0]!;
    expect(a).toMatchObject({
      paid: true,
      providerAccountRevisionId: w.paid.providerAccountRevisionId,
      resultOrigin: 'CONTRACT_FAKE',
      adapterClass: 'BROKER',
      economicState: 'SUBMITTED',
      externalOutcomeState: 'ACCEPTED',
    });
    expect(a.commercialIntentId).toMatch(/^cin_/);
  });

  it('supersession invalidates unexecuted work without rewriting in-flight history', async () => {
    const acct = await providerAccount(w, 'coldline-revise');
    const api2 = new FixtureProviderTransport('SYNTHETIC_FIXTURE');
    api2.on('GET /v1/providers', (req) => (req.query.cursor === 'page-2' ? fx('second') : fx('first')));
    api2.on('POST /v1/contact-requests', () => fx('contactAccepted'));
    api2.on('GET /v1/contact-requests/by-operation/*', () => fx('lookupReceived'));
    const reg = new StaticAdapterRegistry([
      new StructuredProviderApiAdapter({ providerKey: 'coldline-revise', transport: api2 }),
    ]);
    const { byRef } = await discover(w);
    const prep = (n: string, sp: string, channel: 'API' | 'EMAIL' = 'API') =>
      prepareContactRequest(w.db.pool, w.operator.ctx, {
        incidentId: w.incident.incidentId,
        serviceProviderId: sp,
        providerAccountId: acct.providerAccountId,
        channel,
        purposeCode: 'QUOTE',
        idempotencyKey: w.key(n),
      });
    const inflight = await prep('inflight', byRef['cl-001']!);
    const queued = await prep('queued', byRef['nw-330']!);
    const unexecuted = await prep('unexecuted', byRef['fr-207']!, 'EMAIL');
    // In-flight: dispatched (ACCEPTED). Queued: PREPARED, not yet dispatched. Unexecuted: never executed.
    await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      inflight.contactRequestId,
      { idempotencyKey: w.key('e1') },
      {},
    );
    await runContactDispatch(w.db.pool, { adapters: reg, credentials: w.creds, workerId: 't029-rev' });
    await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      queued.contactRequestId,
      { idempotencyKey: w.key('e2') },
      {},
    );
    const inflightBefore = (await getContactRequest(w.db.pool, w.operator.ctx, inflight.contactRequestId)).attempts[0]!;

    const rev2 = await appendProviderAccountRevision(w.db.pool, w.admin, acct.providerAccountId as never, {
      revision: {
        capabilities: ['SEARCH', 'QUOTE', 'CONTACT_API'],
        paid: false,
        ownerService: 'M07_UNPAID',
        credentialRef: acct.credentialRef,
        endpointPolicyDigest: endpointPolicyDigest(COLDLINE_POLICY),
        webhookVerifierRef: acct.verifierRef,
      },
      source: 'API',
    });

    // Unexecuted work is invalidated (fail closed), never retargeted to the new revision.
    const held = await rejection(
      executeContactRequest(
        w.db.pool,
        w.operator.ctx,
        unexecuted.contactRequestId,
        { idempotencyKey: w.key('e3') },
        {},
      ),
    );
    expect(held).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'PROVIDER_ACCOUNT_REVISION_SUPERSEDED' });
    const unexecView = await getContactRequest(w.db.pool, w.operator.ctx, unexecuted.contactRequestId);
    expect(unexecView.state).toBe('INVALIDATED');
    expect(unexecView.providerAccountRevisionId).toBe(acct.providerAccountRevisionId);

    // Queued-but-unsent work never egresses on the superseded revision.
    const postsBefore = api2.requests.filter((r) => r.method === 'POST').length;
    await runContactDispatch(w.db.pool, { adapters: reg, credentials: w.creds, workerId: 't029-rev' });
    expect(api2.requests.filter((r) => r.method === 'POST').length).toBe(postsBefore);
    const queuedView = await getContactRequest(w.db.pool, w.operator.ctx, queued.contactRequestId);
    expect(queuedView.state).toBe('INVALIDATED');
    expect(queuedView.attempts[0]).toMatchObject({
      transportState: 'PREPARED',
      definiteNoEffect: true,
      capabilityReason: 'REVISION_SUPERSEDED_BEFORE_SEND',
    });

    // In-flight history keeps its pinned revision and still reconciles against it.
    const inflightView = await getContactRequest(w.db.pool, w.operator.ctx, inflight.contactRequestId);
    expect(inflightView.state).not.toBe('INVALIDATED');
    expect(inflightView.providerAccountRevisionId).toBe(acct.providerAccountRevisionId);
    expect(inflightView.attempts[0]).toMatchObject({
      contactAttemptId: inflightBefore.contactAttemptId,
      providerAccountRevisionId: acct.providerAccountRevisionId,
      transportState: inflightBefore.transportState,
      externalOutcomeState: inflightBefore.externalOutcomeState,
    });
    const { rows } = await w.db.pool.query(
      `SELECT provider_account_revision_id FROM provider_contact_attempts WHERE tenant_id = $1 AND contact_request_id = $2`,
      [w.tenant.tenantId, inflight.contactRequestId],
    );
    expect(rows[0].provider_account_revision_id).toBe(acct.providerAccountRevisionId);
    expect(rows[0].provider_account_revision_id).not.toBe(rev2.providerAccountRevisionId);

    // Sweep form of the same rule; idempotent.
    const swept = await invalidateSupersededContactWork(w.db.pool, w.service, acct.providerAccountId);
    expect(swept.invalidatedRequestIds).not.toContain(inflight.contactRequestId);

    // A new request pins the new revision.
    const fresh = await prep('fresh', byRef['fr-207']!, 'EMAIL');
    expect(fresh.providerAccountRevisionId).toBe(rev2.providerAccountRevisionId);
    expect(fresh.contactRequestId).not.toBe(unexecuted.contactRequestId);

    // The database itself refuses new egress work on the superseded revision.
    expect(
      (
        await w.db.pool
          .query(
            `UPDATE provider_contact_requests SET provider_account_revision_id = $3 WHERE tenant_id = $1 AND id = $2`,
            [w.tenant.tenantId, inflight.contactRequestId, rev2.providerAccountRevisionId],
          )
          .catch((e) => e)
      ).code,
    ).toBe('UB001');
    // Reconciliation of the in-flight attempt still runs against its pinned historical revision.
    const lookups = api2.requests.filter((r) => r.path.startsWith('/v1/contact-requests/by-operation/'));
    const reconciled = await reconcileContactAttempt(w.db.pool, w.service, inflightBefore.contactAttemptId, {
      adapters: reg,
      credentials: w.creds,
    });
    expect(reconciled.providerAccountRevisionId).toBe(acct.providerAccountRevisionId);
    const newLookups = api2.requests.filter((r) => r.path.startsWith('/v1/contact-requests/by-operation/'));
    expect(newLookups.length).toBe(lookups.length + 1);
    expect(newLookups.at(-1)!.context.providerAccountRevisionId).toBe(acct.providerAccountRevisionId);
  });

  it('paid approvals pinned to a superseded revision are invalidated; execution fails closed', async () => {
    const { byRef } = await discover(w);
    const acct = await providerAccount(w, 'stableemail', {
      paid: true,
      capabilities: ['CONTACT_EMAIL'],
    });
    const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: byRef['fr-207']!,
      providerAccountId: acct.providerAccountId,
      channel: 'EMAIL',
      purposeCode: 'QUOTE',
      paid: { merchantId: 'mer_stableemail-0001', maxCost: money(300n, 'USD') },
      idempotencyKey: w.key('prep'),
    });
    const approval = await approvePaidContact(w, prepared);
    await appendProviderAccountRevision(w.db.pool, w.admin, acct.providerAccountId as never, {
      revision: {
        capabilities: ['CONTACT_EMAIL'],
        paid: true,
        ownerService: 'KITE_BROKER_PAID',
        credentialRef: acct.credentialRef,
        endpointPolicyDigest: endpointPolicyDigest(COLDLINE_POLICY),
        webhookVerifierRef: acct.verifierRef,
      },
      source: 'API',
    });
    expect((await getApprovalStatus(w.db.pool, w.approver.ctx, approval.approvalId)).executable).toBe(false);
    const broker = new CountingBroker();
    const xau = await broker.confirmedAuthority(w.tenant.tenantId);
    const held = await rejection(
      executeContactRequest(
        w.db.pool,
        w.operator.ctx,
        prepared.contactRequestId,
        { idempotencyKey: w.key('e'), authority: { approvalId: approval.approvalId, executionAuthorityId: xau } },
        { broker },
      ),
    );
    expect(held.code).toBe('POLICY_HOLD');
    expect(broker.calls.createIntent).toHaveLength(0);
  });
});
