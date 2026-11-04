// compatibility.evaluated.v1 (API-EVENT-SPEC §6): a deterministic decision row was persisted. It reports a
// compatibility outcome, never an approval to spend or execute (`approved` is always false).
import {
  AssetRevisionIdSchema,
  CandidateActionIdSchema,
  CompatibilityDecisionIdSchema,
  CompatibilityDecisionValueSchema,
  EvidenceRevisionIdSchema,
  IncidentIdSchema,
  PolicyRevisionIdSchema,
  ReasonCodeSchema,
  VersionedDigestSchema,
  defineDomainEvent,
} from '@uptimebuyer/contracts';
import { z } from 'zod';

export const CompatibilityEvaluatedPayloadSchema = z.strictObject({
  compatibilityDecisionId: CompatibilityDecisionIdSchema,
  incidentId: IncidentIdSchema,
  candidateActionId: CandidateActionIdSchema,
  decision: CompatibilityDecisionValueSchema,
  reasonCodes: z.array(ReasonCodeSchema).max(64),
  actionDigest: VersionedDigestSchema,
  assetRevisionId: AssetRevisionIdSchema,
  evidenceRevisionId: EvidenceRevisionIdSchema,
  policyRevisionId: PolicyRevisionIdSchema,
  inputDigest: VersionedDigestSchema,
  supersededDecisionId: CompatibilityDecisionIdSchema.nullable(),
  approved: z.literal(false),
});
export const CompatibilityEvaluatedEventSchema = defineDomainEvent(
  'compatibility.evaluated.v1',
  CompatibilityEvaluatedPayloadSchema,
  'compatibilityDecisionId',
);
export type CompatibilityEvaluatedEvent = z.output<typeof CompatibilityEvaluatedEventSchema>;
