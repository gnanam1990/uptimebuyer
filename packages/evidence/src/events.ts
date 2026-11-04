// Typed M05 event payloads (API-EVENT-SPEC §6) built with the shared envelope factory. `plan.invalidated.v1` is
// emitted on the incident's plan scope (aggregate type `plan`, aggregate id = incident id, contiguous versions) each
// time a new evidence revision supersedes the previous one; M06/M08/M09 consume it to invalidate decisions, plans
// and unexecuted approvals bound to the superseded revision.
import {
  AssetRevisionIdSchema,
  EvidenceRevisionIdSchema,
  IncidentIdSchema,
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

export const PLAN_INVALIDATION_REASONS = Object.freeze(['EVIDENCE_REVISION_CHANGED', 'ASSET_REVISION_CHANGED'] as const);

export const PlanInvalidatedPayloadSchema = z.strictObject({
  incidentId: IncidentIdSchema,
  reasonCode: z.enum(PLAN_INVALIDATION_REASONS),
  commitReasonCode: ReasonCodeSchema,
  supersededEvidenceRevisionId: EvidenceRevisionIdSchema,
  evidenceRevisionId: EvidenceRevisionIdSchema,
  supersededAssetRevisionId: AssetRevisionIdSchema,
  assetRevisionId: AssetRevisionIdSchema,
  supersededProposalIds: z.array(ProposalIdSchema).max(10_000),
});
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
