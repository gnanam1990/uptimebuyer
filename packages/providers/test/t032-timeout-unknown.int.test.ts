// T-032 — Provider timeout becomes unknown (INV-08, INV-12, NFR-03, NFR-04).
// Timeout after unpaid dispatch produces transport/external UNKNOWN (no economic intent exists for unpaid work); a
// paid UNKNOWN result event from the broker-port CONTRACT FAKE is consumed without any M07 retry (the real paid-broker
// timeout is T-040) and authoritative account-revision reconciliation precedes any retry. Pre-egress unsupported
// capability blocks send. If capability proves unreconcilable after possible egress, adapter capability becomes
// UNSUPPORTED but the effect remains UNKNOWN and manual (for a paid effect the broker reports it reserved), and the
// API never labels it failed, unsupported-effect or completed.
import { money } from '@uptimebuyer/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BROKER_RESULT_CONSUMER,
  ChannelContactAdapter,
  FixtureProviderTransport,
  LocalChannelTransport,
  StaticAdapterRegistry,
  StructuredProviderApiAdapter,
  displayStatusOf,
  executeContactRequest,
  getContactRequest,
  handleBrokerResultEvent,
  prepareContactRequest,
  reconcileContactAttempt,
  runContactDispatch,
  sweepContactAttempts,
} from '../src/index.js';
import {
  CountingBroker,
  approvePaidContact,
  brokerAttempt,
  brokerEvent,
  count,
  createProviderWorld,
  discover,
  fx,
  providerAccount,
  publishBrokerEvents,
  rejection,
  type ProviderWorld,
} from './helpers.js';

let w: ProviderWorld;
let sp: Record<string, string>;
const FORBIDDEN_LABELS = ['FAILED', 'COMPLETED', 'UNSUPPORTED', 'PROVIDER_DECLINED', 'DONE'];

/** A fresh unpaid account + adapter so each scenario owns its transport script. */
async function scenario(label: string) {
  const acct = await providerAccount(w, `cold-${label}`);
  const api = new FixtureProviderTransport('SYNTHETIC_FIXTURE');
  const adapters = new StaticAdapterRegistry([
    new StructuredProviderApiAdapter({ providerKey: `cold-${label}`, transport: api }),
  ]);
  const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
    incidentId: w.incident.incidentId,
    serviceProviderId: sp['cl-001']!,
    providerAccountId: acct.providerAccountId,
    channel: 'API',
    purposeCode: 'QUOTE',
    timeoutMs: 200,
    idempotencyKey: w.key(`prep-${label}`),
  });
  const run = () => runContactDispatch(w.db.pool, { adapters, credentials: w.creds, workerId: `t032-${label}` });
  const view = async () => (await getContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId)).attempts;
  const exec = () =>
    executeContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId, { idempotencyKey: w.key('e') }, {});
  return { acct, api, adapters, prepared, run, view, exec };
}

describe('T-032 provider timeout becomes unknown', () => {
  beforeAll(async () => {
    w = await createProviderWorld('t032');
    sp = (await discover(w)).byRef;
  });
  afterAll(async () => {
    await w?.close();
  });

  it('unpaid timeout after dispatch is transport/external UNKNOWN with a next reconciliation time, never failed', async () => {
    const s = await scenario('hang');
    s.api.on('POST /v1/contact-requests', () => 'HANG');
    await s.exec();
    await s.run();
    const [a] = await s.view();
    expect(a).toMatchObject({
      transportState: 'UNKNOWN',
      externalOutcomeState: 'UNKNOWN',
      adapterCapability: 'ELIGIBLE',
      economicState: null,
      commercialIntentId: null,
      manualReview: false,
      definiteNoEffect: false,
      displayStatus: 'OUTCOME_UNKNOWN_RECONCILING',
    });
    expect(Date.parse(a!.nextReconcileAt!)).toBeGreaterThan(Date.now() - 1_000);
    for (const l of FORBIDDEN_LABELS) expect(a!.displayStatus).not.toContain(l);
    // The observation log shows the handoff, then the timeout; no fabricated terminal result.
    const kinds = (
      await w.db.pool.query(
        `SELECT observation_kind FROM provider_contact_attempt_events WHERE tenant_id = $1 AND attempt_id = $2 ORDER BY sequence`,
        [w.tenant.tenantId, a!.contactAttemptId],
      )
    ).rows.map((r) => r.observation_kind);
    expect(kinds).toEqual(['PREPARED', 'SEND_STARTED', 'HANDOFF', 'TIMEOUT']);

    // No autonomous retry: re-executing and re-dispatching send nothing new.
    await s.exec();
    await s.run();
    expect(s.api.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(await s.view()).toHaveLength(1);

    // Authoritative lookup by the pre-egress client operation key against the pinned revision precedes anything else.
    s.api.on('GET /v1/contact-requests/by-operation/*', () => fx('lookupNotFound'));
    const stillUnknown = await reconcileContactAttempt(w.db.pool, w.service, a!.contactAttemptId, {
      adapters: s.adapters,
      credentials: w.creds,
    });
    expect(stillUnknown.externalOutcomeState).toBe('UNKNOWN'); // absence is not proof of no effect
    const lookup = s.api.requests.find((r) => r.path.startsWith('/v1/contact-requests/by-operation/'))!;
    expect(lookup.path).toBe(`/v1/contact-requests/by-operation/${a!.clientOperationId}`);
    expect(lookup.context.providerAccountRevisionId).toBe(s.acct.providerAccountRevisionId);
    s.api.on('GET /v1/contact-requests/by-operation/*', () => fx('lookupReceived'));
    const resolved = await reconcileContactAttempt(w.db.pool, w.service, a!.contactAttemptId, {
      adapters: s.adapters,
      credentials: w.creds,
    });
    expect(resolved).toMatchObject({
      transportState: 'UNKNOWN',
      externalOutcomeState: 'ACCEPTED',
      providerRef: 'cr-77801',
    });
    expect(s.api.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    // Humans cannot drive the engine-only reconciliation path.
    expect(
      (
        await rejection(
          reconcileContactAttempt(w.db.pool, w.operator.ctx, a!.contactAttemptId, {
            adapters: s.adapters,
            credentials: w.creds,
          }),
        )
      ).code,
    ).toBe('FORBIDDEN');
  });

  it('a crash after the SEND_STARTED marker reconstructs UNKNOWN from AUTHORIZED without fabricating REQUESTED', async () => {
    const s = await scenario('crash');
    s.api.on('POST /v1/contact-requests', () => fx('contactAccepted'));
    await s.exec();
    await expect(
      runContactDispatch(w.db.pool, {
        adapters: s.adapters,
        credentials: w.creds,
        workerId: 't032-crash',
        faults: {
          afterSendStarted: () => {
            throw new Error('worker killed');
          },
        },
      }),
    ).rejects.toThrow('worker killed');
    const [marker] = await s.view();
    expect(marker).toMatchObject({ transportState: 'SEND_STARTED', externalOutcomeState: 'AUTHORIZED' });
    expect(s.api.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    // The job is never re-dispatched over a durable marker.
    await s.run();
    expect(s.api.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    s.api.on('GET /v1/contact-requests/by-operation/*', () => fx('lookupNotFound'));
    const swept = await sweepContactAttempts(
      w.db.pool,
      w.service,
      { adapters: s.adapters, credentials: w.creds },
      {
        asOf: new Date(Date.now() + 120_000).toISOString(),
      },
    );
    expect(swept.reconstructed).toBeGreaterThanOrEqual(1);
    const [a] = await s.view();
    expect(a).toMatchObject({ transportState: 'UNKNOWN', externalOutcomeState: 'UNKNOWN' });
    const kinds = (
      await w.db.pool.query(
        `SELECT observation_kind, external_outcome_state FROM provider_contact_attempt_events WHERE tenant_id = $1 AND attempt_id = $2 ORDER BY sequence`,
        [w.tenant.tenantId, a!.contactAttemptId],
      )
    ).rows;
    expect(kinds.map((k) => k.observation_kind)).not.toContain('HANDOFF');
    expect(kinds.map((k) => k.external_outcome_state)).not.toContain('REQUESTED');
  });

  it('unreconcilable after possible egress: capability UNSUPPORTED, effect stays UNKNOWN and manual', async () => {
    const s = await scenario('nolookup');
    s.api.on('POST /v1/contact-requests', () => 'HANG');
    s.api.on('GET /v1/contact-requests/by-operation/*', () => fx('lookupUnsupported'));
    await s.exec();
    await s.run();
    const [u] = await s.view();
    const a = await reconcileContactAttempt(w.db.pool, w.service, u!.contactAttemptId, {
      adapters: s.adapters,
      credentials: w.creds,
    });
    expect(a).toMatchObject({
      transportState: 'UNKNOWN',
      externalOutcomeState: 'UNKNOWN',
      adapterCapability: 'UNSUPPORTED',
      capabilityReason: 'LOOKUP_UNSUPPORTED',
      manualReview: true,
      nextReconcileAt: null,
      definiteNoEffect: false,
      displayStatus: 'OUTCOME_UNKNOWN_MANUAL_REVIEW',
    });
    for (const l of FORBIDDEN_LABELS) expect(a.displayStatus).not.toContain(l);
    // No retry and no replacement attempt to "obtain certainty".
    await s.exec();
    await s.run();
    await sweepContactAttempts(
      w.db.pool,
      w.service,
      { adapters: s.adapters, credentials: w.creds },
      {
        asOf: new Date(Date.now() + 3_600_000).toISOString(),
      },
    );
    expect(s.api.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(await s.view()).toHaveLength(1);
    // The database refuses to relabel the effect while capability is lost.
    const relabel = await w.db.pool
      .query(
        `UPDATE provider_contact_attempts SET external_outcome_state = 'FAILED', version = version + 1 WHERE tenant_id = $1 AND id = $2`,
        [w.tenant.tenantId, a.contactAttemptId],
      )
      .catch((e) => e);
    // UNKNOWN -> FAILED is only legal with definite no-effect proof recorded by authoritative reconciliation.
    expect(relabel.code ?? 'OK').not.toBe('OK');
  });

  it('pre-egress UNSUPPORTED capability blocks send (revision capability and adapter configuration)', async () => {
    const noEmail = await providerAccount(w, 'cold-noemail', { capabilities: ['SEARCH', 'CONTACT_API'] });
    const email = new LocalChannelTransport('EMAIL');
    const adapters = new StaticAdapterRegistry([
      new ChannelContactAdapter({ providerKey: 'cold-noemail', channel: 'EMAIL', transport: email }),
    ]);
    const blockedByRevision = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: sp['fr-207']!,
      providerAccountId: noEmail.providerAccountId,
      channel: 'EMAIL',
      purposeCode: 'QUOTE',
      idempotencyKey: w.key('p1'),
    });
    const r1 = await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      blockedByRevision.contactRequestId,
      { idempotencyKey: w.key('e') },
      { adapters },
    );
    expect(r1.attempt).toMatchObject({
      transportState: 'PREPARED',
      externalOutcomeState: 'PROPOSED',
      adapterCapability: 'UNSUPPORTED',
      capabilityReason: 'CAPABILITY_NOT_DECLARED',
      definiteNoEffect: true,
      displayStatus: 'BLOCKED_UNSUPPORTED_CAPABILITY',
    });
    // Adapter not configured for this account's channel (the API adapter exists, the email one does not).
    const apiOnly = await providerAccount(w, 'cold-apionly');
    const blockedByAdapter = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: sp['fr-207']!,
      providerAccountId: apiOnly.providerAccountId,
      channel: 'EMAIL',
      purposeCode: 'QUOTE',
      idempotencyKey: w.key('p2'),
    });
    const r2 = await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      blockedByAdapter.contactRequestId,
      { idempotencyKey: w.key('e') },
      { adapters },
    );
    expect(r2.attempt).toMatchObject({ adapterCapability: 'UNSUPPORTED', capabilityReason: 'ADAPTER_NOT_CONFIGURED' });
    await runContactDispatch(w.db.pool, { adapters, credentials: w.creds, workerId: 't032-block' });
    expect(email.sent).toHaveLength(0);
    // Paid revision without the channel capability: blocked before any broker call.
    const broker = new CountingBroker();
    const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: sp['fr-207']!,
      providerAccountId: w.paid.providerAccountId,
      channel: 'EMAIL',
      purposeCode: 'QUOTE',
      paid: { merchantId: 'mer_stablephone-0001', maxCost: money(400n, 'USD') },
      idempotencyKey: w.key('p3'),
    });
    const approval = await approvePaidContact(w, prepared);
    const xau = await broker.confirmedAuthority(w.tenant.tenantId);
    const r3 = await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      prepared.contactRequestId,
      { idempotencyKey: w.key('e'), authority: { approvalId: approval.approvalId, executionAuthorityId: xau } },
      { broker },
    );
    expect(r3.attempt).toMatchObject({ paid: true, adapterCapability: 'UNSUPPORTED', commercialIntentId: null });
    expect(broker.calls.createIntent).toHaveLength(0);
  });

  it('paid UNKNOWN from the broker port is consumed without any M07 retry; only broker reconciliation resolves it', async () => {
    const broker = new CountingBroker();
    broker.outcome = 'UNKNOWN';
    const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: sp['cl-001']!,
      providerAccountId: w.paid.providerAccountId,
      channel: 'PHONE',
      purposeCode: 'ARRIVAL_ESTIMATE',
      paid: { merchantId: 'mer_stablephone-0001', maxCost: money(700n, 'USD') },
      idempotencyKey: w.key('pp'),
    });
    const approval = await approvePaidContact(w, prepared);
    const xau = await broker.confirmedAuthority(w.tenant.tenantId);
    const authority = { approvalId: approval.approvalId, executionAuthorityId: xau };
    await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      prepared.contactRequestId,
      { idempotencyKey: w.key('e'), authority },
      { broker },
    );
    const [a] = (await getContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId)).attempts;
    expect(a).toMatchObject({
      paid: true,
      economicState: 'UNKNOWN',
      externalOutcomeState: 'UNKNOWN',
      transportState: 'UNKNOWN',
      adapterCapability: 'ELIGIBLE',
      resultOrigin: 'CONTRACT_FAKE',
      displayStatus: 'OUTCOME_UNKNOWN_RECONCILING',
    });
    expect(a!.nextReconcileAt).not.toBeNull();
    // Retried commands, dispatch and sweeps never call the broker again or reconcile a paid attempt.
    await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      prepared.contactRequestId,
      { idempotencyKey: w.key('e'), authority },
      { broker },
    );
    await runContactDispatch(w.db.pool, { adapters: w.adapters, credentials: w.creds, workerId: 't032-paid' });
    await sweepContactAttempts(
      w.db.pool,
      w.service,
      { adapters: w.adapters, credentials: w.creds },
      {
        asOf: new Date(Date.now() + 3_600_000).toISOString(),
      },
    );
    expect(
      await rejection(
        reconcileContactAttempt(w.db.pool, w.service, a!.contactAttemptId, {
          adapters: w.adapters,
          credentials: w.creds,
        }),
      ),
    ).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'PAID_RECONCILIATION_BROKER_ONLY' });
    expect(broker.calls).toMatchObject({ execute: 1, reconcile: 0 });
    expect(broker.calls.createIntent).toHaveLength(1);

    // The broker (M09's role, here the fake) reconciles and emits the result; M07 consumes it once.
    const run = await broker.brokerReconciles(a!.commercialIntentId as never, 'CONFIRMED');
    const durable = await publishBrokerEvents(w, run.events);
    expect(await handleBrokerResultEvent(w.db.pool, durable[0] as never)).toBe('PROCESSED');
    expect(await handleBrokerResultEvent(w.db.pool, durable[0] as never)).toBe('DUPLICATE');
    const [c] = (await getContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId)).attempts;
    expect(c).toMatchObject({
      economicState: 'CONFIRMED',
      externalOutcomeState: 'CONFIRMED',
      displayStatus: 'PROVIDER_CONFIRMED_CONTACT',
      nextReconcileAt: null,
    });
    expect(c!.displayStatus).not.toContain('COMPLETED');
    expect(BROKER_RESULT_CONSUMER).toBe('provider-broker-result.v1');
    // A stale (older-version) event delivered late never rolls the projection back.
    const stale = await publishBrokerEvents(w, [
      brokerEvent(
        (await broker.getIntent(w.tenant.tenantId, a!.commercialIntentId as never))!,
        'RESERVED',
        'UNKNOWN',
        brokerAttempt({ transportState: 'UNKNOWN', externalOutcomeState: 'UNKNOWN' }),
        {
          version: 2,
          nextReconcileAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ),
    ]);
    // version 2 is already applied for this intent; the duplicate-version delivery is refused by the outbox or ignored
    await handleBrokerResultEvent(w.db.pool, stale[0] as never).catch(() => 'REFUSED');
    expect(
      (await getContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId)).attempts[0]!.economicState,
    ).toBe('CONFIRMED');
  });

  it('paid capability lost after possible egress: UNSUPPORTED capability, effect UNKNOWN and reserved, manual', async () => {
    const broker = new CountingBroker();
    broker.executeOverride = async (_fake, intent) => {
      const reserved = brokerEvent(intent, 'CREATED', 'RESERVED', brokerAttempt(), { version: 2 });
      const unknown = brokerEvent(
        intent,
        'RESERVED',
        'UNKNOWN',
        brokerAttempt({ transportState: 'UNKNOWN', externalOutcomeState: 'UNKNOWN', adapterCapability: 'UNSUPPORTED' }),
        { version: 3, nextReconcileAt: null, causationId: reserved.eventId },
      );
      return { intent: { ...intent, state: 'UNKNOWN', version: 3 }, events: [reserved, unknown] };
    };
    const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: sp['nw-330']!,
      providerAccountId: w.paid.providerAccountId,
      channel: 'PHONE',
      purposeCode: 'QUOTE',
      paid: { merchantId: 'mer_stablephone-0001', maxCost: money(650n, 'USD') },
      idempotencyKey: w.key('pq'),
    });
    const approval = await approvePaidContact(w, prepared);
    const xau = await broker.confirmedAuthority(w.tenant.tenantId);
    await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      prepared.contactRequestId,
      { idempotencyKey: w.key('e'), authority: { approvalId: approval.approvalId, executionAuthorityId: xau } },
      { broker },
    );
    const [a] = (await getContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId)).attempts;
    expect(a).toMatchObject({
      economicState: 'UNKNOWN',
      externalOutcomeState: 'UNKNOWN',
      adapterCapability: 'UNSUPPORTED',
      manualReview: true,
      nextReconcileAt: null,
      displayStatus: 'OUTCOME_UNKNOWN_MANUAL_REVIEW',
    });
    for (const l of FORBIDDEN_LABELS) expect(a!.displayStatus).not.toContain(l);
    expect(
      displayStatusOf({ ...a!, externalOutcomeState: 'UNKNOWN', adapterCapability: 'UNSUPPORTED', manualReview: true }),
    ).toBe('OUTCOME_UNKNOWN_MANUAL_REVIEW');
    expect(broker.calls).toMatchObject({ execute: 1, reconcile: 0 });
    expect(
      await count(w, 'provider_contact_attempts', 'tenant_id = $1 AND contact_request_id = $2', [
        w.tenant.tenantId,
        prepared.contactRequestId,
      ]),
    ).toBe(1);
  });
});
