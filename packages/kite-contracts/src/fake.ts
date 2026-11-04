// IN-MEMORY CONTRACT FAKE of the commercial-intent broker port. It is NOT Kite and NOT the broker: it holds no
// credential, performs no network I/O, and labels every result `CONTRACT_FAKE`. It exists so M07/M10 can code and test
// against the port before M09 exists. All state changes go through the domain transition tables.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  CommercialIntentSchema,
  DomainError,
  KiteSessionSchema,
  addDuration,
  decodeWire,
  durationMs,
  encodeWire,
  instantFromEpochMs,
  newId,
  type CommercialIntent,
  type CommercialIntentId,
  type CorrelationId,
  type ExecutionAuthorityId,
  type KiteSession,
  type ProviderAccountRevisionId,
  type TenantId,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import { canonicalDigest, transition, type MachineName } from '@uptimebuyer/domain';
import {
  CommercialIntentRequestSchema,
  CommercialIntentStateChangedEventSchema,
  type CommercialIntentAttemptView,
  type CommercialIntentBrokerPort,
  type CommercialIntentRequest,
  type CommercialIntentStateChangedEvent,
  type CreateIntentResult,
  type IntentRunResult,
} from './port.js';
import {
  signExecutionReference,
  verifyExecutionReference,
  type ExecutionReferenceTarget,
  type SignedExecutionReference,
} from './reference.js';

export type FakeExecutionOutcome = 'ACCEPTED' | 'UNKNOWN' | 'DEFINITE_DECLINE';
export type FakeReconciliationOutcome = 'CONFIRMED' | 'ACCEPTED' | 'FAILED_NO_EFFECT';
export type FakeSessionOutcome = 'CONFIRMED' | 'UNKNOWN';

export type InMemoryCommercialIntentBrokerFakeOptions = {
  /** Synthetic HMAC key for references (>= 32 bytes). Tests generate it at runtime; it is never a Kite credential. */
  signingKey?: Uint8Array;
  keyId?: string;
  clock?: () => UtcInstant;
  referenceTtlMs?: number;
  reconcileAfterMs?: number;
  providerAccountRevisionId?: ProviderAccountRevisionId;
};

type IntentRecord = {
  intent: CommercialIntent;
  requestDigest: string;
  correlationId: CorrelationId;
  attempt: (CommercialIntentAttemptView & { nextReconcileAt: UtcInstant | null }) | null;
  lastEventId: string | null;
  execOutcome: FakeExecutionOutcome | null;
  reconOutcome: FakeReconciliationOutcome | null;
};

const step = (machine: MachineName, from: string, to: string): string => transition(machine, from, to).to;

export class InMemoryCommercialIntentBrokerFake implements CommercialIntentBrokerPort {
  readonly isContractFake = true as const;
  private readonly key: Uint8Array;
  private readonly keyId: string;
  private readonly now: () => UtcInstant;
  private readonly referenceTtlMs: number;
  private readonly reconcileAfterMs: number;
  private readonly providerAccountRevisionId: ProviderAccountRevisionId;
  private readonly intents = new Map<CommercialIntentId, IntentRecord>();
  private readonly byIdentity = new Map<string, CommercialIntentId>();
  private readonly byDigest = new Map<string, CommercialIntentId[]>();
  private readonly sessions = new Map<string, KiteSession>();
  private readonly sessionOutcomes = new Map<string, FakeSessionOutcome>();
  private readonly log: CommercialIntentStateChangedEvent[] = [];

  constructor(options: InMemoryCommercialIntentBrokerFakeOptions = {}) {
    this.key = options.signingKey ?? randomBytes(32);
    this.keyId = options.keyId ?? 'contract-fake';
    this.now = options.clock ?? (() => instantFromEpochMs(Date.now()));
    this.referenceTtlMs = options.referenceTtlMs ?? 5 * 60_000;
    this.reconcileAfterMs = options.reconcileAfterMs ?? 60_000;
    this.providerAccountRevisionId =
      options.providerAccountRevisionId ?? ('par_contract-fake' as ProviderAccountRevisionId);
  }

  // ----- test controls (fake only) -------------------------------------------------------------------------------

  injectExecutionOutcome(intentId: CommercialIntentId, outcome: FakeExecutionOutcome): void {
    this.record(intentId).execOutcome = outcome;
  }

  injectReconciliation(intentId: CommercialIntentId, outcome: FakeReconciliationOutcome): void {
    this.record(intentId).reconOutcome = outcome;
  }

  injectSessionOutcome(executionAuthorityId: ExecutionAuthorityId, outcome: FakeSessionOutcome): void {
    this.sessionOutcomes.set(executionAuthorityId, outcome);
  }

