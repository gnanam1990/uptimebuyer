// Typed incident event payloads (API-EVENT-SPEC §6). incident.state_changed.v1 is the M01 contract schema; the rest
// are defined here through the shared factory. Every event is appended to the outbox in the same transaction as the
// incident change, keyed by the aggregate version, so consumers (M07 notifications, M05 evidence, M08, M11) see
// each change once logically and can verify monotonic versions.
import {
  AssetIdSchema,
  AssetRevisionIdSchema,
  IncidentIdSchema,
  IncidentStateSchema,
  PolicyRevisionIdSchema,
  ReasonCodeSchema,
  SiteIdSchema,
  UserIdSchema,
  UtcInstantSchema,
  defineDomainEvent,
} from '@uptimebuyer/contracts';
import { z } from 'zod';

const opaque = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9-]{3,63}$`));
export const IncidentRuleRevisionIdSchema = opaque('irl');
export const ProcedureRevisionIdSchema = opaque('opr');
export const IncidentAssignmentIdSchema = opaque('ias');
export const ManualReportIdSchema = opaque('imr');

export const URGENCIES = Object.freeze(['CRITICAL', 'HIGH', 'NORMAL'] as const);
export const UrgencySchema = z.enum(URGENCIES);
export const TRIGGER_KINDS = Object.freeze(['TELEMETRY_RULE', 'MANUAL_REPORT'] as const);

/** Notification trigger carried on the event; delivery, recipients and channels are M07's (FR-20). */
export const NotificationTriggerSchema = z.strictObject({
  required: z.boolean(),
  reasonCode: ReasonCodeSchema,
});

export const IncidentOpenedPayloadSchema = z.strictObject({
  incidentId: IncidentIdSchema,
  siteId: SiteIdSchema,
  assetId: AssetIdSchema,
  assetRevisionId: AssetRevisionIdSchema,
  ruleRevisionId: IncidentRuleRevisionIdSchema,
  procedureRevisionId: ProcedureRevisionIdSchema,
  policyRevisionId: PolicyRevisionIdSchema.nullable(),
  triggerKind: z.enum(TRIGGER_KINDS),
  triggerInputOrigin: z.enum(['PHYSICAL_SENSOR', 'SIMULATED_INPUT', 'OPERATOR_REPORT']),
  urgency: UrgencySchema,
  faultFamily: ReasonCodeSchema,
  faultWindowKey: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  dedupeKey: z.string().regex(/^incident-dedupe\.v1:sha256:[0-9a-f]{64}$/),
  triggerEventAt: UtcInstantSchema,
  openedAt: UtcInstantSchema,
  openLatencyMs: z.int().min(0),
  originalResponseDeadlineAt: UtcInstantSchema,
  deadlineBasisDigest: z.string().regex(/^incident-deadline-basis\.v1:sha256:[0-9a-f]{64}$/),
  initialAssignmentId: IncidentAssignmentIdSchema,
  notification: NotificationTriggerSchema,
});
export const IncidentOpenedEventSchema = defineDomainEvent(
  'incident.opened.v1',
  IncidentOpenedPayloadSchema,
  'incidentId',
);

export const IncidentAssignmentChangedPayloadSchema = z.strictObject({
  incidentId: IncidentIdSchema,
  assignmentId: IncidentAssignmentIdSchema,
  assignmentKind: z.enum(['INITIAL', 'ASSIGN', 'HANDOFF']),
  assigneeUserId: UserIdSchema,
  supersededAssignmentId: IncidentAssignmentIdSchema.nullable(),
  reasonCode: ReasonCodeSchema,
  nextActionDueAt: UtcInstantSchema.nullable(),
});
export const IncidentAssignmentChangedEventSchema = defineDomainEvent(
  'incident.assignment_changed.v1',
  IncidentAssignmentChangedPayloadSchema,
  'incidentId',
);

export const IncidentAssignmentAcceptedPayloadSchema = z.strictObject({
  incidentId: IncidentIdSchema,
  assignmentId: IncidentAssignmentIdSchema,
  assigneeUserId: UserIdSchema,
  acceptedAt: UtcInstantSchema,
});
export const IncidentAssignmentAcceptedEventSchema = defineDomainEvent(
  'incident.assignment_accepted.v1',
  IncidentAssignmentAcceptedPayloadSchema,
  'incidentId',
);

export const IncidentDeadlineChangedPayloadSchema = z.strictObject({
  incidentId: IncidentIdSchema,
  sequence: z.int().min(1),
  eventType: z.enum(['SET', 'PAUSE', 'RESUME', 'SHORTEN', 'EXTEND', 'EXPIRE']),
  priorDeadlineAt: UtcInstantSchema.nullable(),
  newDeadlineAt: UtcInstantSchema,
  originalDeadlineAt: UtcInstantSchema,
  newStatus: z.enum(['RUNNING', 'PAUSED', 'EXPIRED']),
  procedureRevisionId: ProcedureRevisionIdSchema,
  reasonCode: ReasonCodeSchema,
});
export const IncidentDeadlineChangedEventSchema = defineDomainEvent(
  'incident.deadline_changed.v1',
  IncidentDeadlineChangedPayloadSchema,
  'incidentId',
);

export const IncidentReopenedPayloadSchema = z.strictObject({
  incidentId: IncidentIdSchema,
  from: IncidentStateSchema,
  reasonCode: ReasonCodeSchema,
  reopenCount: z.int().min(1),
  trigger: z.enum(['TELEMETRY_RULE', 'MANUAL_REPORT', 'OPERATOR_COMMAND', 'RECOVERY_ENGINE']),
  notification: NotificationTriggerSchema,
});
export const IncidentReopenedEventSchema = defineDomainEvent(
  'incident.reopened.v1',
  IncidentReopenedPayloadSchema,
  'incidentId',
);

export type IncidentOpenedEvent = z.output<typeof IncidentOpenedEventSchema>;
export type IncidentAssignmentChangedEvent = z.output<typeof IncidentAssignmentChangedEventSchema>;
export type IncidentAssignmentAcceptedEvent = z.output<typeof IncidentAssignmentAcceptedEventSchema>;
export type IncidentDeadlineChangedEvent = z.output<typeof IncidentDeadlineChangedEventSchema>;
export type IncidentReopenedEvent = z.output<typeof IncidentReopenedEventSchema>;
