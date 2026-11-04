// Revision-bound domain records shared across modules (names follow DATA-MODEL.md; persistence is M02's).
// Each record keeps its separate state axes in separate fields.
import { z } from 'zod';
import {
  ProviderRefSchema,
  PurposeCodeSchema,
  ReasonCodeSchema,
  Sha256DigestSchema,
  VersionedDigestSchema,
} from './codes.js';
import {
  ApprovalIdSchema,
  AssetIdSchema,
  AssetRevisionIdSchema,
  CandidateActionIdSchema,
  ClientOperationIdSchema,
  CommercialIntentIdSchema,
  CompatibilityDecisionIdSchema,
  EvidenceRevisionIdSchema,
  ExecutionAuthorityIdSchema,
  ExternalAttemptIdSchema,
  IdempotencyKeySchema,
  IncidentIdSchema,
  InterventionMilestoneIdSchema,
  KiteSessionIdSchema,
  MerchantIdSchema,
  OpaqueIdSchema,
  PlanIdSchema,
  PolicyRevisionIdSchema,
  ProviderAccountRevisionIdSchema,
  ProviderContactRequestIdSchema,
  PurchaseOrderIdSchema,
  RecoveryEvaluationIdSchema,
  ServiceJobIdSchema,
  SiteIdSchema,
  TenantIdSchema,
} from './ids.js';
import { MoneySchema } from './money.js';
import {
  AdapterCapabilitySchema,
  AttemptTransportStateSchema,
  CompatibilityDecisionValueSchema,
  CompatibilityLifecycleSchema,
  EconomicIntentStateSchema,
  ExecutionAuthorityStateSchema,
  ExternalOutcomeStateSchema,
  INCIDENT_PAUSABLE_STATES,
  IncidentStateSchema,
  KiteSessionStateSchema,
  PurchaseOrderStateSchema,
  RecoveryEvaluationStateSchema,
  ServiceJobStateSchema,
} from './states.js';
import { DurationMsSchema, UtcInstantSchema } from './time.js';

const ms = (s: string) => Date.parse(s);
const trimmedText = z
  .string()
  .min(1)
  .max(128)
  .regex(/^\S(?:.*\S)?$/);

export const ACTION_KINDS = Object.freeze([
  'PART_PURCHASE',
  'SERVICE_JOB',
  'DIAGNOSTIC_SERVICE',
  'PAID_CONTACT',
  'CONTAINMENT_PURCHASE',
] as const);
export const ActionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof ActionKindSchema>;

/** The proposed action as bound into the action digest. */
export const ActionDescriptorSchema = z.strictObject({
  kind: ActionKindSchema,
  subjectId: OpaqueIdSchema,
  quantity: z.int().min(1).max(1_000_000),
  partNumber: trimmedText.nullable(),
  manufacturer: trimmedText.nullable(),
});
export type ActionDescriptor = z.output<typeof ActionDescriptorSchema>;

/**
 * Every input the canonical action digest binds (INV-03, CORE-CONTRACT money and measurement rules). Strict:
 * an unbound field cannot be smuggled into or omitted from the digest.
 */
export const ActionDigestInputSchema = z.strictObject({
  tenantId: TenantIdSchema,
  incidentId: IncidentIdSchema,
  assetRevisionId: AssetRevisionIdSchema,
  evidenceRevisionId: EvidenceRevisionIdSchema,
  policyRevisionId: PolicyRevisionIdSchema,
  action: ActionDescriptorSchema,
  providerAccountRevisionId: ProviderAccountRevisionIdSchema,
  merchantId: MerchantIdSchema,
  amount: MoneySchema,
  purpose: PurposeCodeSchema,
});
export type ActionDigestInput = z.output<typeof ActionDigestInputSchema>;

