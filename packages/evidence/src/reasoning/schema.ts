// The versioned typed reasoning contract (AI-SAFETY §4). The schema is strict: it has no field for an approval,
// compatibility verdict, payment instruction, URL or closure, so such output cannot be represented and is rejected.
// Free text is bounded and display-only.
import {
  CitationIdSchema,
  CitationLocatorSchema,
  EvidenceRevisionIdSchema,
  IncidentIdSchema,
  Sha256DigestSchema,
} from '@uptimebuyer/contracts';
import { z } from 'zod';

export const PROPOSAL_SCHEMA_VERSION = 1;

export const FAULT_CODES = Object.freeze([
  'REFRIGERATION_TEMPERATURE_HIGH',
  'EVAPORATOR_FAN_FAILURE',
  'CONDENSER_FAN_FAILURE',
  'COMPRESSOR_FAILURE',
  'DEFROST_FAILURE',
  'DOOR_SEAL_FAILURE',
  'CONTROLLER_FAILURE',
  'REFRIGERANT_LEAK',
  'POWER_SUPPLY_FAILURE',
  'SENSOR_FAULT',
  'UNKNOWN',
] as const);

export const EXTRACTED_FIELDS = Object.freeze([
  'MANUFACTURER',
  'MODEL',
  'SERIAL',
  'OEM_PART_NUMBER',
  'REFRIGERANT',
  'RATED_VOLTAGE',
  'PROCEDURE',
  'WARNING',
  'SYMPTOM',
] as const);

export const UNCERTAINTY_CODES = Object.freeze([
  'CONFLICTING_SOURCES',
  'MISSING_SERIAL',
  'MISSING_MODEL',
  'MISSING_PART_NUMBER',
  'SINGLE_SOURCE',
  'STALE_DOCUMENT',
  'UNTRUSTED_INSTRUCTIONS_PRESENT',
  'INSUFFICIENT_EVIDENCE',
] as const);

export const MISSING_FIELDS = Object.freeze([
  'OEM_PART_NUMBER',
  'SERIAL',
  'MODEL',
  'RATED_VOLTAGE',
  'REFRIGERANT',
  'DIMENSIONS',
  'CERTIFICATION',
  'WARRANTY_STATUS',
  'APPROVED_VENDOR',
] as const);

const text = (max: number) => z.string().min(1).max(max);
const citationIds = (max: number) => z.array(CitationIdSchema).max(max);

export const ProposalCitationSchema = z.strictObject({
  citationId: CitationIdSchema,
  sourceDigest: Sha256DigestSchema,
  locator: CitationLocatorSchema,
  /** Optional exact quote; when present it must occur in the cited span. */
  quote: z.string().min(1).max(300).nullable(),
});

export const ReasoningProposalSchema = z.strictObject({
  schemaVersion: z.literal(PROPOSAL_SCHEMA_VERSION),
  incidentId: IncidentIdSchema,
  evidenceRevisionId: EvidenceRevisionIdSchema,
  inputDigest: z.string().regex(/^reasoning-input\.v1:sha256:[0-9a-f]{64}$/),
  faultHypotheses: z
    .array(z.strictObject({ code: z.enum(FAULT_CODES), rationale: text(500), citationIds: citationIds(8) }))
    .max(5),
  extractedFields: z
    .array(
      z.strictObject({
        field: z.enum(EXTRACTED_FIELDS),
        component: text(120).nullable(),
        value: text(200),
        citations: z.array(ProposalCitationSchema).min(1).max(4),
      }),
    )
    .max(40),
  candidateActions: z
    .array(
      z.strictObject({
        kind: z.enum(['REPLACE_PART', 'SERVICE_VISIT', 'DIAGNOSTIC', 'TEMPORARY_CONTAINMENT']),
        component: text(120).nullable(),
        partNumber: text(60).nullable(),
        manufacturer: text(200).nullable(),
        evidenceFor: citationIds(8),
        evidenceAgainst: citationIds(8),
        missingFields: z.array(z.enum(MISSING_FIELDS)).max(9),
        /** The only representable compatibility statement: a candidate for deterministic evaluation (INV-02/04). */
        compatibilityClaim: z.literal('CANDIDATE_ONLY'),
      }),
    )
    .max(10),
  conflicts: z.array(z.strictObject({ factKey: text(90), citationIds: citationIds(8) })).max(20),
  uncertainty: z.array(z.enum(UNCERTAINTY_CODES)).max(8),
  /** Proposed provider queries, never direct calls (AI-SAFETY §4). */
  providerQueries: z
    .array(
      z.strictObject({
        kind: z.enum(['PART_AVAILABILITY', 'TECHNICIAN']),
        component: text(120).nullable(),
        partNumber: text(60).nullable(),
      }),
    )
    .max(5),
  confidencePpm: z.int().min(0).max(1_000_000),
  summary: text(1000),
});
export type ReasoningProposal = z.output<typeof ReasoningProposalSchema>;

/** Every citation id a proposal references. */
export function referencedCitationIds(p: ReasoningProposal): string[] {
  return [
    ...p.faultHypotheses.flatMap((h) => h.citationIds),
    ...p.extractedFields.flatMap((f) => f.citations.map((c) => c.citationId)),
    ...p.candidateActions.flatMap((a) => [...a.evidenceFor, ...a.evidenceAgainst]),
    ...p.conflicts.flatMap((c) => c.citationIds),
  ];
}

/** Strict JSON Schema handed to the model (OpenAI-compatible `response_format: json_schema`, `strict: true`). */
export const PROPOSAL_JSON_SCHEMA: Record<string, unknown> = (() => {
  const schema = z.toJSONSchema(ReasoningProposalSchema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
})();
