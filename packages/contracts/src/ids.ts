// Branded, prefixed opaque identifiers. The prefix makes cross-kind confusion a runtime validation failure,
// not just a type error. Bodies accept UUIDs and other opaque monotonic identifiers chosen by persistence.
import { z } from 'zod';

export const ID_PREFIXES = Object.freeze({
  tenant: 'ten',
  site: 'sit',
  asset: 'ast',
  assetRevision: 'arv',
  incident: 'inc',
  evidenceRevision: 'evr',
  evidence: 'evd',
  blob: 'blb',
  citation: 'cit',
  policyRevision: 'pol',
  plan: 'pln',
  candidateAction: 'cand',
  approval: 'apr',
  executionAuthority: 'xau',
  kiteSession: 'kss',
  commercialIntent: 'cin',
  externalAttempt: 'att',
  providerAccount: 'pac',
  providerAccountRevision: 'par',
  providerContactRequest: 'pcr',
  merchant: 'mer',
  purchaseOrder: 'pur',
  serviceJob: 'sjb',
  recoveryEvaluation: 'rev',
  interventionMilestone: 'iml',
  compatibilityDecision: 'cmp',
  event: 'evt',
  command: 'cmd',
  correlation: 'corr',
  clientOperation: 'op',
  user: 'usr',
  device: 'dev',
  serviceIdentity: 'svc',
} as const);
export type IdKind = keyof typeof ID_PREFIXES;

const BODY = '[A-Za-z0-9][A-Za-z0-9-]{3,63}';

function idSchema<K extends IdKind>(kind: K) {
  return z
    .string()
    .regex(new RegExp(`^${ID_PREFIXES[kind]}_${BODY}$`))
    .brand<`${K}Id`>();
}

export const TenantIdSchema = idSchema('tenant');
export const SiteIdSchema = idSchema('site');
export const AssetIdSchema = idSchema('asset');
export const AssetRevisionIdSchema = idSchema('assetRevision');
export const IncidentIdSchema = idSchema('incident');
export const EvidenceRevisionIdSchema = idSchema('evidenceRevision');
export const EvidenceIdSchema = idSchema('evidence');
export const BlobIdSchema = idSchema('blob');
export const CitationIdSchema = idSchema('citation');
export const PolicyRevisionIdSchema = idSchema('policyRevision');
export const PlanIdSchema = idSchema('plan');
export const CandidateActionIdSchema = idSchema('candidateAction');
export const ApprovalIdSchema = idSchema('approval');
export const ExecutionAuthorityIdSchema = idSchema('executionAuthority');
export const KiteSessionIdSchema = idSchema('kiteSession');
export const CommercialIntentIdSchema = idSchema('commercialIntent');
export const ExternalAttemptIdSchema = idSchema('externalAttempt');
export const ProviderAccountIdSchema = idSchema('providerAccount');
export const ProviderAccountRevisionIdSchema = idSchema('providerAccountRevision');
export const ProviderContactRequestIdSchema = idSchema('providerContactRequest');
export const MerchantIdSchema = idSchema('merchant');
export const PurchaseOrderIdSchema = idSchema('purchaseOrder');
export const ServiceJobIdSchema = idSchema('serviceJob');
export const RecoveryEvaluationIdSchema = idSchema('recoveryEvaluation');
export const InterventionMilestoneIdSchema = idSchema('interventionMilestone');
export const CompatibilityDecisionIdSchema = idSchema('compatibilityDecision');
export const EventIdSchema = idSchema('event');
export const CommandIdSchema = idSchema('command');
export const CorrelationIdSchema = idSchema('correlation');
export const ClientOperationIdSchema = idSchema('clientOperation');
export const UserIdSchema = idSchema('user');
export const DeviceIdSchema = idSchema('device');
export const ServiceIdentityIdSchema = idSchema('serviceIdentity');

export type TenantId = z.infer<typeof TenantIdSchema>;
export type SiteId = z.infer<typeof SiteIdSchema>;
export type AssetId = z.infer<typeof AssetIdSchema>;
export type AssetRevisionId = z.infer<typeof AssetRevisionIdSchema>;
export type IncidentId = z.infer<typeof IncidentIdSchema>;
export type EvidenceRevisionId = z.infer<typeof EvidenceRevisionIdSchema>;
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;
export type BlobId = z.infer<typeof BlobIdSchema>;
export type CitationId = z.infer<typeof CitationIdSchema>;
export type PolicyRevisionId = z.infer<typeof PolicyRevisionIdSchema>;
export type PlanId = z.infer<typeof PlanIdSchema>;
export type CandidateActionId = z.infer<typeof CandidateActionIdSchema>;
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
export type ExecutionAuthorityId = z.infer<typeof ExecutionAuthorityIdSchema>;
export type KiteSessionId = z.infer<typeof KiteSessionIdSchema>;
export type CommercialIntentId = z.infer<typeof CommercialIntentIdSchema>;
export type ExternalAttemptId = z.infer<typeof ExternalAttemptIdSchema>;
export type ProviderAccountId = z.infer<typeof ProviderAccountIdSchema>;
export type ProviderAccountRevisionId = z.infer<typeof ProviderAccountRevisionIdSchema>;
export type ProviderContactRequestId = z.infer<typeof ProviderContactRequestIdSchema>;
export type MerchantId = z.infer<typeof MerchantIdSchema>;
export type PurchaseOrderId = z.infer<typeof PurchaseOrderIdSchema>;
export type ServiceJobId = z.infer<typeof ServiceJobIdSchema>;
export type RecoveryEvaluationId = z.infer<typeof RecoveryEvaluationIdSchema>;
export type InterventionMilestoneId = z.infer<typeof InterventionMilestoneIdSchema>;
export type CompatibilityDecisionId = z.infer<typeof CompatibilityDecisionIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type CommandId = z.infer<typeof CommandIdSchema>;
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;
export type ClientOperationId = z.infer<typeof ClientOperationIdSchema>;
export type UserId = z.infer<typeof UserIdSchema>;
export type DeviceId = z.infer<typeof DeviceIdSchema>;
export type ServiceIdentityId = z.infer<typeof ServiceIdentityIdSchema>;

/** What caused a command or event: a command or a prior event. */
export const CausationIdSchema = z.union([CommandIdSchema, EventIdSchema]);
export type CausationId = z.infer<typeof CausationIdSchema>;

/** Any well-formed prefixed identifier, for polymorphic references (event aggregate IDs, evidence subjects). */
export const OpaqueIdSchema = z.string().regex(new RegExp(`^[a-z]{2,5}_${BODY}$`));
export type OpaqueId = z.infer<typeof OpaqueIdSchema>;

/** Client-supplied idempotency key (API §8). */
export const IdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/)
  .brand<'IdempotencyKey'>();
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

type IdOf<K extends IdKind> = z.infer<ReturnType<typeof idSchema<K>>>;

/** Generate a fresh identifier of the given kind (UUID body from the platform CSPRNG). */
export function newId<K extends IdKind>(kind: K): IdOf<K> {
  return `${ID_PREFIXES[kind]}_${globalThis.crypto.randomUUID()}` as IdOf<K>;
}