export const IncidentSchema = z
  .strictObject({
    incidentId: IncidentIdSchema,
    tenantId: TenantIdSchema,
    siteId: SiteIdSchema,
    assetId: AssetIdSchema,
    assetRevisionId: AssetRevisionIdSchema,
    state: IncidentStateSchema,
    /** The resumable prior state, recorded only while PAUSED. */
    pausedFromState: IncidentStateSchema.nullable(),
    version: z.int().min(1),
    openedAt: UtcInstantSchema,
    updatedAt: UtcInstantSchema,
  })
  .superRefine((i, ctx) => {
    const paused = i.state === 'PAUSED';
    if (paused !== (i.pausedFromState !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['pausedFromState'],
        message: 'Recorded prior state is required exactly while PAUSED.',
      });
    if (i.pausedFromState !== null && !(INCIDENT_PAUSABLE_STATES as readonly string[]).includes(i.pausedFromState))
      ctx.addIssue({ code: 'custom', path: ['pausedFromState'], message: 'Prior state is not resumable.' });
  });
export type Incident = z.output<typeof IncidentSchema>;

export const CompatibilityDecisionSchema = z
  .strictObject({
    compatibilityDecisionId: CompatibilityDecisionIdSchema,
    tenantId: TenantIdSchema,
    candidateActionId: CandidateActionIdSchema,
    assetRevisionId: AssetRevisionIdSchema,
    evidenceRevisionId: EvidenceRevisionIdSchema,
    policyRevisionId: PolicyRevisionIdSchema,
    actionDigest: VersionedDigestSchema,
    decision: CompatibilityDecisionValueSchema,
    lifecycle: CompatibilityLifecycleSchema,
    reasonCodes: z.array(ReasonCodeSchema).max(64),
    ruleVersion: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
    inputDigest: VersionedDigestSchema,
    decidedAt: UtcInstantSchema,
  })
  .superRefine((d, ctx) => {
    if (d.decision !== 'ALLOW' && d.reasonCodes.length === 0)
      ctx.addIssue({ code: 'custom', path: ['reasonCodes'], message: 'HOLD and REJECT must name their reasons.' });
    if (new Set(d.reasonCodes).size !== d.reasonCodes.length)
      ctx.addIssue({ code: 'custom', path: ['reasonCodes'], message: 'Duplicate reason code.' });
  });
export type CompatibilityDecision = z.output<typeof CompatibilityDecisionSchema>;

/** Immutable signed, revision-bound commercial scope (one per approval). Status is the local lifecycle only. */
export const ExecutionAuthoritySchema = z
  .strictObject({
    executionAuthorityId: ExecutionAuthorityIdSchema,
    tenantId: TenantIdSchema,
    approvalId: ApprovalIdSchema,
    incidentId: IncidentIdSchema,
    assetRevisionId: AssetRevisionIdSchema,
    evidenceRevisionId: EvidenceRevisionIdSchema,
    policyRevisionId: PolicyRevisionIdSchema,
    planHash: VersionedDigestSchema,
    actionDigest: VersionedDigestSchema,
    providerAccountRevisionId: ProviderAccountRevisionIdSchema,
    merchantId: MerchantIdSchema,
    purpose: PurposeCodeSchema,
    allowedActionKinds: z.array(ActionKindSchema).min(1),
    perActionLimit: MoneySchema,
    baseLimit: MoneySchema,
    issuedAt: UtcInstantSchema,
    expiresAt: UtcInstantSchema,
    status: ExecutionAuthorityStateSchema,
    signatureDigest: Sha256DigestSchema,
    version: z.int().min(1),
  })
  .superRefine((a, ctx) => {
    if (a.perActionLimit.currency !== a.baseLimit.currency)
      ctx.addIssue({ code: 'custom', path: ['perActionLimit'], message: 'Limits must share one currency.' });
    else if (a.perActionLimit.amountMinor > a.baseLimit.amountMinor)
      ctx.addIssue({ code: 'custom', path: ['perActionLimit'], message: 'Per-action limit exceeds the base limit.' });
    if (ms(a.expiresAt) <= ms(a.issuedAt))
      ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Authority must expire after issue.' });
    if (new Set(a.allowedActionKinds).size !== a.allowedActionKinds.length)
      ctx.addIssue({ code: 'custom', path: ['allowedActionKinds'], message: 'Duplicate action kind.' });
  });
