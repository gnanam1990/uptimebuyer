// Evidence contracts: citations, immutable revision manifests and the append-only evidence-ledger envelope (FR-18,
// INV-10). Payloads are referenced by digest, so the envelope carries no persistence-specific coupling.
import { z } from 'zod';
import { SchemaNameSchema, Sha256DigestSchema, VersionedDigestSchema } from './codes.js';
import { AggregateTypeSchema } from './events.js';
import {
  AssetRevisionIdSchema,
  BlobIdSchema,
  CausationIdSchema,
  CitationIdSchema,
  CorrelationIdSchema,
  EvidenceIdSchema,
  EvidenceRevisionIdSchema,
  IncidentIdSchema,
  OpaqueIdSchema,
  TenantIdSchema,
} from './ids.js';
import { EvidenceRevisionStateSchema } from './states.js';
import { UtcInstantSchema } from './time.js';

const before = (a: string, b: string) => Date.parse(a) < Date.parse(b);

export const CitationLocatorSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({ kind: z.literal('PAGE'), page: z.int().min(1), pageEnd: z.int().min(1).nullable() })
    .refine((l) => l.pageEnd === null || l.pageEnd >= l.page, { path: ['pageEnd'], message: 'pageEnd precedes page.' }),
  z.strictObject({ kind: z.literal('SECTION'), sectionPath: z.string().min(1).max(256) }),
  z.strictObject({ kind: z.literal('RECORD'), recordKey: z.string().min(1).max(256) }),
  z
    .strictObject({ kind: z.literal('TIME_RANGE'), fromAt: UtcInstantSchema, toAt: UtcInstantSchema })
    .refine((l) => before(l.fromAt, l.toAt), { path: ['toAt'], message: 'Range must be non-empty.' }),
]);
export type CitationLocator = z.output<typeof CitationLocatorSchema>;

export const EXTRACTION_METHODS = Object.freeze([
  'STRUCTURED_IMPORT',
  'PDF_TEXT',
  'OCR',
  'MANUAL_ENTRY',
  'MODEL_EXTRACTION',
] as const);
export const ExtractionMethodSchema = z.enum(EXTRACTION_METHODS);

export const CitationSchema = z.strictObject({
  citationId: CitationIdSchema,
  tenantId: TenantIdSchema,
  evidenceRevisionId: EvidenceRevisionIdSchema,
  blobId: BlobIdSchema,
  sourceDigest: Sha256DigestSchema,
  locator: CitationLocatorSchema,
  quotedDigest: Sha256DigestSchema,
  extractionMethod: ExtractionMethodSchema,
});
export type Citation = z.output<typeof CitationSchema>;

export const EVIDENCE_ITEM_ROLES = Object.freeze([
  'MANUAL',
  'PARTS_LIST',
  'WARRANTY',
  'WORK_ORDER',
  'VENDOR_RECORD',
  'TELEMETRY_WINDOW',
  'TRANSCRIPT',
  'QUOTE',
  'RECEIPT',
  'PHOTO',
  'OTHER',
] as const);
export const EvidenceItemRoleSchema = z.enum(EVIDENCE_ITEM_ROLES);

export const EvidenceItemSchema = z.strictObject({
  blobId: BlobIdSchema,
  role: EvidenceItemRoleSchema,
  sourceDigest: Sha256DigestSchema,
  sourceAt: UtcInstantSchema,
  locator: CitationLocatorSchema.nullable(),
});
export type EvidenceItem = z.output<typeof EvidenceItemSchema>;

/** Immutable manifest of one evidence revision. A material change is a higher revision, never an edit. */
export const EvidenceRevisionManifestSchema = z
  .strictObject({
    evidenceRevisionId: EvidenceRevisionIdSchema,
    tenantId: TenantIdSchema,
    incidentId: IncidentIdSchema,
    assetRevisionId: AssetRevisionIdSchema,
    revision: z.int().min(1),
    previousRevisionId: EvidenceRevisionIdSchema.nullable(),
    state: EvidenceRevisionStateSchema,
    items: z.array(EvidenceItemSchema).max(10_000),
    citations: z.array(CitationSchema).max(10_000),
    createdAt: UtcInstantSchema,
  })
  .superRefine((m, ctx) => {
    if ((m.revision === 1) !== (m.previousRevisionId === null))
      ctx.addIssue({ code: 'custom', path: ['previousRevisionId'], message: 'Only revision 1 has no predecessor.' });
    m.citations.forEach((c, i) => {
      if (c.tenantId !== m.tenantId || c.evidenceRevisionId !== m.evidenceRevisionId)
        ctx.addIssue({
          code: 'custom',
          path: ['citations', i],
          message: 'Citation belongs to another tenant or revision.',
        });
      if (!m.items.some((it) => it.blobId === c.blobId && it.sourceDigest === c.sourceDigest))
        ctx.addIssue({ code: 'custom', path: ['citations', i], message: 'Citation is outside the referenced digest.' });
    });
  });
export type EvidenceRevisionManifest = z.output<typeof EvidenceRevisionManifestSchema>;

export const CorrelationSchema = z.strictObject({
  correlationId: CorrelationIdSchema,
  causationId: CausationIdSchema.nullable(),
});
export type Correlation = z.output<typeof CorrelationSchema>;

/** FR-18 ledger categories. */
export const EVIDENCE_RECORD_KINDS = Object.freeze([
  'MATERIAL_INPUT',
  'MODEL_PROPOSAL',
  'POLICY_DECISION',
  'APPROVAL',
  'EXTERNAL_ACTION',
  'PAYMENT_STATE',
  'RECEIPT',
  'RECOVERY_DECISION',
] as const);
export const EvidenceRecordKindSchema = z.enum(EVIDENCE_RECORD_KINDS);
export type EvidenceRecordKind = z.infer<typeof EvidenceRecordKindSchema>;

/** Provenance class. `CONTRACT_FAKE` marks results from a contract fake: never real-world evidence. */
export const EVIDENCE_TRUST_LEVELS = Object.freeze([
  'AUTHORITATIVE',
  'OPERATOR_ATTESTED',
  'PROVIDER_REPORTED',
  'MODEL_PROPOSED',
  'CONTRACT_FAKE',
] as const);
export const EvidenceTrustSchema = z.enum(EVIDENCE_TRUST_LEVELS);
export type EvidenceTrust = z.infer<typeof EvidenceTrustSchema>;

export const EvidenceEnvelopeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    evidenceId: EvidenceIdSchema,
    tenantId: TenantIdSchema,
    sequence: z.int().min(1),
    kind: EvidenceRecordKindSchema,
    trust: EvidenceTrustSchema,
    subject: z.strictObject({ aggregateType: AggregateTypeSchema, aggregateId: OpaqueIdSchema }),
    incidentId: IncidentIdSchema.nullable(),
    recordedAt: UtcInstantSchema,
    correlation: CorrelationSchema,
    payloadSchema: SchemaNameSchema,
    payloadDigest: Sha256DigestSchema,
    payloadRef: BlobIdSchema.nullable(),
    /** A correction links to the record it supersedes; the original is never edited. */
    supersedesEvidenceId: EvidenceIdSchema.nullable(),
    previousEnvelopeDigest: VersionedDigestSchema.nullable(),
    envelopeDigest: VersionedDigestSchema,
  })
  .superRefine((e, ctx) => {
    if ((e.sequence === 1) !== (e.previousEnvelopeDigest === null))
      ctx.addIssue({
        code: 'custom',
        path: ['previousEnvelopeDigest'],
        message: 'Only the first entry has no predecessor.',
      });
    if (e.supersedesEvidenceId === e.evidenceId)
      ctx.addIssue({ code: 'custom', path: ['supersedesEvidenceId'], message: 'A record cannot supersede itself.' });
  });
export type EvidenceEnvelope = z.output<typeof EvidenceEnvelopeSchema>;
