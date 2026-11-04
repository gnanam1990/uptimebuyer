// plan.created.v1 (API-EVENT-SPEC §6): a revision-bound recovery plan was persisted. It reports an advisory ranking,
// never an approval to spend or execute (`approved` is always false). plan.invalidated.v1 is emitted on the
// incident's plan scope with the M08 payload variant defined beside the M05/M06 variants in @uptimebuyer/evidence.
import {
  AssetRevisionIdSchema,
  EvidenceRevisionIdSchema,
  IncidentIdSchema,
  PlanIdSchema,
  PolicyRevisionIdSchema,
  VersionedDigestSchema,
  defineDomainEvent,
} from '@uptimebuyer/contracts';
import { z } from 'zod';

export const PlanCreatedPayloadSchema = z.strictObject({
  planId: PlanIdSchema,
  incidentId: IncidentIdSchema,
  revision: z.int().min(1),
  planHash: z.string().regex(/^recovery-plan\.v1:sha256:[0-9a-f]{64}$/),
  state: z.enum(['APPROVABLE', 'HELD']),
  outcome: z.enum(['RANKED', 'INCOMPLETE', 'NO_ELIGIBLE_CANDIDATE']),
  assetRevisionId: AssetRevisionIdSchema,
  evidenceRevisionId: EvidenceRevisionIdSchema,
  policyRevisionId: PolicyRevisionIdSchema,
  riskEstimateId: z
    .string()
    .regex(/^tre_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/)
    .nullable(),
  rankedActionDigests: z.array(VersionedDigestSchema).max(50),
  supersededPlanIds: z.array(PlanIdSchema).max(10_000),
  approved: z.literal(false),
});
export const PlanCreatedEventSchema = defineDomainEvent('plan.created.v1', PlanCreatedPayloadSchema, 'planId');
export type PlanCreatedEvent = z.output<typeof PlanCreatedEventSchema>;
