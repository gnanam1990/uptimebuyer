// M09 outbox events (API-EVENT-SPEC §6). Every event is appended inside the domain transaction that made the change,
// validated against its typed schema first, and carries no credential, payment header or contact value.
import {
  ActionKindSchema,
  ApprovalIdSchema,
  CommercialIntentIdSchema,
  ExecutionAuthorityIdSchema,
  ExecutionAuthoritySessionChangedEventSchema,
  ExecutionAuthorityStateChangedEventSchema,
  ExternalAttemptIdSchema,
  ExternalAttemptSendStartedEventSchema,
  AdapterCapabilitySchema,
  AttemptTransportStateSchema,
  ClientOperationIdSchema,
  ExternalOutcomeStateSchema,
  ProviderRefSchema,
  ReasonCodeSchema,
  UtcInstantSchema,
  VersionedDigestSchema,
  defineDomainEvent,
  encodeWire,
  newId,
  type EventType,
  type UtcInstant,
} from '@uptimebuyer/contracts';
import { canonicalize } from '@uptimebuyer/domain';
import {
  appendOutboxEvent,
  appendRecordEvidence,
  dbNow,
  sha256Digest,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import {
  CommercialIntentStateChangedEventSchema,
  type CommercialIntentAttemptView,
  type CommercialIntentStateChangedEvent,
} from '@uptimebuyer/kite-contracts';
import { z } from 'zod';
import { actorFields, newCommerceId } from './internal.js';

export const RESULT_ORIGIN = 'KITE_BROKER' as const;

const MinorString = z.string().regex(/^-?[0-9]{1,19}$/);

export const ExecutionAuthorityIssuedEventSchema = defineDomainEvent(
  'execution_authority.issued.v1',
  z.strictObject({
    executionAuthorityId: ExecutionAuthorityIdSchema,
    approvalId: ApprovalIdSchema,
    actionDigest: VersionedDigestSchema,
    allowedActionKinds: z.array(ActionKindSchema).min(1),
    perActionLimitMinor: MinorString,
    baseLimitMinor: MinorString,
    currency: z.string().regex(/^[A-Z]{3}$/),
    expiresAt: UtcInstantSchema,
    scopeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
  'executionAuthorityId',
);

export const CommercialIntentCreatedEventSchema = defineDomainEvent(
  'commercial_intent.created.v1',
  z.strictObject({
    commercialIntentId: CommercialIntentIdSchema,
    executionAuthorityId: ExecutionAuthorityIdSchema,
    actionDigest: VersionedDigestSchema,
    subjectType: z.enum(['PLAN_ACTION', 'PROVIDER_CONTACT_REQUEST']),
    subjectId: z.string(),
    state: z.literal('CREATED'),
    supersedesIntentId: CommercialIntentIdSchema.nullable(),
    resultOrigin: z.literal(RESULT_ORIGIN),
  }),
  'commercialIntentId',
);

const AttemptPayload = z.strictObject({
  externalAttemptId: ExternalAttemptIdSchema,
  commercialIntentId: CommercialIntentIdSchema,
  clientOperationId: ClientOperationIdSchema,
  transportState: AttemptTransportStateSchema,
  externalOutcomeState: ExternalOutcomeStateSchema,
  adapterCapability: AdapterCapabilitySchema,
  providerRef: ProviderRefSchema.nullable(),
  reasonCode: ReasonCodeSchema.nullable(),
  nextReconcileAt: UtcInstantSchema.nullable(),
  resultOrigin: z.literal(RESULT_ORIGIN),
});
const attemptEvent = (t: EventType) => defineDomainEvent(t, AttemptPayload, 'externalAttemptId');
export const ATTEMPT_EVENT_SCHEMAS = {
  'external_attempt.accepted.v1': attemptEvent('external_attempt.accepted.v1'),
  'external_attempt.unknown.v1': attemptEvent('external_attempt.unknown.v1'),
  'external_attempt.reconciled.v1': attemptEvent('external_attempt.reconciled.v1'),
  'external_attempt.capability_changed.v1': attemptEvent('external_attempt.capability_changed.v1'),
} as const;
export type AttemptEventType = keyof typeof ATTEMPT_EVENT_SCHEMAS;

export const BudgetMovementRecordedEventSchema = defineDomainEvent(
  'budget.movement_recorded.v1',
  z.strictObject({
    budgetAccountId: z.string().regex(/^bac_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
    executionAuthorityId: ExecutionAuthorityIdSchema,
    ledgerEntryId: z.string().regex(/^ble_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/),
    movementType: z.enum([
      'AUTHORITY_CREDIT',
      'AUTHORITY_DEBIT',
      'RESERVE',
      'RELEASE',
      'CAPTURE',
      'REFUND',
      'REVERSAL',
    ]),
    amountMinor: MinorString,
    currency: z.string().regex(/^[A-Z]{3}$/),
    commercialIntentId: CommercialIntentIdSchema.nullable(),
    effectiveLimitMinor: MinorString,
    openReservedMinor: MinorString,
    grossCapturedMinor: MinorString,
    returnedMinor: MinorString,
    netSettledMinor: MinorString,
    availableMinor: MinorString,
  }),
  'budgetAccountId',
);

type AnySchema = Parameters<typeof encodeWire>[0];

/** Validate then append; returns the envelope exactly as stored (same eventId and occurredAt). */
/** M13 (FR-18): the ledger record that accompanies an event (kind/trust fixed by server code). */
interface LedgerSpec {
  kind: 'PAYMENT_STATE' | 'EXTERNAL_ACTION';
  trust: 'AUTHORITATIVE' | 'PROVIDER_REPORTED' | 'CONTRACT_FAKE';
  incidentId: string | null;
}
/** Results from the recorded contract or the local stand-in are never presented as provider-reported truth. */
const trustOf = (attempt: { result_origin?: unknown } | null): LedgerSpec['trust'] =>
  attempt === null
    ? 'AUTHORITATIVE'
    : attempt.result_origin === 'KITE_PASSPORT'
      ? 'PROVIDER_REPORTED'
      : 'CONTRACT_FAKE';

async function emit<T>(
  c: Tx,
  ctx: TenantContext,
  schema: AnySchema,
  event: {
    eventType: EventType;
    aggregateType: string;
    aggregateId: string;
    aggregateVersion: number;
    correlationId: string;
    payload: Record<string, unknown>;
  },
  ledger?: LedgerSpec,
): Promise<T> {
  const occurredAt = await dbNow(c);
  const causationId = newId('command');
  const draft = {
    eventId: newId('event'),
    occurredAt,
    tenantId: ctx.tenantId,
    schemaVersion: 1,
    causationId,
    ...event,
  };
  const wire = encodeWire(schema, draft as never) as { payload: Record<string, unknown> };
  const eventId = await appendOutboxEvent(c, ctx, {
    eventType: event.eventType,
    aggregateType: event.aggregateType as never,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    payload: wire.payload,
    correlationId: event.correlationId,
    causationId,
    occurredAt: occurredAt as UtcInstant,
  });
  if (ledger)
    await appendRecordEvidence(c, ctx, {
      kind: ledger.kind,
      trust: ledger.trust,
      subject: { aggregateType: event.aggregateType as never, aggregateId: event.aggregateId },
      incidentId: ledger.incidentId,
      payloadSchema: event.eventType,
      payloadDigest: sha256Digest(canonicalize(wire.payload as never)),
      payloadRef: null,
      supersedesEvidenceId: null,
      correlation: { correlationId: event.correlationId as never, causationId: causationId as never },
    });
  return { ...draft, eventId } as T;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const attemptView = (a: any): CommercialIntentAttemptView =>
  ({
    externalAttemptId: a.id,
    clientOperationId: a.client_operation_id,
    idempotencyKey: a.idempotency_key,
    transportState: a.transport_state,
    externalOutcomeState: a.external_outcome_state,
    adapterCapability: a.adapter_capability,
    providerRef: a.provider_ref,
  }) as CommercialIntentAttemptView;

const isoOrNull = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

export async function emitIntentCreated(c: Tx, ctx: TenantContext, i: any) {
  return emit(
    c,
    ctx,
    CommercialIntentCreatedEventSchema,
    {
      eventType: 'commercial_intent.created.v1',
      aggregateType: 'commercial_intent',
      aggregateId: i.id,
      aggregateVersion: i.version,
      correlationId: i.correlation_id,
      payload: {
        commercialIntentId: i.id,
        executionAuthorityId: i.execution_authority_id,
        actionDigest: i.action_digest,
        subjectType: i.subject_type,
        subjectId: i.subject_id,
        state: 'CREATED',
        supersedesIntentId: i.supersedes_intent_id,
        resultOrigin: RESULT_ORIGIN,
      },
    },
    { kind: 'PAYMENT_STATE', trust: 'AUTHORITATIVE', incidentId: i.incident_id ?? null },
  );
}

export async function emitIntentStateChanged(
  c: Tx,
  ctx: TenantContext,
  i: any,
  priorState: string,
  attempt: any | null,
  reasonCode: string | null,
): Promise<CommercialIntentStateChangedEvent> {
  return emit<CommercialIntentStateChangedEvent>(
    c,
    ctx,
    CommercialIntentStateChangedEventSchema,
    {
      eventType: 'commercial_intent.state_changed.v1',
      aggregateType: 'commercial_intent',
      aggregateId: i.id,
      aggregateVersion: i.version,
      correlationId: i.correlation_id,
      payload: {
        commercialIntentId: i.id,
        actionDigest: i.action_digest,
        executionAuthorityId: i.execution_authority_id,
        priorState,
        state: i.state,
        attempt: attempt ? attemptView(attempt) : null,
        reasonCode,
        nextReconcileAt: i.state === 'UNKNOWN' && attempt ? isoOrNull(attempt.next_reconcile_at) : null,
        resultOrigin: RESULT_ORIGIN,
      },
    },
    { kind: 'PAYMENT_STATE', trust: trustOf(attempt), incidentId: i.incident_id ?? null },
  );
}

export async function emitSendStarted(c: Tx, ctx: TenantContext, i: any, a: any) {
  return emit(
    c,
    ctx,
    ExternalAttemptSendStartedEventSchema,
    {
      eventType: 'external_attempt.send_started.v1',
      aggregateType: 'external_attempt',
      aggregateId: a.id,
      aggregateVersion: a.version,
      correlationId: i.correlation_id,
      payload: {
        externalAttemptId: a.id,
        commercialIntentId: i.id,
        providerAccountRevisionId: a.provider_account_revision_id,
        clientOperationId: a.client_operation_id,
        idempotencyKey: a.idempotency_key,
        requestDigest: a.request_digest,
        transportState: 'SEND_STARTED',
        externalOutcomeState: 'AUTHORIZED',
        economicIntentState: 'RESERVED',
        reserved: { amountMinor: BigInt(i.open_reserved_minor), currency: i.currency },
      },
    },
    { kind: 'EXTERNAL_ACTION', trust: 'AUTHORITATIVE', incidentId: i.incident_id ?? null },
  );
}

export async function emitAttemptEvent(c: Tx, ctx: TenantContext, type: AttemptEventType, i: any, a: any) {
  return emit(
    c,
    ctx,
    ATTEMPT_EVENT_SCHEMAS[type],
    {
      eventType: type,
      aggregateType: 'external_attempt',
      aggregateId: a.id,
      aggregateVersion: a.version,
      correlationId: i.correlation_id,
      payload: {
        externalAttemptId: a.id,
        commercialIntentId: i.id,
        clientOperationId: a.client_operation_id,
        transportState: a.transport_state,
        externalOutcomeState: a.external_outcome_state,
        adapterCapability: a.adapter_capability,
        providerRef: a.provider_ref,
        reasonCode: a.reason_code,
        nextReconcileAt: isoOrNull(a.next_reconcile_at),
        resultOrigin: RESULT_ORIGIN,
      },
    },
    { kind: 'EXTERNAL_ACTION', trust: trustOf(a), incidentId: i.incident_id ?? null },
  );
}

export async function emitBudgetMovement(c: Tx, ctx: TenantContext, entry: any, account: any, correlationId: string) {
  return emit(c, ctx, BudgetMovementRecordedEventSchema, {
    eventType: 'budget.movement_recorded.v1',
    aggregateType: 'budget_account',
    aggregateId: account.id,
    aggregateVersion: account.version,
    correlationId,
    payload: {
      budgetAccountId: account.id,
      executionAuthorityId: account.execution_authority_id,
      ledgerEntryId: entry.id,
      movementType: entry.movement_type,
      amountMinor: String(entry.amount_minor),
      currency: entry.currency,
      commercialIntentId: entry.intent_id,
      effectiveLimitMinor: String(account.effective_limit_minor),
      openReservedMinor: String(account.open_reserved_minor),
      grossCapturedMinor: String(account.gross_captured_minor),
      returnedMinor: String(BigInt(account.refunded_minor) + BigInt(account.reversed_minor)),
      netSettledMinor: String(account.net_settled_minor),
      availableMinor: String(account.available_minor),
    },
  });
}

export async function emitAuthorityIssued(c: Tx, ctx: TenantContext, x: any) {
  return emit(c, ctx, ExecutionAuthorityIssuedEventSchema, {
    eventType: 'execution_authority.issued.v1',
    aggregateType: 'execution_authority',
    aggregateId: x.id,
    aggregateVersion: 1,
    correlationId: ctx.correlationId,
    payload: {
      executionAuthorityId: x.id,
      approvalId: x.approval_id,
      actionDigest: x.action_digest,
      allowedActionKinds: x.allowed_action_kinds,
      perActionLimitMinor: String(x.per_action_limit_minor),
      baseLimitMinor: String(x.base_limit_minor),
      currency: x.currency,
      expiresAt: new Date(x.expires_at).toISOString(),
      scopeDigest: x.scope_digest,
    },
  });
}

export async function emitAuthorityStateChanged(
  c: Tx,
  ctx: TenantContext,
  x: any,
  from: string,
  reasonCode: string,
  effectiveAt: string,
) {
  return emit(c, ctx, ExecutionAuthorityStateChangedEventSchema, {
    eventType: 'execution_authority.state_changed.v1',
    aggregateType: 'execution_authority',
    aggregateId: x.id,
    aggregateVersion: x.version,
    correlationId: ctx.correlationId,
    payload: { executionAuthorityId: x.id, from, to: x.status, reasonCode, effectiveAt },
  });
}

export async function emitSessionChanged(c: Tx, ctx: TenantContext, s: any) {
  return emit(c, ctx, ExecutionAuthoritySessionChangedEventSchema, {
    eventType: 'execution_authority.session_changed.v1',
    aggregateType: 'execution_authority',
    aggregateId: s.execution_authority_id,
    aggregateVersion: s.version,
    correlationId: ctx.correlationId,
    payload: {
      executionAuthorityId: s.execution_authority_id,
      kiteSessionId: s.id,
      transportState: s.transport_state,
      externalOutcomeState: s.external_outcome_state,
      adapterCapability: s.adapter_capability,
      providerSessionRef: s.provider_session_ref,
    },
  });
}

/** Append-only intent transition record (sequence 1 is the creation). */
export async function recordIntentTransition(
  c: Tx,
  ctx: TenantContext,
  intentId: string,
  from: string | null,
  to: string,
  reasonCode: string,
): Promise<void> {
  const actor = actorFields(ctx);
  await c.query(
    `INSERT INTO commercial_intent_transitions (tenant_id, id, intent_id, sequence, from_state, to_state, reason_code,
       actor_kind, actor_id)
     SELECT $1, $2, $3, coalesce(max(sequence), 0) + 1, $4, $5, $6, $7, $8
       FROM commercial_intent_transitions WHERE tenant_id = $1 AND intent_id = $3`,
    [ctx.tenantId, newCommerceId('intentTransition'), intentId, from, to, reasonCode, actor.kind, actor.id],
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */
