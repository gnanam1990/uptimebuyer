// The exact, structured input of one compatibility evaluation (FR-06, INV-03, INV-04). Every value is server-derived
// by the persistence layer from immutable revisions: the bound tuple (tenant, site, incident, candidate, asset /
// evidence / policy revisions, action digest), whether each bound revision is still current, the asset identity,
// the candidate and its offer snapshot, the cited facts with their source attributes, and the authority records bound
// to the candidate. Explanation fields (model confidence, search rank, seller claims) are deliberately NOT part of
// this schema: they cannot enter the input digest or influence the decision (INV-02).
import {
  ActionKindSchema,
  AssetRevisionIdSchema,
  CandidateActionIdSchema,
  CompatibilityDecisionIdSchema,
  EVIDENCE_TRUST_LEVELS,
  EvidenceRevisionIdSchema,
  IncidentIdSchema,
  MoneySchema,
  PolicyRevisionIdSchema,
  ReasonCodeSchema,
  SiteIdSchema,
  TenantIdSchema,
  UserIdSchema,
  UtcInstantSchema,
  VersionedDigestSchema,
} from '@uptimebuyer/contracts';
import { z } from 'zod';
import {
  CanonicalKeySchema,
  CertificationCodeSchema,
  EVIDENCE_ROLES,
  EVIDENCE_SOURCE_KINDS,
  OVERRIDABLE_REASONS,
} from './policy.js';

/**
 * How a fact was obtained. Only deterministic exact extraction, structured registry records and exact cited text
 * can ever be authoritative; semantic similarity, model extraction and seller text never can.
 */
export const SOURCE_BASES = Object.freeze([
  'EXACT_EXTRACTION',
  'STRUCTURED_RECORD',
  'CITED_EXACT_TEXT',
  'SEMANTIC_MATCH',
  'MODEL_EXTRACTION',
  'SELLER_TEXT',
] as const);
export const AUTHORITATIVE_BASES: readonly string[] = Object.freeze([
  'EXACT_EXTRACTION',
  'STRUCTURED_RECORD',
  'CITED_EXACT_TEXT',
]);
export const SEMANTIC_BASES: readonly string[] = Object.freeze(['SEMANTIC_MATCH', 'MODEL_EXTRACTION']);

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim().length > 0, 'Blank text.');
const KeySchema = CanonicalKeySchema;

export const FactSourceSchema = z.strictObject({
  /** Server reference to the evidence (document/span or registry snapshot id); provenance only. */
  ref: text(200),
  role: z.enum(EVIDENCE_ROLES),
  sourceKind: z.enum(EVIDENCE_SOURCE_KINDS),
  trustLevel: z.enum(EVIDENCE_TRUST_LEVELS),
  basis: z.enum(SOURCE_BASES),
  observedAt: UtcInstantSchema,
});
export type FactSource = z.output<typeof FactSourceSchema>;

/** Zero values = missing; more than one distinct value = conflict. */
export const FactSchema = z.strictObject({
  values: z.array(z.strictObject({ value: text(200), sources: z.array(FactSourceSchema).min(1).max(50) })).max(20),
});
export type Fact = z.output<typeof FactSchema>;

export const AUTHORITY_KINDS = Object.freeze(['ENGINEER_EXCEPTION', 'POLICY_APPROVAL'] as const);
export type AuthorityKind = (typeof AUTHORITY_KINDS)[number];
export const EXCEPTION_CLASSES = Object.freeze(['SUBSTITUTE', 'NON_EXACT_MATCH', 'SAFETY_CRITICAL'] as const);
export type ExceptionClass = (typeof EXCEPTION_CLASSES)[number];
export const AUTHORITY_STATUSES = Object.freeze(['ACTIVE', 'INVALIDATED', 'REVOKED'] as const);

export const AuthorityRecordIdSchema = z.string().regex(/^cau_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/);

