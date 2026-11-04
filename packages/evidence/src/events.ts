// Typed M05 event payloads (API-EVENT-SPEC §6) built with the shared envelope factory. `plan.invalidated.v1` is
// emitted on the incident's plan scope (aggregate type `plan`, aggregate id = incident id, contiguous versions) each
// time a new evidence revision supersedes the previous one; M06/M08/M09 consume it to invalidate decisions, plans
// and unexecuted approvals bound to the superseded revision. M06 emits the same event on the same scope with reason
// POLICY_REVISION_CHANGED when a new policy revision becomes effective.
import {
  AssetRevisionIdSchema,
  EvidenceRevisionIdSchema,
  IncidentIdSchema,
  PolicyRevisionIdSchema,
  ReasonCodeSchema,
  Sha256DigestSchema,
  defineDomainEvent,
} from '@uptimebuyer/contracts';
import { z } from 'zod';
import { ProposalIdSchema, ReasoningRunIdSchema } from './ids.js';

export const EvidenceRevisionCommittedPayloadSchema = z.strictObject({
  evidenceRevisionId: EvidenceRevisionIdSchema,
  incidentId: IncidentIdSchema,
  revision: z.int().min(1),
  manifestSha256: Sha256DigestSchema,
  assetRevisionId: AssetRevisionIdSchema,
  previousRevisionId: EvidenceRevisionIdSchema.nullable(),
});
export const EvidenceRevisionCommittedEventSchema = defineDomainEvent(
  'evidence.revision_committed.v1',
  EvidenceRevisionCommittedPayloadSchema,
  'evidenceRevisionId',
);

export const PLAN_INVALIDATION_REASONS = Object.freeze([
  'EVIDENCE_REVISION_CHANGED',
  'ASSET_REVISION_CHANGED',
  'POLICY_REVISION_CHANGED',
] as const);

/** Emitted by M05 when a new evidence revision supersedes the previous one. */
export const PlanInvalidatedByEvidencePayloadSchema = z.strictObject({
  incidentId: IncidentIdSchema,
  reasonCode: z.enum(['EVIDENCE_REVISION_CHANGED', 'ASSET_REVISION_CHANGED']),
  commitReasonCode: ReasonCodeSchema,
  supersededEvidenceRevisionId: EvidenceRevisionIdSchema,
  evidenceRevisionId: EvidenceRevisionIdSchema,
  supersededAssetRevisionId: AssetRevisionIdSchema,
  assetRevisionId: AssetRevisionIdSchema,
  supersededProposalIds: z.array(ProposalIdSchema).max(10_000),
});

/**
 * Emitted by M06 when a new AUTHORITY policy revision becomes effective: every unexecuted compatibility decision,
 * authority record and approval of the incident bound to the superseded revision was invalidated.
 */
export const PlanInvalidatedByPolicyPayloadSchema = z.strictObject({
  incidentId: IncidentIdSchema,
  reasonCode: z.literal('POLICY_REVISION_CHANGED'),
  supersededPolicyRevisionId: PolicyRevisionIdSchema,
  policyRevisionId: PolicyRevisionIdSchema,
  supersededDecisionIds: z.array(z.string().regex(/^cmp_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/)).max(10_000),
  invalidatedAuthorityIds: z.array(z.string().regex(/^cau_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/)).max(10_000),
  invalidatedApprovalIds: z.array(z.string().regex(/^apr_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/)).max(10_000),
});

export const PlanInvalidatedPayloadSchema = z.discriminatedUnion('reasonCode', [
  PlanInvalidatedByEvidencePayloadSchema,
  PlanInvalidatedByPolicyPayloadSchema,
]);
export const PlanInvalidatedEventSchema = defineDomainEvent('plan.invalidated.v1', PlanInvalidatedPayloadSchema, 'incidentId');

export const ReasoningCompletedPayloadSchema = z.strictObject({
  reasoningRunId: ReasoningRunIdSchema,
  incidentId: IncidentIdSchema,
  evidenceRevisionId: EvidenceRevisionIdSchema,
  proposalId: ProposalIdSchema,
  proposalDigest: z.string().regex(/^reasoning-proposal\.v1:sha256:[0-9a-f]{64}$/),
  disposition: z.enum(['PROPOSAL_ONLY', 'NEEDS_HUMAN_REVIEW']),
  resultOrigin: z.enum(['SERV_REASONING', 'CONTRACT_FAKE']),
  /** Always false: a reasoning result is a proposal, never an approval (INV-02). */
  approved: z.literal(false),
});
export const ReasoningCompletedEventSchema = defineDomainEvent(
  'reasoning.completed.v1',
  ReasoningCompletedPayloadSchema,
  'reasoningRunId',
);

export type EvidenceRevisionCommittedEvent = z.output<typeof EvidenceRevisionCommittedEventSchema>;
export type PlanInvalidatedEvent = z.output<typeof PlanInvalidatedEventSchema>;
export type ReasoningCompletedEvent = z.output<typeof ReasoningCompletedEventSchema>;