  /** Stands in for the authority service that issues an EXECUTION_AUTHORITY reference after issuance. */
  issueAuthorityReference(tenantId: TenantId, executionAuthorityId: ExecutionAuthorityId): SignedExecutionReference {
    return this.sign(tenantId, { kind: 'EXECUTION_AUTHORITY', executionAuthorityId });
  }

  intentCount(): number {
    return this.intents.size;
  }

  attemptCount(intentId: CommercialIntentId): number {
    return this.intents.get(intentId)?.attempt ? 1 : 0;
  }

  events(): readonly CommercialIntentStateChangedEvent[] {
    return [...this.log];
  }

  // ----- port ------------------------------------------------------------------------------------------------------

  async createIntent(request: CommercialIntentRequest): Promise<CreateIntentResult> {
    const clean = decodeWire(CommercialIntentRequestSchema, encodeWire(CommercialIntentRequestSchema, request));
    const { correlationId, requestedBy: _actor, idempotencyKey: _key, ...material } = clean;
    const requestDigest = canonicalDigest('intent-request', 1, material);
    const identity = `${clean.tenantId}|${clean.actionDigest}|${clean.executionAuthorityId}`;
    const existingId = this.byIdentity.get(identity);
    if (existingId) {
      const existing = this.record(existingId);
      if (existing.requestDigest !== requestDigest)
        throw new DomainError(
          'IDEMPOTENCY_KEY_REUSED',
          'This intent identity was already used for a different request.',
        );
      return this.createResult(existing, false);
    }
    const digestKey = `${clean.tenantId}|${clean.actionDigest}`;
    const priors = this.byDigest.get(digestKey) ?? [];
    if (priors.some((id) => this.record(id).intent.state !== 'FAILED'))
      throw new DomainError('INTENT_SUCCESSOR_BLOCKED', 'A prior intent for this action may have had an effect.');
    const intent = decodeWire(
      CommercialIntentSchema,
      encodeWire(CommercialIntentSchema, {
        commercialIntentId: newId('commercialIntent'),
        tenantId: clean.tenantId,
        incidentId: clean.incidentId,
        assetRevisionId: clean.assetRevisionId,
        subject: clean.subject,
        approvalId: clean.approvalId,
        executionAuthorityId: clean.executionAuthorityId,
        providerAccountRevisionId: clean.providerAccountRevisionId,
        actionDigest: clean.actionDigest,
        maxAmount: clean.expectedMax,
        state: 'CREATED',
        supersedesIntentId: priors.at(-1) ?? null,
        version: 1,
        createdAt: this.now(),
      }),
    );
    const rec: IntentRecord = {
      intent,
      requestDigest,
      correlationId,
      attempt: null,
      lastEventId: null,
      execOutcome: null,
      reconOutcome: null,
    };
    this.intents.set(intent.commercialIntentId, rec);
    this.byIdentity.set(identity, intent.commercialIntentId);
    this.byDigest.set(digestKey, [...priors, intent.commercialIntentId]);
    return this.createResult(rec, true);
  }