/** A signed, immutable named-engineer or policy-approver authority record (INV-15), as evidence for evaluation. */
export const AuthorityRecordSchema = z.strictObject({
  authorityRecordId: AuthorityRecordIdSchema,
  kind: z.enum(AUTHORITY_KINDS),
  tenantId: TenantIdSchema,
  siteId: SiteIdSchema,
  incidentId: IncidentIdSchema,
  candidateActionId: CandidateActionIdSchema,
  assetRevisionId: AssetRevisionIdSchema,
  evidenceRevisionId: EvidenceRevisionIdSchema,
  policyRevisionId: PolicyRevisionIdSchema,
  actionDigest: VersionedDigestSchema,
  heldDecisionId: CompatibilityDecisionIdSchema,
  exceptionClasses: z.array(z.enum(EXCEPTION_CLASSES)).max(EXCEPTION_CLASSES.length),
  overriddenReasons: z.array(z.enum(OVERRIDABLE_REASONS)).max(OVERRIDABLE_REASONS.length),
  actorUserId: UserIdSchema,
  actorRole: z.string().regex(/^[a-z][a-z_]{1,39}$/),
  reasonCode: ReasonCodeSchema,
  reasonText: text(2000),
  issuedAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
  /** HMAC-SHA256 under a server-held, per-tenant derived key (see authority.ts); never a recomputable hash. */
  signature: z.strictObject({
    algorithm: z.literal('HMAC-SHA256'),
    keyId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    value: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
  /** Lifecycle from the append-only authority events (not signed: it can only move away from ACTIVE). */
  status: z.enum(AUTHORITY_STATUSES),
});
export type AuthorityRecord = z.output<typeof AuthorityRecordSchema>;
export type UnsignedAuthorityRecord = Omit<AuthorityRecord, 'signature'>;

/**
 * Authority as evaluation evidence: the signed record plus the roles the tenant role registry says the actor holds
 * at the record's site at the evaluation instant (server-resolved; the record's claimed role is never trusted alone).
 */
export const AuthorityEvidenceSchema = z.strictObject({
  record: AuthorityRecordSchema,
  heldRoles: z.array(z.string().regex(/^[a-z][a-z_]{1,39}$/)).max(20),
});
export type AuthorityEvidence = z.output<typeof AuthorityEvidenceSchema>;

export const CompatibilityInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  binding: z.strictObject({
    tenantId: TenantIdSchema,
    siteId: SiteIdSchema,
    incidentId: IncidentIdSchema,
    candidateActionId: CandidateActionIdSchema,
    assetRevisionId: AssetRevisionIdSchema,
    evidenceRevisionId: EvidenceRevisionIdSchema,
    policyRevisionId: PolicyRevisionIdSchema,
    actionDigest: VersionedDigestSchema,
  }),
  /** Whether each bound revision is still the current one when evaluated (server-derived). */
  state: z.strictObject({
    assetRevisionCurrent: z.boolean(),
    evidenceRevisionCurrent: z.boolean(),
    evidenceAssetRevisionId: AssetRevisionIdSchema,
    policyRevisionEffective: z.boolean(),
  }),
  asset: z.strictObject({
    manufacturer: text(200).nullable(),
    model: text(200).nullable(),
    serial: text(200).nullable(),
    bomRevision: text(100).nullable(),
    /** Registry safety class; an unknown value is treated as safety-critical. */
    safetyClass: z.string().min(1).max(40),
  }),
  candidate: z.strictObject({
    actionKind: ActionKindSchema,
    component: KeySchema,
    manufacturer: text(200).nullable(),
    partNumber: text(80).nullable(),
    quantity: z.int().min(1).max(1_000_000),
    vendorId: text(80).nullable(),
    amount: MoneySchema,
    offerObservedAt: UtcInstantSchema.nullable(),
  }),
  facts: z.strictObject({
    requiredPart: FactSchema,
    requiredConstraints: z.array(z.strictObject({ key: KeySchema, fact: FactSchema })).max(50),
    candidateConstraints: z.array(z.strictObject({ key: KeySchema, fact: FactSchema })).max(50),
    certifications: z.array(z.strictObject({ code: CertificationCodeSchema, fact: FactSchema })).max(50),
    warranty: FactSchema,
    vendor: FactSchema,
  }),
  authorities: z.array(AuthorityEvidenceSchema).max(32),
  evaluatedAt: UtcInstantSchema,
});
export type CompatibilityInput = z.output<typeof CompatibilityInputSchema>;

export const EXPLANATION_ORIGINS = Object.freeze(['OPERATOR', 'MODEL_PROPOSAL', 'PROVIDER_OFFER', 'PLANNER'] as const);

/** Display-only context. It never authorizes anything and never enters the input digest. */
export const ExplanationSchema = z.strictObject({
  origin: z.enum(EXPLANATION_ORIGINS),
  proposalId: z
    .string()
    .regex(/^rpr_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/)
    .nullable()
    .optional(),
  modelConfidencePpm: z.int().min(0).max(1_000_000).nullable().optional(),
  searchRank: z.int().min(1).max(10_000).nullable().optional(),
  semanticScorePpm: z.int().min(0).max(1_000_000).nullable().optional(),
  sellerClaim: z.string().max(500).nullable().optional(),
});
export type Explanation = z.output<typeof ExplanationSchema>;
