// The credential-free commercial-intent broker PORT. M01 owns this contract; M07 codes against it and M09 implements
// it. Nothing here carries or resolves a credential: requests name revision-bound identities, the broker reloads
// authority, policy, revision and budget state itself, and results report separate state axes.
import {
  ActorSchema,
  AdapterCapabilitySchema,
  ApprovalIdSchema,
  AssetRevisionIdSchema,
  AttemptTransportStateSchema,
  ClientOperationIdSchema,
  CommercialIntentIdSchema,
  CommercialIntentSchema,
  CommercialIntentSubjectSchema,
  CorrelationIdSchema,
  EconomicIntentStateSchema,
  EvidenceRevisionIdSchema,
  ExecutionAuthorityIdSchema,
  ExternalAttemptIdSchema,
  ExternalOutcomeStateSchema,
  IdempotencyKeySchema,
  IncidentIdSchema,
  MoneySchema,
  PolicyRevisionIdSchema,
  ProviderAccountRevisionIdSchema,
  ProviderRefSchema,
  ReasonCodeSchema,
  TenantIdSchema,
  UtcInstantSchema,
  VersionedDigestSchema,
  defineDomainEvent,
  type CommercialIntent,
  type CommercialIntentId,
  type KiteSession,
  type TenantId,
} from '@uptimebuyer/contracts';
import { isTransitionAllowed } from '@uptimebuyer/domain';
import { z } from 'zod';
import { SignedExecutionReferenceSchema, type SignedExecutionReference } from './reference.js';

export const SEMANTIC_OPERATIONS = Object.freeze([
  'PURCHASE',
  'SERVICE_BOOKING',
  'PAID_CONTACT',
  'PAID_LOOKUP',
] as const);
export const SemanticOperationSchema = z.enum(SEMANTIC_OPERATIONS);

/** Request to create (idempotently) the one commercial intent for an action digest under an execution authority. */
export const CommercialIntentRequestSchema = z.strictObject({
  tenantId: TenantIdSchema,
  incidentId: IncidentIdSchema,
  assetRevisionId: AssetRevisionIdSchema,
  evidenceRevisionId: EvidenceRevisionIdSchema,
  policyRevisionId: PolicyRevisionIdSchema,
  planHash: VersionedDigestSchema,
  actionDigest: VersionedDigestSchema,
  approvalId: ApprovalIdSchema,
  executionAuthorityId: ExecutionAuthorityIdSchema,
  providerAccountRevisionId: ProviderAccountRevisionIdSchema,
  subject: CommercialIntentSubjectSchema,
  semanticOperation: SemanticOperationSchema,
  /** The caller's expected ceiling; the broker re-checks it against the signed authority, never trusts it. */
  expectedMax: MoneySchema,
  requestedBy: ActorSchema,
  correlationId: CorrelationIdSchema,
  idempotencyKey: IdempotencyKeySchema,
});
export type CommercialIntentRequest = z.output<typeof CommercialIntentRequestSchema>;

/** Where a result came from. Downstream modules must never treat `CONTRACT_FAKE` as real payment evidence. */
export const RESULT_ORIGINS = Object.freeze(['KITE_BROKER', 'CONTRACT_FAKE'] as const);
export const ResultOriginSchema = z.enum(RESULT_ORIGINS);
export type ResultOrigin = z.infer<typeof ResultOriginSchema>;

export const CommercialIntentAttemptViewSchema = z.strictObject({
  externalAttemptId: ExternalAttemptIdSchema,
  clientOperationId: ClientOperationIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  transportState: AttemptTransportStateSchema,
  externalOutcomeState: ExternalOutcomeStateSchema,
  adapterCapability: AdapterCapabilitySchema,
  providerRef: ProviderRefSchema.nullable(),
});
export type CommercialIntentAttemptView = z.output<typeof CommercialIntentAttemptViewSchema>;

