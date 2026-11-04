// Domain event envelope and catalog (API-EVENT-SPEC §5–6). Consumers reject unknown event types and unknown major
// schema versions; typed event schemas pin event type, aggregate type and a strict payload.
import { z } from 'zod';
import { EvidenceRefSchema } from './adapter.js';
import { ProviderRefSchema, ReasonCodeSchema, Sha256DigestSchema } from './codes.js';
import {
  CausationIdSchema,
  ClientOperationIdSchema,
  CommercialIntentIdSchema,
  CorrelationIdSchema,
  EventIdSchema,
  ExecutionAuthorityIdSchema,
  ExternalAttemptIdSchema,
  IdempotencyKeySchema,
  IncidentIdSchema,
  KiteSessionIdSchema,
  OpaqueIdSchema,
  ProviderAccountRevisionIdSchema,
  PurchaseOrderIdSchema,
  RecoveryEvaluationIdSchema,
  ServiceJobIdSchema,
  TenantIdSchema,
} from './ids.js';
import { MoneySchema } from './money.js';
import {
  AdapterCapabilitySchema,
  AttemptTransportStateSchema,
  ExecutionAuthorityStateSchema,
  IncidentStateSchema,
  KiteSessionStateSchema,
  PurchaseOrderStateSchema,
  RecoveryEvaluationStateSchema,
  ServiceJobStateSchema,
} from './states.js';
import { UtcInstantSchema } from './time.js';

/** Event type -> aggregate type. Keys are exactly the API-EVENT-SPEC §6 catalog. */
export const EVENT_CATALOG = Object.freeze({
  'telemetry.accepted.v1': 'device',
  'device.asset_assignment_changed.v1': 'device',
  'sensor_channel.revision_changed.v1': 'sensor_channel',
  'telemetry.stale.v1': 'device',
  'incident.opened.v1': 'incident',
  'incident.state_changed.v1': 'incident',
  'incident.assignment_changed.v1': 'incident',
  'incident.assignment_accepted.v1': 'incident',
  'incident.deadline_changed.v1': 'incident',
  'evidence.revision_committed.v1': 'evidence_revision',
  'reasoning.completed.v1': 'reasoning_run',
  'compatibility.evaluated.v1': 'compatibility_decision',
  'plan.created.v1': 'plan',
  'plan.invalidated.v1': 'plan',
  'approval.recorded.v1': 'approval',
  'execution_authority.issued.v1': 'execution_authority',
  'execution_authority.state_changed.v1': 'execution_authority',
  'execution_authority.session_changed.v1': 'execution_authority',
  'provider.search_completed.v1': 'provider_search',
  'provider.contact_requested.v1': 'provider_contact_request',
  'provider.contact_attempted.v1': 'provider_contact_attempt',
  'provider.communication_recorded.v1': 'provider_communication',
  'provider.quote_recorded.v1': 'provider_quote',
  'commercial_intent.created.v1': 'commercial_intent',
  'commercial_intent.state_changed.v1': 'commercial_intent',
  'external_attempt.send_started.v1': 'external_attempt',
  'external_attempt.accepted.v1': 'external_attempt',
  'external_attempt.capability_changed.v1': 'external_attempt',
  'external_attempt.unknown.v1': 'external_attempt',
  'external_attempt.reconciled.v1': 'external_attempt',
  'budget.movement_recorded.v1': 'budget_account',
  'purchase_order.state_changed.v1': 'purchase_order',
  'service_job.state_changed.v1': 'service_job',
  'intervention.milestone_recorded.v1': 'intervention_milestone',
  'recovery.assessed.v1': 'recovery_evaluation',
  'incident.recovered.v1': 'incident',
  'incident.reopened.v1': 'incident',
} as const);
export type EventType = keyof typeof EVENT_CATALOG;
export const EVENT_TYPES = Object.freeze(Object.keys(EVENT_CATALOG)) as readonly EventType[];
export const EventTypeSchema = z.enum(EVENT_TYPES as [EventType, ...EventType[]]);

export const AGGREGATE_TYPES = Object.freeze([
  ...new Set<string>([...Object.values(EVENT_CATALOG), 'site', 'asset', 'policy_revision']),
]) as readonly AggregateType[];
export type AggregateType = (typeof EVENT_CATALOG)[EventType] | 'site' | 'asset' | 'policy_revision';
export const AggregateTypeSchema = z.enum(AGGREGATE_TYPES as [AggregateType, ...AggregateType[]]);

const envelopeFields = {
  eventId: EventIdSchema,
  occurredAt: UtcInstantSchema,
  tenantId: TenantIdSchema,
  aggregateId: OpaqueIdSchema,
  aggregateVersion: z.int().min(1),
  correlationId: CorrelationIdSchema,
  causationId: CausationIdSchema,
  schemaVersion: z.literal(1),
};

