// T-005 — Contract schema round trip for the credential-free commercial-intent broker port, plus the behaviour of
// its in-memory CONTRACT FAKE (idempotent intent per action digest + execution authority, injectable UNKNOWN).
// The fake is not Kite: every result it produces is labelled CONTRACT_FAKE and proves nothing about real payment.
import { randomBytes } from 'node:crypto';
import {
  DomainError,
  ID_PREFIXES,
  decodeWire,
  encodeWire,
  instantFromEpochMs,
  money,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CommercialIntentRequestSchema,
  CommercialIntentStateChangedEventSchema,
  CommercialIntentStateChangedPayloadSchema,
  InMemoryCommercialIntentBrokerFake,
  SignedExecutionReferenceSchema,
  signExecutionReference,
  verifyExecutionReference,
  type CommercialIntentBrokerPort,
  type CommercialIntentRequest,
} from '../src/index.js';

const id = (kind: keyof typeof ID_PREFIXES, body = 'fixture01') => `${ID_PREFIXES[kind]}_${body}`;
const vdig = (domain: string, c: string) => `${domain}.v1:sha256:${c.repeat(64)}`;

const requestWire = {
  tenantId: id('tenant'),
  incidentId: id('incident'),
  assetRevisionId: id('assetRevision'),
  evidenceRevisionId: id('evidenceRevision'),
  policyRevisionId: id('policyRevision'),
  planHash: vdig('plan', '1'),
  actionDigest: vdig('action', '2'),
  approvalId: id('approval'),
  executionAuthorityId: id('executionAuthority'),
  providerAccountRevisionId: id('providerAccountRevision'),
  subject: { type: 'PLAN_ACTION', id: id('candidateAction') },
  semanticOperation: 'PURCHASE',
  expectedMax: { amountMinor: '48200', currency: 'USD' },
  requestedBy: { kind: 'SERVICE', serviceIdentityId: id('serviceIdentity') },
  correlationId: id('correlation'),
  idempotencyKey: 'idem-intent-0001',
};
const tryDecode = (v: unknown) => z.safeDecode(CommercialIntentRequestSchema, v as never);
const request = (overrides: Partial<Record<string, unknown>> = {}): CommercialIntentRequest =>
  decodeWire(CommercialIntentRequestSchema, { ...structuredClone(requestWire), ...overrides });

function makeFake(start = 1_793_784_000_000) {
  let now = start;
  const clock = { now: (): UtcInstant => instantFromEpochMs(now), advance: (ms: number) => (now += ms) };
  const key = randomBytes(32); // synthetic, generated at runtime, never persisted
  const fake = new InMemoryCommercialIntentBrokerFake({ signingKey: key, keyId: 'fake-key-1', clock: clock.now });
  /** A paid reserve requires a CONFIRMED Kite session for the authority. */
  const activate = (authority = id('executionAuthority')) =>
    fake.activateSession(fake.issueAuthorityReference(id('tenant') as never, authority as never));
  return { fake, clock, key, activate };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof DomainError ? e.code : `non-domain:${String(e)}`;
  }
  return 'NO_ERROR';
};

describe('T-005 commercial-intent broker port contract', () => {
  it('round-trips the intent request and rejects extra or malformed critical fields', () => {
    const decoded = request();
    expect(
      decodeWire(
        CommercialIntentRequestSchema,
        JSON.parse(JSON.stringify(encodeWire(CommercialIntentRequestSchema, decoded))),
      ),
    ).toEqual(decoded);
    expect(tryDecode({ ...requestWire, kiteApiKey: 'x' }).success).toBe(false);
    expect(
      tryDecode({
        ...requestWire,
        expectedMax: { amountMinor: 1.5, currency: 'USD' },
      }).success,
    ).toBe(false);
    expect(tryDecode({ ...requestWire, actionDigest: `sha256:${'2'.repeat(64)}` }).success).toBe(false);
  });

  it('signs an opaque execution reference that names only an authority or an intent', () => {
    const key = randomBytes(32);
    const now = instantFromEpochMs(1_793_784_000_000);
    const ref = signExecutionReference(
      {
        referenceVersion: 1,
        tenantId: id('tenant') as never,
        target: { kind: 'COMMERCIAL_INTENT', commercialIntentId: id('commercialIntent') as never },
        issuedAt: now,
        expiresAt: instantFromEpochMs(1_793_784_300_000),
        nonce: 'bm9uY2Utbm9uY2UtMDAwMQ',
      },
      key,
      'k1',
    );
    expect(SignedExecutionReferenceSchema.safeParse(ref).success).toBe(true);
    expect(verifyExecutionReference(ref, { k1: key }, now)).toEqual(ref);
    const embedded = { ...ref, target: { ...ref.target, maxAmountMinor: '999999' } };
    expect(SignedExecutionReferenceSchema.safeParse(embedded).success).toBe(false);
    expect(SignedExecutionReferenceSchema.safeParse({ ...ref, merchantId: id('merchant') }).success).toBe(false);
    const both = { ...ref, target: { kind: 'EXECUTION_AUTHORITY', commercialIntentId: id('commercialIntent') } };
    expect(SignedExecutionReferenceSchema.safeParse(both).success).toBe(false);
    const reject = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as DomainError).code;
      }
      return 'NO_ERROR';
    };
    expect(
      reject(() =>
        verifyExecutionReference({ ...ref, tenantId: id('tenant', 'othertenant') } as never, { k1: key }, now),
      ),
    ).toBe('EXECUTION_REFERENCE_INVALID');
    expect(reject(() => verifyExecutionReference(ref, { k1: randomBytes(32) }, now))).toBe(
      'EXECUTION_REFERENCE_INVALID',
    );
    expect(reject(() => verifyExecutionReference(ref, { other: key }, now))).toBe('EXECUTION_REFERENCE_INVALID');
    expect(reject(() => verifyExecutionReference(ref, { k1: key }, instantFromEpochMs(1_793_784_300_000)))).toBe(
      'EXECUTION_REFERENCE_INVALID',
    );
    expect(reject(() => verifyExecutionReference(embedded as never, { k1: key }, now))).toBe(
      'EXECUTION_REFERENCE_INVALID',
    );
  });

  it('validates commercial_intent.state_changed.v1 honestly against the domain machine', () => {
    const payload = {
      commercialIntentId: id('commercialIntent'),
      actionDigest: vdig('action', '2'),
      executionAuthorityId: id('executionAuthority'),
      priorState: 'RESERVED',
      state: 'SUBMITTED',
      attempt: {
        externalAttemptId: id('externalAttempt'),
        clientOperationId: id('clientOperation'),
        idempotencyKey: 'idem-attempt-0001',
        transportState: 'ACKNOWLEDGED',
        externalOutcomeState: 'ACCEPTED',
        adapterCapability: 'ELIGIBLE',
        providerRef: null,
      },
      reasonCode: null,
      nextReconcileAt: null,
      resultOrigin: 'CONTRACT_FAKE',
    };
    const event = {
      eventId: id('event'),
      eventType: 'commercial_intent.state_changed.v1',
      occurredAt: '2026-11-04T10:00:00.000Z',
      tenantId: id('tenant'),
      aggregateType: 'commercial_intent',
      aggregateId: id('commercialIntent'),
      aggregateVersion: 3,
      correlationId: id('correlation'),
      causationId: id('command'),
      schemaVersion: 1,
      payload,
    };
    const decoded = decodeWire(CommercialIntentStateChangedEventSchema, event);
    expect(
      decodeWire(
        CommercialIntentStateChangedEventSchema,
        JSON.parse(JSON.stringify(encodeWire(CommercialIntentStateChangedEventSchema, decoded))),
      ),
    ).toEqual(decoded);
    const bad = (p: Record<string, unknown>) => CommercialIntentStateChangedPayloadSchema.safeParse(p).success;
    expect(bad(payload)).toBe(true);
    expect(bad({ ...payload, priorState: 'CREATED' })).toBe(false); // CREATED -> SUBMITTED is not an edge
    expect(bad({ ...payload, attempt: { ...payload.attempt, externalOutcomeState: 'REQUESTED' } })).toBe(false); // only ACCEPTED justifies SUBMITTED
    expect(
      bad({
        ...payload,
        state: 'UNKNOWN',
        attempt: { ...payload.attempt, transportState: 'UNKNOWN', externalOutcomeState: 'UNKNOWN' },
      }),
    ).toBe(false); // UNKNOWN must show its next reconciliation time
    expect(
      bad({
        ...payload,
        priorState: 'SUBMITTED',
        state: 'FAILED',
        attempt: { ...payload.attempt, externalOutcomeState: 'FAILED' },
      }),
    ).toBe(false); // FAILED needs a reason
    expect(bad({ ...payload, priorState: 'CREATED', state: 'CREATED' })).toBe(false); // created is commercial_intent.created.v1
    expect(bad({ ...payload, resultOrigin: 'REAL' })).toBe(false);
    expect(bad({ ...payload, status: 'DONE' })).toBe(false);
    expect(
      CommercialIntentStateChangedEventSchema.safeParse({ ...event, aggregateId: id('commercialIntent', 'another01') })
        .success,
    ).toBe(false);
  });
});

