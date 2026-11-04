// Normalized adapter results (KITE-OPENSERV-INTEGRATION §4). Provider references are optional: a pre-egress client
// operation identity plus authoritative evidence can resolve an outcome without one.
import { z } from 'zod';
import { ProviderRefSchema, ReasonCodeSchema, Sha256DigestSchema } from './codes.js';
import { BlobIdSchema, ClientOperationIdSchema } from './ids.js';
import { UtcInstantSchema } from './time.js';

export const EvidenceRefSchema = z.strictObject({ blobId: BlobIdSchema, digest: Sha256DigestSchema });
export type EvidenceRef = z.output<typeof EvidenceRefSchema>;

export const AdapterCapabilityAssessmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ELIGIBLE') }),
  z.strictObject({ kind: z.literal('UNSUPPORTED'), reasonCode: ReasonCodeSchema }),
]);
export type AdapterCapabilityAssessment = z.output<typeof AdapterCapabilityAssessmentSchema>;

const observed = { observedAt: UtcInstantSchema, rawResponseDigest: Sha256DigestSchema };

export const ExternalOutcomeResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ACCEPTED'),
    clientOperationId: ClientOperationIdSchema,
    providerRef: ProviderRefSchema.optional(),
    evidence: EvidenceRefSchema,
    ...observed,
  }),
  z.strictObject({
    kind: z.literal('CONFIRMED'),
    clientOperationId: ClientOperationIdSchema,
    providerRef: ProviderRefSchema.optional(),
    receipt: EvidenceRefSchema,
    ...observed,
  }),
  z.strictObject({
    kind: z.literal('FAILED'),
    clientOperationId: ClientOperationIdSchema,
    reasonCode: ReasonCodeSchema,
    /** FAILED is only ever reported with definite proof that no economic/external effect exists. */
    effect: z.literal('NO_EFFECT_PROVED'),
    ...observed,
  }),
  z.strictObject({
    kind: z.literal('CANCELLED'),
    clientOperationId: ClientOperationIdSchema,
    providerRef: ProviderRefSchema.optional(),
    evidence: EvidenceRefSchema,
    ...observed,
  }),
  z.strictObject({
    kind: z.literal('UNKNOWN'),
    clientOperationId: ClientOperationIdSchema,
    providerRef: ProviderRefSchema.optional(),
    reconcileAfter: UtcInstantSchema,
    observedAt: UtcInstantSchema,
    /** A timeout may have no response body at all. */
    rawResponseDigest: Sha256DigestSchema.nullable(),
  }),
]);
export type ExternalOutcomeResult = z.output<typeof ExternalOutcomeResultSchema>;
