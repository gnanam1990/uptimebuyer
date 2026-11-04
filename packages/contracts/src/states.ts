// Canonical state vocabularies (CORE-CONTRACT "Canonical state vocabulary", STATE-MACHINES.md).
// Every axis is a SEPARATE enum: transport, normalized external outcome, adapter capability, economic intent,
// execution authority and Kite session are never one overloaded status, even where they share a word.
import { z } from 'zod';

export const INCIDENT_STATES = Object.freeze([
  'DETECTED',
  'TRIAGING',
  'AWAITING_EVIDENCE',
  'PLANNING',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'VERIFYING',
  'RECOVERED',
  'ESCALATED',
  'PAUSED',
  'REOPENED',
] as const);
export const IncidentStateSchema = z.enum(INCIDENT_STATES);
export type IncidentState = z.infer<typeof IncidentStateSchema>;
/** States an operator may pause from, and therefore the only legal resume targets. */
export const INCIDENT_PAUSABLE_STATES = Object.freeze([
  'TRIAGING',
  'AWAITING_EVIDENCE',
  'PLANNING',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'VERIFYING',
] as const satisfies readonly IncidentState[]);

export const EVIDENCE_REVISION_STATES = Object.freeze(['DRAFT', 'VALIDATING', 'COMMITTED', 'REJECTED'] as const);
export const EvidenceRevisionStateSchema = z.enum(EVIDENCE_REVISION_STATES);
export type EvidenceRevisionState = z.infer<typeof EvidenceRevisionStateSchema>;

/** Immutable decision value. `UNEVALUATED` is the absence of a row, never a value. */
export const COMPATIBILITY_DECISIONS = Object.freeze(['ALLOW', 'HOLD', 'REJECT'] as const);
export const CompatibilityDecisionValueSchema = z.enum(COMPATIBILITY_DECISIONS);
export type CompatibilityDecisionValue = z.infer<typeof CompatibilityDecisionValueSchema>;

/** Separate lifecycle column of a decision row. */
export const COMPATIBILITY_LIFECYCLES = Object.freeze(['CURRENT', 'SUPERSEDED'] as const);
export const CompatibilityLifecycleSchema = z.enum(COMPATIBILITY_LIFECYCLES);
export type CompatibilityLifecycle = z.infer<typeof CompatibilityLifecycleSchema>;

export const RECOVERY_PLAN_STATES = Object.freeze([
  'DRAFT',
  'EVALUATED',
  'APPROVABLE',
  'APPROVED',
  'EXECUTING',
  'COMPLETED',
  'HELD',
  'REJECTED',
  'INVALIDATED',
] as const);
export const RecoveryPlanStateSchema = z.enum(RECOVERY_PLAN_STATES);
export type RecoveryPlanState = z.infer<typeof RecoveryPlanStateSchema>;

/** Local bounded authority lifecycle; says nothing about whether Kite created a session. */
export const EXECUTION_AUTHORITY_STATES = Object.freeze(['ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED'] as const);
export const ExecutionAuthorityStateSchema = z.enum(EXECUTION_AUTHORITY_STATES);
export type ExecutionAuthorityState = z.infer<typeof ExecutionAuthorityStateSchema>;

/** Normalized external outcome of a provider/Kite action (INV-12). */
export const EXTERNAL_OUTCOME_STATES = Object.freeze([
  'PROPOSED',
  'AUTHORIZED',
  'REQUESTED',
  'ACCEPTED',
  'CONFIRMED',
  'UNKNOWN',
  'FAILED',
  'CANCELLED',
] as const);
export const ExternalOutcomeStateSchema = z.enum(EXTERNAL_OUTCOME_STATES);
export type ExternalOutcomeState = z.infer<typeof ExternalOutcomeStateSchema>;

/** External Kite-session activation outcome; same vocabulary as external actions, separate axis from authority. */
export const KITE_SESSION_STATES = EXTERNAL_OUTCOME_STATES;
export const KiteSessionStateSchema = z.enum(KITE_SESSION_STATES);
export type KiteSessionState = z.infer<typeof KiteSessionStateSchema>;

/** Adapter capability: a pre-egress/diagnostic axis, never an external outcome. */
export const ADAPTER_CAPABILITIES = Object.freeze(['ELIGIBLE', 'UNSUPPORTED'] as const);
export const AdapterCapabilitySchema = z.enum(ADAPTER_CAPABILITIES);
export type AdapterCapability = z.infer<typeof AdapterCapabilitySchema>;

/** Attempt transport substate; `SEND_STARTED` is a durable pre-egress marker, not external `REQUESTED`. */
export const ATTEMPT_TRANSPORT_STATES = Object.freeze([
  'PREPARED',
  'SEND_STARTED',
  'ACKNOWLEDGED',
  'UNKNOWN',
  'DEFINITE_NO_EFFECT',
] as const);
export const AttemptTransportStateSchema = z.enum(ATTEMPT_TRANSPORT_STATES);
export type AttemptTransportState = z.infer<typeof AttemptTransportStateSchema>;

export const ECONOMIC_INTENT_STATES = Object.freeze([
  'CREATED',
  'RESERVED',
  'SUBMITTED',
  'CONFIRMED',
  'UNKNOWN',
  'FAILED',
  'REFUNDED',
  'REVERSED',
] as const);
export const EconomicIntentStateSchema = z.enum(ECONOMIC_INTENT_STATES);
export type EconomicIntentState = z.infer<typeof EconomicIntentStateSchema>;

export const PURCHASE_ORDER_STATES = Object.freeze([
  'REQUESTED',
  'ACCEPTED',
  'ORDERED',
  'PARTIALLY_FILLED',
  'SHIPPED',
  'DELIVERED',
  'VERIFIED',
  'DISPUTED',
  'SUBSTITUTION_PROPOSED',
  'CHANGE_REVIEW',
  'REJECTED',
  'CANCELLED',
  'FAILED',
  'UNKNOWN',
] as const);
export const PurchaseOrderStateSchema = z.enum(PURCHASE_ORDER_STATES);
export type PurchaseOrderState = z.infer<typeof PurchaseOrderStateSchema>;

export const SERVICE_JOB_STATES = Object.freeze([
  'REQUESTED',
  'ACCEPTED',
  'SCHEDULED',
  'RESCHEDULED',
  'EN_ROUTE',
  'ARRIVED',
  'IN_PROGRESS',
  'WORK_REPORTED_COMPLETE',
  'SCOPE_CHANGE_PROPOSED',
  'NO_SHOW',
  'VERIFIED',
  'DISPUTED',
  'REJECTED',
  'CANCELLED',
  'FAILED',
  'UNKNOWN',
] as const);
export const ServiceJobStateSchema = z.enum(SERVICE_JOB_STATES);
export type ServiceJobState = z.infer<typeof ServiceJobStateSchema>;

export const RECOVERY_EVALUATION_STATES = Object.freeze([
  'PENDING',
  'OBSERVING',
  'PASSED',
  'FAILED',
  'EXPIRED',
] as const);
export const RecoveryEvaluationStateSchema = z.enum(RECOVERY_EVALUATION_STATES);
export type RecoveryEvaluationState = z.infer<typeof RecoveryEvaluationStateSchema>;

export const DEVICE_HEALTH_STATES = Object.freeze(['PROVISIONED', 'ONLINE', 'STALE', 'OFFLINE', 'REVOKED'] as const);
export const DeviceHealthStateSchema = z.enum(DEVICE_HEALTH_STATES);
export type DeviceHealthState = z.infer<typeof DeviceHealthStateSchema>;