describe('T-005 commercial-intent broker CONTRACT FAKE', () => {
  it('is clearly a fake and satisfies the port type', () => {
    const { fake } = makeFake();
    const port: CommercialIntentBrokerPort = fake;
    expect(port).toBe(fake);
    expect(fake.isContractFake).toBe(true);
    expect(InMemoryCommercialIntentBrokerFake.name).toMatch(/Fake$/);
  });

  it('returns the same intent for the same (actionDigest, executionAuthorityId)', async () => {
    const { fake } = makeFake();
    const first = await fake.createIntent(request());
    const again = await fake.createIntent(
      request({ correlationId: id('correlation', 'retry0001'), idempotencyKey: 'idem-intent-0002' }),
    );
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.intent.commercialIntentId).toBe(first.intent.commercialIntentId);
    expect(again.intent).toEqual(first.intent);
    expect(first.intent.state).toBe('CREATED');
    expect(first.intent.maxAmount).toEqual(money(48200n, 'USD'));
    expect(first.executionReference.target).toEqual({
      kind: 'COMMERCIAL_INTENT',
      commercialIntentId: first.intent.commercialIntentId,
    });
    expect(first.resultOrigin).toBe('CONTRACT_FAKE');
    expect(fake.intentCount()).toBe(1);
  });

  it('refuses to reuse the idempotency identity for a materially different request', async () => {
    const { fake } = makeFake();
    await fake.createIntent(request());
    expect(await codeOf(fake.createIntent(request({ expectedMax: { amountMinor: '48201', currency: 'USD' } })))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(fake.intentCount()).toBe(1);
  });

  it('blocks a successor under fresh authority until the prior intent is definite-no-effect FAILED', async () => {
    const { fake, activate } = makeFake();
    await activate();
    const first = await fake.createIntent(request());
    const fresh = {
      executionAuthorityId: id('executionAuthority', 'fresh0001'),
      approvalId: id('approval', 'fresh0001'),
    };
    expect(await codeOf(fake.createIntent(request(fresh)))).toBe('INTENT_SUCCESSOR_BLOCKED');
    fake.injectExecutionOutcome(first.intent.commercialIntentId, 'DEFINITE_DECLINE');
    const run = await fake.execute(first.executionReference);
    expect(run.intent.state).toBe('FAILED');
    const successor = await fake.createIntent(request(fresh));
    expect(successor.created).toBe(true);
    expect(successor.intent.supersedesIntentId).toBe(first.intent.commercialIntentId);
    expect(successor.intent.actionDigest).toBe(first.intent.actionDigest);
  });

  it('executes CREATED -> RESERVED -> SUBMITTED with schema-valid, fake-labelled events', async () => {
    const { fake, activate } = makeFake();
    await activate();
    const { executionReference } = await fake.createIntent(request());
    const run = await fake.execute(executionReference);
    expect(run.events.map((e) => [e.payload.priorState, e.payload.state])).toEqual([
      ['CREATED', 'RESERVED'],
      ['RESERVED', 'SUBMITTED'],
    ]);
    expect(run.events.map((e) => e.aggregateVersion)).toEqual([2, 3]);
    for (const e of run.events) {
      expect(() => encodeWire(CommercialIntentStateChangedEventSchema, e)).not.toThrow();
      expect(e.payload.resultOrigin).toBe('CONTRACT_FAKE');
    }
    expect(run.events[0]?.payload.attempt).toMatchObject({
      transportState: 'SEND_STARTED',
      externalOutcomeState: 'AUTHORIZED',
    });
    expect(run.events[1]?.payload.attempt).toMatchObject({
      transportState: 'ACKNOWLEDGED',
      externalOutcomeState: 'ACCEPTED',
    });
    expect(run.intent.state).toBe('SUBMITTED');
  });

  it('keeps an injected UNKNOWN unknown: no duplicate send, no manufactured failure, resolves only by reconciliation', async () => {
    const { fake, clock, activate } = makeFake();
    await activate();
    const { intent, executionReference } = await fake.createIntent(request());
    fake.injectExecutionOutcome(intent.commercialIntentId, 'UNKNOWN');
    const run = await fake.execute(executionReference);
    expect(run.events.map((e) => e.payload.state)).toEqual(['RESERVED', 'UNKNOWN']);
    const unknown = run.events[1]?.payload;
    expect(unknown?.nextReconcileAt).not.toBeNull();
    expect(unknown?.attempt).toMatchObject({ transportState: 'UNKNOWN', externalOutcomeState: 'UNKNOWN' });
    const operation = unknown?.attempt?.clientOperationId;

    const retry = await fake.execute(executionReference);
    expect(retry.events).toEqual([]);
    expect(retry.intent.state).toBe('UNKNOWN');
    expect(fake.attemptCount(intent.commercialIntentId)).toBe(1);

    clock.advance(120_000);
    const stillUnknown = await fake.reconcile(executionReference);
    expect(stillUnknown.events).toEqual([]);
    expect(stillUnknown.intent.state).toBe('UNKNOWN');

    fake.injectReconciliation(intent.commercialIntentId, 'CONFIRMED');
    const resolved = await fake.reconcile(executionReference);
    expect(resolved.events.map((e) => [e.payload.priorState, e.payload.state])).toEqual([['UNKNOWN', 'CONFIRMED']]);
    expect(resolved.events[0]?.payload.attempt?.clientOperationId).toBe(operation);
    expect(resolved.events[0]?.payload.attempt?.externalOutcomeState).toBe('CONFIRMED');
    expect(fake.attemptCount(intent.commercialIntentId)).toBe(1);
  });

  it('rejects forged, wrong-kind, expired or cross-tenant references without side effects', async () => {
    const { fake, clock } = makeFake();
    const { intent, executionReference } = await fake.createIntent(request());
    const forged = { ...executionReference, signature: { ...executionReference.signature, value: 'A'.repeat(43) } };
    expect(await codeOf(fake.execute(forged))).toBe('EXECUTION_REFERENCE_INVALID');
    const other = makeFake();
    const foreign = (await other.fake.createIntent(request())).executionReference;
    expect(await codeOf(fake.execute(foreign))).toBe('EXECUTION_REFERENCE_INVALID');
    const session = await fake.activateSession(
      fake.issueAuthorityReference(id('tenant') as never, id('executionAuthority') as never),
    );
    expect(session.kiteSessionId).toMatch(/^kss_/);
    const authorityRef = fake.issueAuthorityReference(id('tenant') as never, id('executionAuthority') as never);
    expect(await codeOf(fake.execute(authorityRef))).toBe('EXECUTION_REFERENCE_INVALID');
    expect(await codeOf(fake.activateSession(executionReference))).toBe('EXECUTION_REFERENCE_INVALID');
    clock.advance(10 * 60_000);
    expect(await codeOf(fake.execute(executionReference))).toBe('EXECUTION_REFERENCE_INVALID');
    expect((await fake.getIntent(intent.tenantId, intent.commercialIntentId))?.state).toBe('CREATED');
    expect(fake.attemptCount(intent.commercialIntentId)).toBe(0);
  });

  it('activates a Kite session idempotently and keeps an injected session UNKNOWN non-executable', async () => {
    const { fake } = makeFake();
    const ref = fake.issueAuthorityReference(id('tenant') as never, id('executionAuthority') as never);
    const s1 = await fake.activateSession(ref);
    const s2 = await fake.activateSession(ref);
    expect(s1.externalOutcomeState).toBe('CONFIRMED');
    expect(s2).toEqual(s1);

    const authority2 = id('executionAuthority', 'second001') as never;
    fake.injectSessionOutcome(authority2, 'UNKNOWN');
    const unknown = await fake.activateSession(fake.issueAuthorityReference(id('tenant') as never, authority2));
    expect(unknown).toMatchObject({
      transportState: 'UNKNOWN',
      externalOutcomeState: 'UNKNOWN',
      adapterCapability: 'ELIGIBLE',
    });
    expect(unknown.nextReconcileAt).not.toBeNull();
    const intent = await fake.createIntent(
      request({ executionAuthorityId: authority2, actionDigest: vdig('action', '7') }),
    );
    expect(await codeOf(fake.execute(intent.executionReference))).toBe('POLICY_HOLD');
    expect(fake.attemptCount(intent.intent.commercialIntentId)).toBe(0);
    // Without any session activation the reserve is equally blocked.
    const authority3 = id('executionAuthority', 'third0001');
    const noSession = await fake.createIntent(
      request({ executionAuthorityId: authority3, actionDigest: vdig('action', '8') }),
    );
    expect(await codeOf(fake.execute(noSession.executionReference))).toBe('POLICY_HOLD');
    expect((await fake.getIntent(noSession.intent.tenantId, noSession.intent.commercialIntentId))?.state).toBe(
      'CREATED',
    );
  });
});