/** States announced by `commercial_intent.state_changed.v1` (CREATED is `commercial_intent.created.v1`). */
export const COMMERCIAL_INTENT_CHANGED_STATES = Object.freeze([
  'RESERVED',
  'SUBMITTED',
  'UNKNOWN',
  'CONFIRMED',
  'FAILED',
  'REFUNDED',
  'REVERSED',
] as const);

export const CommercialIntentStateChangedPayloadSchema = z
  .strictObject({
    commercialIntentId: CommercialIntentIdSchema,
    actionDigest: VersionedDigestSchema,
    executionAuthorityId: ExecutionAuthorityIdSchema,
    priorState: EconomicIntentStateSchema,
    state: z.enum(COMMERCIAL_INTENT_CHANGED_STATES),
    attempt: CommercialIntentAttemptViewSchema.nullable(),
    reasonCode: ReasonCodeSchema.nullable(),
    nextReconcileAt: UtcInstantSchema.nullable(),
    resultOrigin: ResultOriginSchema,
  })
  .superRefine((p, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (!isTransitionAllowed('ECONOMIC_INTENT', p.priorState, p.state))
      issue('state', 'Not a legal economic-intent transition.');
    if (
      p.state === 'RESERVED' &&
      (p.attempt?.transportState !== 'SEND_STARTED' || p.attempt.externalOutcomeState !== 'AUTHORIZED')
    )
      issue('attempt', 'Reserve commits together with the SEND_STARTED marker; nothing is REQUESTED yet.');
    if (p.state === 'SUBMITTED' && p.attempt?.externalOutcomeState !== 'ACCEPTED')
      issue('attempt', 'Only provider acknowledgement (ACCEPTED) justifies SUBMITTED.');
    if (p.state === 'CONFIRMED' && p.attempt?.externalOutcomeState !== 'CONFIRMED')
      issue('attempt', 'CONFIRMED requires authoritative confirmation of the exact action.');
    if (p.state === 'UNKNOWN' && p.nextReconcileAt === null && p.attempt?.adapterCapability !== 'UNSUPPORTED')
      issue('nextReconcileAt', 'UNKNOWN must expose its next reconciliation time.');
    if (p.state === 'FAILED' && p.reasonCode === null) issue('reasonCode', 'FAILED must carry its proof reason.');
  });
export type CommercialIntentStateChangedPayload = z.output<typeof CommercialIntentStateChangedPayloadSchema>;

export const CommercialIntentStateChangedEventSchema = defineDomainEvent(
  'commercial_intent.state_changed.v1',
  CommercialIntentStateChangedPayloadSchema,
  'commercialIntentId',
);
export type CommercialIntentStateChangedEvent = z.output<typeof CommercialIntentStateChangedEventSchema>;

export const CreateIntentResultSchema = z.strictObject({
  intent: CommercialIntentSchema,
  executionReference: SignedExecutionReferenceSchema,
  created: z.boolean(),
  resultOrigin: ResultOriginSchema,
});
export type CreateIntentResult = z.output<typeof CreateIntentResultSchema>;

export type IntentRunResult = {
  readonly intent: CommercialIntent;
  /** Events produced by THIS call, in order; empty when nothing changed (idempotent repeat, still UNKNOWN). */
  readonly events: readonly CommercialIntentStateChangedEvent[];
};

export interface CommercialIntentBrokerPort {
  /** Idempotent: the same (tenant, actionDigest, executionAuthorityId) always returns the same intent. */
  createIntent(request: CommercialIntentRequest): Promise<CreateIntentResult>;
  /** Activate (or return) the Kite session of an EXECUTION_AUTHORITY reference. */
  activateSession(reference: SignedExecutionReference): Promise<KiteSession>;
  /** Reserve + SEND_STARTED + send for a COMMERCIAL_INTENT reference; never re-sends a started intent. */
  execute(reference: SignedExecutionReference): Promise<IntentRunResult>;
  /** Authoritative lookup by pre-egress identity; never converts UNKNOWN to failure on timeout alone. */
  reconcile(reference: SignedExecutionReference): Promise<IntentRunResult>;
  getIntent(tenantId: TenantId, commercialIntentId: CommercialIntentId): Promise<CommercialIntent | null>;
}