/** Generic envelope: any catalog event with an object payload. Typed schemas below are strict about payloads. */
export const DomainEventEnvelopeSchema = z
  .strictObject({
    ...envelopeFields,
    eventType: EventTypeSchema,
    aggregateType: AggregateTypeSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .superRefine((e, ctx) => {
    if (EVENT_CATALOG[e.eventType] !== e.aggregateType)
      ctx.addIssue({
        code: 'custom',
        path: ['aggregateType'],
        message: 'Aggregate type does not match the event type.',
      });
  });
export type DomainEventEnvelope = z.output<typeof DomainEventEnvelopeSchema>;

/**
 * Build a strict typed event schema. When `aggregateIdField` is given, the payload field must equal `aggregateId`.
 * Every module defines its own payloads through this factory so envelopes stay uniform.
 */
export function defineDomainEvent<T extends EventType, P extends z.ZodType>(
  eventType: T,
  payload: P,
  aggregateIdField?: string,
) {
  return z
    .strictObject({
      ...envelopeFields,
      eventType: z.literal(eventType),
      aggregateType: z.literal(EVENT_CATALOG[eventType] as (typeof EVENT_CATALOG)[T]),
      payload,
    })
    .superRefine((e, ctx) => {
      if (aggregateIdField && (e as { payload: Record<string, unknown> }).payload[aggregateIdField] !== e.aggregateId)
        ctx.addIssue({
          code: 'custom',
          path: ['aggregateId'],
          message: `aggregateId must equal payload.${aggregateIdField}.`,
        });
    });
}

export const IncidentStateChangedPayloadSchema = z.strictObject({
  incidentId: IncidentIdSchema,
  from: IncidentStateSchema,
  to: IncidentStateSchema,
  reasonCode: ReasonCodeSchema,
  pausedFromState: IncidentStateSchema.nullable(),
});
export const IncidentStateChangedEventSchema = defineDomainEvent(
  'incident.state_changed.v1',
  IncidentStateChangedPayloadSchema,
  'incidentId',
);

/** The durable pre-egress marker. It is not external REQUESTED; the economic intent is still RESERVED. */
export const ExternalAttemptSendStartedPayloadSchema = z.strictObject({
  externalAttemptId: ExternalAttemptIdSchema,
  commercialIntentId: CommercialIntentIdSchema,
  providerAccountRevisionId: ProviderAccountRevisionIdSchema,
  clientOperationId: ClientOperationIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  requestDigest: Sha256DigestSchema,
  transportState: z.literal('SEND_STARTED'),
  externalOutcomeState: z.literal('AUTHORIZED'),
  economicIntentState: z.literal('RESERVED'),
  reserved: MoneySchema,
});
export const ExternalAttemptSendStartedEventSchema = defineDomainEvent(
  'external_attempt.send_started.v1',
  ExternalAttemptSendStartedPayloadSchema,
  'externalAttemptId',
);

const rawProvider = {
  rawProviderStatus: z.string().min(1).max(256).nullable(),
  rawEvidence: EvidenceRefSchema.nullable(),
};

export const PurchaseOrderStateChangedPayloadSchema = z.strictObject({
  purchaseOrderId: PurchaseOrderIdSchema,
  from: PurchaseOrderStateSchema,
  to: PurchaseOrderStateSchema,
  ...rawProvider,
});
export const PurchaseOrderStateChangedEventSchema = defineDomainEvent(
  'purchase_order.state_changed.v1',
  PurchaseOrderStateChangedPayloadSchema,
  'purchaseOrderId',
);

export const ServiceJobStateChangedPayloadSchema = z.strictObject({
  serviceJobId: ServiceJobIdSchema,
  from: ServiceJobStateSchema,
  to: ServiceJobStateSchema,
  ...rawProvider,
});
export const ServiceJobStateChangedEventSchema = defineDomainEvent(
  'service_job.state_changed.v1',
  ServiceJobStateChangedPayloadSchema,
  'serviceJobId',
);

export const ExecutionAuthorityStateChangedPayloadSchema = z.strictObject({
  executionAuthorityId: ExecutionAuthorityIdSchema,
  from: ExecutionAuthorityStateSchema,
  to: ExecutionAuthorityStateSchema,
  reasonCode: ReasonCodeSchema,
  effectiveAt: UtcInstantSchema,
});
export const ExecutionAuthorityStateChangedEventSchema = defineDomainEvent(
  'execution_authority.state_changed.v1',
  ExecutionAuthorityStateChangedPayloadSchema,
  'executionAuthorityId',
);

export const ExecutionAuthoritySessionChangedPayloadSchema = z.strictObject({
  executionAuthorityId: ExecutionAuthorityIdSchema,
  kiteSessionId: KiteSessionIdSchema,
  transportState: AttemptTransportStateSchema,
  externalOutcomeState: KiteSessionStateSchema,
  adapterCapability: AdapterCapabilitySchema,
  providerSessionRef: ProviderRefSchema.nullable(),
});
export const ExecutionAuthoritySessionChangedEventSchema = defineDomainEvent(
  'execution_authority.session_changed.v1',
  ExecutionAuthoritySessionChangedPayloadSchema,
  'executionAuthorityId',
);

export const RecoveryAssessedPayloadSchema = z.strictObject({
  recoveryEvaluationId: RecoveryEvaluationIdSchema,
  incidentId: IncidentIdSchema,
  from: RecoveryEvaluationStateSchema,
  to: RecoveryEvaluationStateSchema,
  reasonCode: ReasonCodeSchema.nullable(),
});
export const RecoveryAssessedEventSchema = defineDomainEvent(
  'recovery.assessed.v1',
  RecoveryAssessedPayloadSchema,
  'recoveryEvaluationId',
);

export type IncidentStateChangedEvent = z.output<typeof IncidentStateChangedEventSchema>;
export type ExternalAttemptSendStartedEvent = z.output<typeof ExternalAttemptSendStartedEventSchema>;
export type PurchaseOrderStateChangedEvent = z.output<typeof PurchaseOrderStateChangedEventSchema>;
export type ServiceJobStateChangedEvent = z.output<typeof ServiceJobStateChangedEventSchema>;
export type ExecutionAuthorityStateChangedEvent = z.output<typeof ExecutionAuthorityStateChangedEventSchema>;
export type ExecutionAuthoritySessionChangedEvent = z.output<typeof ExecutionAuthoritySessionChangedEventSchema>;
export type RecoveryAssessedEvent = z.output<typeof RecoveryAssessedEventSchema>;
