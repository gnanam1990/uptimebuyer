// T-030 — Idempotent provider contact (FR-08, NFR-03, INV-06, INV-07 handoff).
// Duplicate/retried contact commands reuse one immutable contact request. Unpaid accounts create one M07 operation
// (one egress, one quote); paid phone/email/API retries under the same execution authority submit one idempotent
// commercial-intent request to the M01 broker port (CONTRACT FAKE; real-broker reuse and INV-07 successor rules are
// re-asserted by T-042 in M10). M07 never resolves a paid credential or reaches paid egress.
import { money, newId } from '@uptimebuyer/contracts';
import { InMemoryCredentialResolver, revokeApproval } from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FixtureProviderTransport,
  StaticAdapterRegistry,
  StructuredProviderApiAdapter,
  executeContactRequest,
  getContactRequest,
  listIncidentQuotes,
  prepareContactRequest,
  runContactDispatch,
} from '../src/index.js';
import {
  CountingBroker,
  approvePaidContact,
  count,
  createProviderWorld,
  discover,
  fx,
  rejection,
  type ProviderWorld,
} from './helpers.js';

let w: ProviderWorld;
let sp: Record<string, string>;

/** Credential resolver spy: records every reference M07 asks for. */
class SpyResolver extends InMemoryCredentialResolver {
  readonly asked: string[] = [];
  constructor(private readonly inner: InMemoryCredentialResolver) {
    super();
  }
  override async resolveSigningKey(ref: string) {
    this.asked.push(ref);
    return this.inner.resolveSigningKey(ref);
  }
}

describe('T-030 idempotent provider contact', () => {
  beforeAll(async () => {
    w = await createProviderWorld('t030');
    sp = (await discover(w)).byRef;
  });
  afterAll(async () => {
    await w?.close();
  });

  const unpaidInput = (key: string, purposeCode: 'QUOTE' | 'AVAILABILITY' = 'QUOTE') => ({
    incidentId: w.incident.incidentId,
    serviceProviderId: sp['cl-001']!,
    providerAccountId: w.unpaid.providerAccountId,
    channel: 'API' as const,
    purposeCode,
    idempotencyKey: key,
  });

  it('duplicate prepare commands reuse one immutable contact request; key reuse with other content is refused', async () => {
    const k = w.key('prep');
    const a = await prepareContactRequest(w.db.pool, w.operator.ctx, unpaidInput(k));
    const b = await prepareContactRequest(w.db.pool, w.operator.ctx, unpaidInput(k));
    const c = await prepareContactRequest(w.db.pool, w.operator.ctx, unpaidInput(w.key('other-key')));
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ contactRequestId: a.contactRequestId, created: false });
    expect(c).toMatchObject({ contactRequestId: a.contactRequestId, created: false, requestDigest: a.requestDigest });
    const reuse = await rejection(prepareContactRequest(w.db.pool, w.operator.ctx, unpaidInput(k, 'AVAILABILITY')));
    expect(reuse.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(
      await count(w, 'provider_contact_requests', 'tenant_id = $1 AND id = $2', [
        w.tenant.tenantId,
        a.contactRequestId,
      ]),
    ).toBe(1);
    // The request row is immutable.
    const upd = await w.db.pool
      .query(`UPDATE provider_contact_requests SET purpose_code = 'AVAILABILITY' WHERE tenant_id = $1 AND id = $2`, [
        w.tenant.tenantId,
        a.contactRequestId,
      ])
      .catch((e) => e);
    expect(upd.code).toBe('UB001');
  });

  it('unpaid: concurrent and retried executes create one operation, one egress and one quote', async () => {
    w.api.on('POST /v1/contact-requests', () => fx('contactQuoted'));
    const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      ...unpaidInput(w.key('prep-u')),
      serviceProviderId: sp['nw-330']!,
    });
    const k = w.key('exec');
    const results = await Promise.all([
      executeContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId, { idempotencyKey: k }, {}),
      executeContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId, { idempotencyKey: k }, {}),
      ...[1, 2, 3].map(() =>
        executeContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId, { idempotencyKey: w.key('e') }, {}),
      ),
    ]);
    expect(new Set(results.map((r) => r.attempt.contactAttemptId)).size).toBe(1);
    const postsBefore = w.api.requests.filter((r) => r.method === 'POST').length;
    // Several workers race the dispatch queue; repeated dispatch is a no-op.
    await Promise.all(
      [1, 2, 3].map((i) =>
        runContactDispatch(w.db.pool, { adapters: w.adapters, credentials: w.creds, workerId: `t030-${i}` }),
      ),
    );
    await runContactDispatch(w.db.pool, { adapters: w.adapters, credentials: w.creds, workerId: 't030-late' });
    const posts = w.api.requests.filter((r) => r.method === 'POST').slice(postsBefore);
    expect(posts).toHaveLength(1);
    // A later retry after success still reuses the same request and attempt.
    const again = await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      prepared.contactRequestId,
      { idempotencyKey: w.key('e') },
      {},
    );
    expect(again.attempt.contactAttemptId).toBe(results[0]!.attempt.contactAttemptId);
    expect(again.created).toBe(false);
    await runContactDispatch(w.db.pool, { adapters: w.adapters, credentials: w.creds, workerId: 't030-late' });
    expect(w.api.requests.filter((r) => r.method === 'POST').length).toBe(postsBefore + 1);
    const view = await getContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId);
    expect(view.attempts).toHaveLength(1);
    expect(posts[0]!.headers['idempotency-key']).toBe(view.attempts[0]!.idempotencyKey);
    expect(posts[0]!.body).toMatchObject({ clientOperationId: view.attempts[0]!.clientOperationId });
    const quotes = (await listIncidentQuotes(w.db.pool, w.operator.ctx, w.incident.incidentId)).filter(
      (q) => q.contactRequestId === prepared.contactRequestId,
    );
    expect(quotes).toHaveLength(1);
    expect(
      await count(w, 'provider_contact_attempts', 'tenant_id = $1 AND contact_request_id = $2', [
        w.tenant.tenantId,
        prepared.contactRequestId,
      ]),
    ).toBe(1);
  });

  it('paid: retries under the same authority submit one idempotent broker-port request; no paid credential or egress', async () => {
    const broker = new CountingBroker();
    const spy = new SpyResolver(w.creds);
    const trap = new FixtureProviderTransport('SYNTHETIC_FIXTURE');
    // Even a registered adapter under the paid provider key is never used: routing follows the revision owner.
    const adapters = new StaticAdapterRegistry([
      ...w.adapters.list(),
      new StructuredProviderApiAdapter({ providerKey: 'stablephone', transport: trap }),
    ]);
    const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: sp['cl-001']!,
      providerAccountId: w.paid.providerAccountId,
      channel: 'PHONE',
      purposeCode: 'QUOTE',
      paid: { merchantId: 'mer_stablephone-0001', maxCost: money(1_500n, 'USD') },
      idempotencyKey: w.key('prep-paid'),
    });
    const approval = await approvePaidContact(w, prepared);
    const xau = await broker.confirmedAuthority(w.tenant.tenantId);
    const authority = { approvalId: approval.approvalId, executionAuthorityId: xau };
    const runs = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        executeContactRequest(
          w.db.pool,
          w.operator.ctx,
          prepared.contactRequestId,
          { idempotencyKey: w.key('exec-paid'), authority },
          { broker, adapters, credentials: spy },
        ),
      ),
    );
    expect(new Set(runs.map((r) => r.attempt.commercialIntentId)).size).toBe(1);
    expect(broker.fake.intentCount()).toBe(1);
    expect(broker.calls.createIntent).toHaveLength(1);
    expect(broker.calls.execute).toBe(1);
    expect(broker.calls.reconcile).toBe(0);
    await runContactDispatch(w.db.pool, { adapters, credentials: spy, workerId: 't030-paid' });
    const again = await executeContactRequest(
      w.db.pool,
      w.operator.ctx,
      prepared.contactRequestId,
      { idempotencyKey: w.key('exec-paid'), authority },
      { broker, adapters, credentials: spy },
    );
    expect(again.created).toBe(false);
    expect(broker.calls.createIntent).toHaveLength(1);
    expect(broker.calls.execute).toBe(1);
    expect(trap.requests).toHaveLength(0);
    expect(w.phone.sent).toHaveLength(0);
    expect(spy.asked).not.toContain(w.paid.credentialRef);
    expect(spy.asked).not.toContain(w.paid.verifierRef);
    const view = await getContactRequest(w.db.pool, w.operator.ctx, prepared.contactRequestId);
    expect(view.attempts).toHaveLength(1);
    expect(view.attempts[0]!.commercialIntentId).toBe(runs[0]!.attempt.commercialIntentId);
    // No M07-side quote or communication is created for paid work it did not observe itself.
    expect(
      (await listIncidentQuotes(w.db.pool, w.operator.ctx, w.incident.incidentId)).filter(
        (q) => q.contactRequestId === prepared.contactRequestId,
      ),
    ).toHaveLength(0);
    // The paid credential reference never leaves the data layer through an M07 view.
    expect(JSON.stringify(view, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(
      w.paid.credentialRef,
    );
  });

  it('paid execution fails closed without exact executable authority (no broker call)', async () => {
    const broker = new CountingBroker();
    const prepared = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: sp['cl-001']!,
      providerAccountId: w.paid.providerAccountId,
      channel: 'PHONE',
      purposeCode: 'AVAILABILITY',
      paid: { merchantId: 'mer_stablephone-0001', maxCost: money(900n, 'USD') },
      idempotencyKey: w.key('prep-paid2'),
    });
    const xau = await broker.confirmedAuthority(w.tenant.tenantId);
    const exec = (authority?: { approvalId: string; executionAuthorityId: string }) =>
      rejection(
        executeContactRequest(
          w.db.pool,
          w.operator.ctx,
          prepared.contactRequestId,
          { idempotencyKey: w.key('x'), ...(authority ? { authority } : {}) },
          { broker },
        ),
      );
    expect(await exec()).toMatchObject({ code: 'POLICY_HOLD', reasonCode: 'PAID_AUTHORITY_REQUIRED' });
    // Approval for another action digest.
    const other = await prepareContactRequest(w.db.pool, w.operator.ctx, {
      incidentId: w.incident.incidentId,
      serviceProviderId: sp['cl-001']!,
      providerAccountId: w.paid.providerAccountId,
      channel: 'PHONE',
      purposeCode: 'DIAGNOSTIC_COMMITMENT',
      paid: { merchantId: 'mer_stablephone-0001', maxCost: money(900n, 'USD') },
      idempotencyKey: w.key('prep-paid3'),
    });
    const wrong = await approvePaidContact(w, other);
    expect(await exec({ approvalId: wrong.approvalId, executionAuthorityId: xau })).toMatchObject({
      code: 'POLICY_HOLD',
      reasonCode: 'APPROVAL_SCOPE_MISMATCH',
    });
    // Approval below the request's cost bound.
    const small = await approvePaidContact(w, prepared, 100n);
    expect(await exec({ approvalId: small.approvalId, executionAuthorityId: xau })).toMatchObject({
      code: 'POLICY_HOLD',
      reasonCode: 'APPROVAL_AMOUNT_BELOW_REQUEST',
    });
    // Revoked approval.
    const ok = await approvePaidContact(w, prepared);
    await revokeApproval(w.db.pool, w.approver.ctx, ok.approvalId, 'OPERATOR_CANCELLED');
    expect(await exec({ approvalId: ok.approvalId, executionAuthorityId: xau })).toMatchObject({
      code: 'POLICY_HOLD',
      reasonCode: 'APPROVAL_NOT_EXECUTABLE',
    });
    // Forged/unknown approval id looks identical to a foreign one.
    expect((await exec({ approvalId: newId('approval'), executionAuthorityId: xau })).code).toBe('FORBIDDEN');
    expect(broker.calls.createIntent).toHaveLength(0);
    expect(broker.calls.execute).toBe(0);
    // Unpaid requests refuse paid authority, paid requests refuse the unpaid path.
    const unpaid = await prepareContactRequest(
      w.db.pool,
      w.operator.ctx,
      unpaidInput(w.key('prep-u2'), 'AVAILABILITY'),
    );
    expect(
      await rejection(
        executeContactRequest(
          w.db.pool,
          w.operator.ctx,
          unpaid.contactRequestId,
          { idempotencyKey: w.key('x'), authority: { approvalId: ok.approvalId, executionAuthorityId: xau } },
          { broker },
        ),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED', reasonCode: 'UNPAID_REQUEST_TAKES_NO_AUTHORITY' });
    expect(
      await rejection(
        prepareContactRequest(w.db.pool, w.operator.ctx, {
          ...unpaidInput(w.key('p')),
          paid: { merchantId: 'mer_x-0001', maxCost: money(1n, 'USD') },
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED', reasonCode: 'UNPAID_ACCOUNT_TAKES_NO_PAID_BOUNDS' });
  });
});