export type ExecutionAuthority = z.output<typeof ExecutionAuthoritySchema>;

type AxisRecord = {
  transportState: string;
  externalOutcomeState: string;
  adapterCapability: string;
  nextReconcileAt: string | null;
};
/** Honesty rules shared by every external operation record (INV-08, INV-12). */
function checkAxes(r: AxisRecord, ctx: z.RefinementCtx) {
  if (r.transportState === 'PREPARED' && !['PROPOSED', 'AUTHORIZED'].includes(r.externalOutcomeState))
    ctx.addIssue({
      code: 'custom',
      path: ['externalOutcomeState'],
      message: 'Nothing was sent; the outcome cannot be past AUTHORIZED.',
    });
  if (r.externalOutcomeState === 'UNKNOWN' && r.nextReconcileAt === null && r.adapterCapability !== 'UNSUPPORTED')
    ctx.addIssue({
      code: 'custom',
      path: ['nextReconcileAt'],
      message: 'UNKNOWN must expose its next reconciliation time.',
    });
}

/** External Kite-session activation: its own pre-egress operation identity and separate axes. */
export const KiteSessionSchema = z
  .strictObject({
    kiteSessionId: KiteSessionIdSchema,
    tenantId: TenantIdSchema,
    executionAuthorityId: ExecutionAuthorityIdSchema,
    providerAccountRevisionId: ProviderAccountRevisionIdSchema,
    clientOperationId: ClientOperationIdSchema,
    idempotencyKey: IdempotencyKeySchema,
    requestDigest: Sha256DigestSchema,
    transportState: AttemptTransportStateSchema,
    externalOutcomeState: KiteSessionStateSchema,
    adapterCapability: AdapterCapabilitySchema,
    /** Optional evidence; never the authority identity. */
    providerSessionRef: ProviderRefSchema.nullable(),
    nextReconcileAt: UtcInstantSchema.nullable(),
  })
  .superRefine(checkAxes);
export type KiteSession = z.output<typeof KiteSessionSchema>;

export const CommercialIntentSubjectSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('PLAN_ACTION'), id: CandidateActionIdSchema }),
  z.strictObject({ type: z.literal('PROVIDER_CONTACT_REQUEST'), id: ProviderContactRequestIdSchema }),
]);
export type CommercialIntentSubject = z.output<typeof CommercialIntentSubjectSchema>;

export const CommercialIntentSchema = z.strictObject({
  commercialIntentId: CommercialIntentIdSchema,
  tenantId: TenantIdSchema,
  incidentId: IncidentIdSchema,
  assetRevisionId: AssetRevisionIdSchema,
  subject: CommercialIntentSubjectSchema,
  approvalId: ApprovalIdSchema,
  executionAuthorityId: ExecutionAuthorityIdSchema,
  providerAccountRevisionId: ProviderAccountRevisionIdSchema,
  actionDigest: VersionedDigestSchema,
  maxAmount: MoneySchema,
  state: EconomicIntentStateSchema,
  supersedesIntentId: CommercialIntentIdSchema.nullable(),
  version: z.int().min(1),
  createdAt: UtcInstantSchema,
});
export type CommercialIntent = z.output<typeof CommercialIntentSchema>;