  async activateSession(reference: SignedExecutionReference): Promise<KiteSession> {
    const ref = this.verify(reference);
    if (ref.target.kind !== 'EXECUTION_AUTHORITY')
      throw new DomainError('EXECUTION_REFERENCE_INVALID', 'Execution reference rejected.', {
        reason: 'WRONG_TARGET_KIND',
      });
    const authorityId = ref.target.executionAuthorityId;
    const key = `${ref.tenantId}|${authorityId}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;
    let transport = step('ATTEMPT_TRANSPORT', 'PREPARED', 'SEND_STARTED');
    let outcome = step('KITE_SESSION', 'PROPOSED', 'AUTHORIZED');
    let nextReconcileAt: UtcInstant | null = null;
    let providerSessionRef: string | null = null;
    if ((this.sessionOutcomes.get(authorityId) ?? 'CONFIRMED') === 'UNKNOWN') {
      transport = step('ATTEMPT_TRANSPORT', transport, 'UNKNOWN');
      outcome = step('KITE_SESSION', outcome, 'UNKNOWN');
      nextReconcileAt = addDuration(this.now(), durationMs(this.reconcileAfterMs));
    } else {
      outcome = step('KITE_SESSION', outcome, 'REQUESTED');
      transport = step('ATTEMPT_TRANSPORT', transport, 'ACKNOWLEDGED');
      outcome = step('KITE_SESSION', outcome, 'ACCEPTED');
      outcome = step('KITE_SESSION', outcome, 'CONFIRMED');
      providerSessionRef = `fake-session-${randomUUID()}`;
    }
    const session = decodeWire(
      KiteSessionSchema,
      encodeWire(KiteSessionSchema, {
        kiteSessionId: newId('kiteSession'),
        tenantId: ref.tenantId,
        executionAuthorityId: authorityId,
        providerAccountRevisionId: this.providerAccountRevisionId,
        clientOperationId: newId('clientOperation'),
        idempotencyKey: `idem-${randomUUID()}`,
        requestDigest: `sha256:${createHash('sha256').update(key).digest('hex')}`,
        transportState: transport,
        externalOutcomeState: outcome,
        adapterCapability: 'ELIGIBLE',
        providerSessionRef,
        nextReconcileAt,
      } as never),
    );
    this.sessions.set(key, session);
    return session;
  }

  async execute(reference: SignedExecutionReference): Promise<IntentRunResult> {
    const rec = this.intentFor(reference);
    // Idempotent: a started intent is never sent again; ambiguity resolves only through reconcile().
    if (rec.intent.state !== 'CREATED') return { intent: rec.intent, events: [] };
    const session = this.sessions.get(`${rec.intent.tenantId}|${rec.intent.executionAuthorityId}`);
    if (session?.externalOutcomeState !== 'CONFIRMED')
      throw new DomainError('POLICY_HOLD', 'A paid reserve requires a CONFIRMED Kite session.', {
        reasonCode: 'KITE_SESSION_NOT_CONFIRMED',
      });

    const events: CommercialIntentStateChangedEvent[] = [];
    // Linearization: reserve and the SEND_STARTED marker commit together; the outcome is still only AUTHORIZED.
    rec.attempt = {
      externalAttemptId: newId('externalAttempt'),
      clientOperationId: newId('clientOperation'),
      idempotencyKey: `idem-${randomUUID()}` as CommercialIntentAttemptView['idempotencyKey'],
      transportState: step('ATTEMPT_TRANSPORT', 'PREPARED', 'SEND_STARTED') as 'SEND_STARTED',
      externalOutcomeState: step('EXTERNAL_ACTION', 'PROPOSED', 'AUTHORIZED') as 'AUTHORIZED',
      adapterCapability: 'ELIGIBLE',
      providerRef: null,
      nextReconcileAt: null,
    };
    events.push(this.move(rec, 'RESERVED', null));

    const a = rec.attempt;
    switch (rec.execOutcome ?? 'ACCEPTED') {
      case 'ACCEPTED':
        a.externalOutcomeState = this.external(a.externalOutcomeState, 'REQUESTED', 'ACCEPTED');
        a.transportState = step('ATTEMPT_TRANSPORT', a.transportState, 'ACKNOWLEDGED') as typeof a.transportState;
        a.providerRef = `fake-ref-${randomUUID()}` as typeof a.providerRef;
        events.push(this.move(rec, 'SUBMITTED', null));
        break;
      case 'UNKNOWN':
        a.externalOutcomeState = this.external(a.externalOutcomeState, 'UNKNOWN');
        a.transportState = step('ATTEMPT_TRANSPORT', a.transportState, 'UNKNOWN') as typeof a.transportState;
        a.nextReconcileAt = addDuration(this.now(), durationMs(this.reconcileAfterMs));
        events.push(this.move(rec, 'UNKNOWN', null));
        break;
      case 'DEFINITE_DECLINE':
        a.externalOutcomeState = this.external(a.externalOutcomeState, 'REQUESTED', 'FAILED');
        a.transportState = step('ATTEMPT_TRANSPORT', a.transportState, 'ACKNOWLEDGED') as typeof a.transportState;
        events.push(this.move(rec, 'FAILED', 'PROVIDER_DECLINED_NO_EFFECT'));
        break;
    }
    rec.execOutcome = null;
    return { intent: rec.intent, events };
  }

  async reconcile(reference: SignedExecutionReference): Promise<IntentRunResult> {
    const rec = this.intentFor(reference);
    const a = rec.attempt;
    const outcome = rec.reconOutcome;
    if (!a || !outcome || !['UNKNOWN', 'SUBMITTED'].includes(rec.intent.state))
      return { intent: rec.intent, events: [] };
    const events: CommercialIntentStateChangedEvent[] = [];
    if (outcome === 'CONFIRMED') {
      a.externalOutcomeState = this.external(a.externalOutcomeState, 'CONFIRMED');
      a.nextReconcileAt = null;
      events.push(this.move(rec, 'CONFIRMED', null));
    } else if (outcome === 'FAILED_NO_EFFECT') {
      a.externalOutcomeState = this.external(a.externalOutcomeState, 'FAILED');
      a.nextReconcileAt = null;
      events.push(this.move(rec, 'FAILED', 'NO_EFFECT_PROVED_BY_LOOKUP'));
    } else if (rec.intent.state === 'UNKNOWN') {
      a.externalOutcomeState = this.external(a.externalOutcomeState, 'ACCEPTED');
      a.nextReconcileAt = null;
      events.push(this.move(rec, 'SUBMITTED', null));
    }
    rec.reconOutcome = null;
    return { intent: rec.intent, events };
  }

  async getIntent(tenantId: TenantId, commercialIntentId: CommercialIntentId): Promise<CommercialIntent | null> {
    const rec = this.intents.get(commercialIntentId);
    return rec && rec.intent.tenantId === tenantId ? rec.intent : null;
  }

  // ----- internals -------------------------------------------------------------------------------------------------

  private record(intentId: CommercialIntentId): IntentRecord {
    const rec = this.intents.get(intentId);
    if (!rec) throw new DomainError('VALIDATION_FAILED', 'Unknown commercial intent.');
    return rec;
  }

  private external(from: CommercialIntentAttemptView['externalOutcomeState'], ...path: string[]) {
    let s: string = from;
    for (const to of path) s = step('EXTERNAL_ACTION', s, to);
    return s as CommercialIntentAttemptView['externalOutcomeState'];
  }

  private sign(tenantId: TenantId, target: ExecutionReferenceTarget): SignedExecutionReference {
    const issuedAt = this.now();
    return signExecutionReference(
      {
        referenceVersion: 1,
        tenantId,
        target,
        issuedAt,
        expiresAt: addDuration(issuedAt, durationMs(this.referenceTtlMs)),
        nonce: randomBytes(16).toString('base64url'),
      },
      this.key,
      this.keyId,
    );
  }

  private verify(reference: SignedExecutionReference): SignedExecutionReference {
    return verifyExecutionReference(reference, { [this.keyId]: this.key }, this.now());
  }

  private intentFor(reference: SignedExecutionReference): IntentRecord {
    const ref = this.verify(reference);
    const rec = ref.target.kind === 'COMMERCIAL_INTENT' ? this.intents.get(ref.target.commercialIntentId) : undefined;
    if (!rec || rec.intent.tenantId !== ref.tenantId)
      throw new DomainError('EXECUTION_REFERENCE_INVALID', 'Execution reference rejected.', { reason: 'WRONG_TARGET' });
    return rec;
  }

  private createResult(rec: IntentRecord, created: boolean): CreateIntentResult {
    return {
      intent: rec.intent,
      executionReference: this.sign(rec.intent.tenantId, {
        kind: 'COMMERCIAL_INTENT',
        commercialIntentId: rec.intent.commercialIntentId,
      }),
      created,
      resultOrigin: 'CONTRACT_FAKE',
    };
  }

  private move(
    rec: IntentRecord,
    to: CommercialIntent['state'],
    reasonCode: string | null,
  ): CommercialIntentStateChangedEvent {
    const prior = rec.intent.state;
    step('ECONOMIC_INTENT', prior, to);
    rec.intent = { ...rec.intent, state: to, version: rec.intent.version + 1 };
    const a = rec.attempt;
    const event = decodeWire(
      CommercialIntentStateChangedEventSchema,
      encodeWire(CommercialIntentStateChangedEventSchema, {
        eventId: newId('event'),
        eventType: 'commercial_intent.state_changed.v1',
        occurredAt: this.now(),
        tenantId: rec.intent.tenantId,
        aggregateType: 'commercial_intent',
        aggregateId: rec.intent.commercialIntentId,
        aggregateVersion: rec.intent.version,
        correlationId: rec.correlationId,
        causationId: rec.lastEventId ?? newId('command'),
        schemaVersion: 1,
        payload: {
          commercialIntentId: rec.intent.commercialIntentId,
          actionDigest: rec.intent.actionDigest,
          executionAuthorityId: rec.intent.executionAuthorityId,
          priorState: prior,
          state: to,
          attempt: a
            ? {
                externalAttemptId: a.externalAttemptId,
                clientOperationId: a.clientOperationId,
                idempotencyKey: a.idempotencyKey,
                transportState: a.transportState,
                externalOutcomeState: a.externalOutcomeState,
                adapterCapability: a.adapterCapability,
                providerRef: a.providerRef,
              }
            : null,
          reasonCode,
          nextReconcileAt: to === 'UNKNOWN' ? (a?.nextReconcileAt ?? null) : null,
          resultOrigin: 'CONTRACT_FAKE',
        },
      } as never),
    );
    rec.lastEventId = event.eventId;
    this.log.push(event);
    return event;
  }
}