export const ExternalAttemptSchema = z
  .strictObject({
    externalAttemptId: ExternalAttemptIdSchema,
    tenantId: TenantIdSchema,
    commercialIntentId: CommercialIntentIdSchema,
    providerAccountRevisionId: ProviderAccountRevisionIdSchema,
    clientOperationId: ClientOperationIdSchema,
    idempotencyKey: IdempotencyKeySchema,
    requestDigest: Sha256DigestSchema,
    transportState: AttemptTransportStateSchema,
    externalOutcomeState: ExternalOutcomeStateSchema,
    adapterCapability: AdapterCapabilitySchema,
    providerRef: ProviderRefSchema.nullable(),
    /** Original provider status word, retained beside the normalized outcome (INV-12). */
    rawProviderStatus: z.string().min(1).max(256).nullable(),
    nextReconcileAt: UtcInstantSchema.nullable(),
  })
  .superRefine(checkAxes);
export type ExternalAttempt = z.output<typeof ExternalAttemptSchema>;

export const PurchaseOrderSchema = z.strictObject({
  purchaseOrderId: PurchaseOrderIdSchema,
  tenantId: TenantIdSchema,
  commercialIntentId: CommercialIntentIdSchema,
  providerAccountRevisionId: ProviderAccountRevisionIdSchema,
  providerRef: ProviderRefSchema.nullable(),
  state: PurchaseOrderStateSchema,
  quantity: z.int().min(1),
  version: z.int().min(1),
});
export type PurchaseOrder = z.output<typeof PurchaseOrderSchema>;

export const ServiceJobSchema = z.strictObject({
  serviceJobId: ServiceJobIdSchema,
  tenantId: TenantIdSchema,
  commercialIntentId: CommercialIntentIdSchema,
  providerAccountRevisionId: ProviderAccountRevisionIdSchema,
  providerRef: ProviderRefSchema.nullable(),
  state: ServiceJobStateSchema,
  version: z.int().min(1),
});
export type ServiceJob = z.output<typeof ServiceJobSchema>;

export const RecoveryEvaluationSchema = z
  .strictObject({
    recoveryEvaluationId: RecoveryEvaluationIdSchema,
    tenantId: TenantIdSchema,
    incidentId: IncidentIdSchema,
    assetRevisionId: AssetRevisionIdSchema,
    planId: PlanIdSchema,
    actionDigest: VersionedDigestSchema,
    evidenceRevisionId: EvidenceRevisionIdSchema,
    policyRevisionId: PolicyRevisionIdSchema,
    interventionMilestoneId: InterventionMilestoneIdSchema,
    observationBoundaryAt: UtcInstantSchema,
    state: RecoveryEvaluationStateSchema,
    window: z
      .strictObject({ firstSampleAt: UtcInstantSchema, lastSampleAt: UtcInstantSchema, sampleCount: z.int().min(1) })
      .nullable(),
    stableDurationMs: DurationMsSchema,
    decidedAt: UtcInstantSchema.nullable(),
  })
  .superRefine((r, ctx) => {
    if (r.window) {
      if (ms(r.window.firstSampleAt) <= ms(r.observationBoundaryAt))
        ctx.addIssue({
          code: 'custom',
          path: ['window', 'firstSampleAt'],
          message: 'Qualifying samples must be strictly after the observation boundary.',
        });
      if (ms(r.window.lastSampleAt) < ms(r.window.firstSampleAt))
        ctx.addIssue({ code: 'custom', path: ['window', 'lastSampleAt'], message: 'Window ends before it starts.' });
      else if (r.stableDurationMs > ms(r.window.lastSampleAt) - ms(r.window.firstSampleAt))
        ctx.addIssue({
          code: 'custom',
          path: ['stableDurationMs'],
          message: 'Stable duration exceeds the sample window.',
        });
    }
    if (r.state === 'PASSED' && r.window === null)
      ctx.addIssue({ code: 'custom', path: ['window'], message: 'PASSED requires the qualifying sample window.' });
    if (['PASSED', 'FAILED', 'EXPIRED'].includes(r.state) !== (r.decidedAt !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['decidedAt'],
        message: 'decidedAt is set exactly for terminal evaluations.',
      });
  });
export type RecoveryEvaluation = z.output<typeof RecoveryEvaluationSchema>;
