// Evidence persistence (FR-18 shared layer, INV-10): tenant-prefixed content-addressed blobs, immutable evidence
// revision manifests, and the per-tenant hash-chained evidence-ledger envelope built with @uptimebuyer/domain.
// Corrections are new linked entries; the database rejects any UPDATE/DELETE.
import {
  BlobIdSchema,
  DomainError,
  EVIDENCE_ITEM_ROLES,
  EVIDENCE_TRUST_LEVELS,
  EvidenceEnvelopeSchema,
  IncidentIdSchema,
  Sha256DigestSchema,
  encodeWire,
  newId,
  type AggregateType,
  type AssetRevisionId,
  type EvidenceId,
  type EvidenceRecordKind,
  type BlobId,
  type Correlation,
  type EvidenceEnvelope,
  type EvidenceRevisionId,
  type EvidenceTrust,
  type IncidentId,
  type TenantId,
  type UtcInstant,
  decodeWire,
} from '@uptimebuyer/contracts';
import { canonicalize, computeEnvelopeDigest, verifyEvidenceChain, type ChainVerification } from '@uptimebuyer/domain';
import { requireAuthorized } from './authz.js';
import { recordAudit, tenantCommand, unavailable } from './command.js';
import { actorOf, type TenantContext } from './context.js';
import { dbNow, isoNN, lockKey, sha256Digest, type Db } from './db.js';
import { appendOutboxEvent } from './outbox.js';
import { tenantObjectKey } from './tenant-scope.js';

const validation = (reasonCode: string) =>
  new DomainError('VALIDATION_FAILED', 'Input failed contract validation.', { reasonCode });

export async function registerEvidenceBlob(
  pool: Db,
  ctx: TenantContext,
  input: { sha256: string; mediaType: string; sizeBytes: number; trustLevel: EvidenceTrust },
): Promise<{ blobId: BlobId; objectKey: string; existing: boolean }> {
  if (
    !Sha256DigestSchema.safeParse(input.sha256).success ||
    !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(input.mediaType) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 0 ||
    !(EVIDENCE_TRUST_LEVELS as readonly string[]).includes(input.trustLevel)
  )
    throw validation('INVALID_BLOB');
  const objectKey = tenantObjectKey(ctx, 'evidence', input.sha256);
  const meta = { action: 'evidence_blob.register', resourceType: 'evidence_blob', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'evidence.submit', siteId: null });
    const blobId = newId('blob');
    const ins = await c.query<{ id: BlobId }>(
      `INSERT INTO evidence_blobs (tenant_id, id, object_key, sha256, media_type, size_bytes, trust_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_id, sha256) DO NOTHING RETURNING id`,
      [ctx.tenantId, blobId, objectKey, input.sha256, input.mediaType, input.sizeBytes, input.trustLevel],
    );
    if (ins.rows[0]) {
      await recordAudit(c, ctx, { ...meta, resourceId: blobId, result: 'SUCCEEDED' });
      return { blobId, objectKey, existing: false };
    }
    const ex = await c.query<{ id: BlobId; object_key: string }>(
      `SELECT id, object_key FROM evidence_blobs WHERE tenant_id = $1 AND sha256 = $2`,
      [ctx.tenantId, input.sha256],
    );
    return { blobId: ex.rows[0]!.id, objectKey: ex.rows[0]!.object_key, existing: true };
  });
}

export interface EvidenceRevisionItemInput {
  blobId: BlobId;
  role: (typeof EVIDENCE_ITEM_ROLES)[number];
  locator?: Record<string, unknown> | null;
  sourceAt: UtcInstant | string;
}

/** Commit the next immutable evidence manifest for an incident, bound to an exact asset revision. */
export async function commitEvidenceRevision(
  pool: Db,
  ctx: TenantContext,
  input: {
    incidentId: IncidentId | string;
    assetRevisionId: AssetRevisionId;
    items: readonly EvidenceRevisionItemInput[];
  },
): Promise<{ evidenceRevisionId: EvidenceRevisionId; revision: number; manifestSha256: string }> {
  if (!IncidentIdSchema.safeParse(input.incidentId).success || input.items.length > 10_000)
    throw validation('INVALID_EVIDENCE_REVISION');
  for (const it of input.items)
    if (
      !BlobIdSchema.safeParse(it.blobId).success ||
      !(EVIDENCE_ITEM_ROLES as readonly string[]).includes(it.role) ||
      Number.isNaN(Date.parse(String(it.sourceAt)))
    )
      throw validation('INVALID_EVIDENCE_ITEM');
  const meta = {
    action: 'evidence_revision.commit',
    resourceType: 'asset_revision',
    resourceId: input.assetRevisionId,
  };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const ar = await c.query(
      `SELECT a.site_id FROM asset_revisions r JOIN assets a ON a.tenant_id = r.tenant_id AND a.id = r.asset_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [ctx.tenantId, input.assetRevisionId],
    );
    if (!ar.rows[0]) throw unavailable(meta);
    requireAuthorized(ctx, { action: 'evidence.submit', siteId: ar.rows[0].site_id });
    await lockKey(c, `evidence-revision:${ctx.tenantId}:${input.incidentId}`);
    const prev = await c.query<{ id: EvidenceRevisionId; revision: number }>(
      `SELECT id, revision FROM evidence_revisions WHERE tenant_id = $1 AND incident_id = $2 ORDER BY revision DESC LIMIT 1`,
      [ctx.tenantId, input.incidentId],
    );
    const revision = (prev.rows[0]?.revision ?? 0) + 1;
    const evidenceRevisionId = newId('evidenceRevision');
    const items = input.items.map((it, i) => ({
      ordinal: i + 1,
      blobId: it.blobId,
      role: it.role,
      locator: it.locator ?? null,
      sourceAt: new Date(it.sourceAt).toISOString(),
    }));
    const manifestSha256 = sha256Digest(
      canonicalize({
        tenantId: ctx.tenantId,
        evidenceRevisionId,
        incidentId: input.incidentId,
        assetRevisionId: input.assetRevisionId,
        revision,
        previousRevisionId: prev.rows[0]?.id ?? null,
        items,
      }),
    );
    const actor = actorOf(ctx);
    await c.query(
      `INSERT INTO evidence_revisions (tenant_id, id, incident_id, asset_revision_id, revision, previous_revision_id,
                                       manifest_sha256, created_by_kind, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ctx.tenantId,
        evidenceRevisionId,
        input.incidentId,
        input.assetRevisionId,
        revision,
        prev.rows[0]?.id ?? null,
        manifestSha256,
        actor.kind,
        actor.id,
      ],
    );
    for (const it of items)
      await c.query(
        `INSERT INTO evidence_revision_items (tenant_id, revision_id, ordinal, blob_id, role, locator, source_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ctx.tenantId,
          evidenceRevisionId,
          it.ordinal,
          it.blobId,
          it.role,
          it.locator === null ? null : JSON.stringify(it.locator),
          it.sourceAt,
        ],
      );
    await appendOutboxEvent(c, ctx, {
      eventType: 'evidence.revision_committed.v1',
      aggregateType: 'evidence_revision',
      aggregateId: evidenceRevisionId,
      aggregateVersion: 1,
      payload: { evidenceRevisionId, incidentId: input.incidentId, revision, manifestSha256 },
      correlationId: ctx.correlationId,
      causationId: newId('command'),
    });
    await recordAudit(c, ctx, {
      action: meta.action,
      resourceType: 'evidence_revision',
      resourceId: evidenceRevisionId,
      result: 'SUCCEEDED',
    });
    return { evidenceRevisionId, revision, manifestSha256 };
  });
}

export interface LedgerEvidenceInput {
  kind: EvidenceRecordKind;
  trust: EvidenceTrust;
  subject: { aggregateType: AggregateType; aggregateId: string };
  incidentId: IncidentId | string | null;
  payloadSchema: string;
  payloadDigest: string;
  payloadRef: BlobId | null;
  supersedesEvidenceId: EvidenceId | string | null;
  correlation?: Correlation;
}

interface LedgerRow {
  tenant_id: TenantId;
  id: string;
  sequence: number;
  kind: string;
  trust: string;
  subject_aggregate_type: string;
  subject_aggregate_id: string;
  incident_id: string | null;
  recorded_at: Date;
  correlation_id: string;
  causation_id: string | null;
  payload_schema: string;
  payload_digest: string;
  payload_ref: string | null;
  supersedes_evidence_id: string | null;
  previous_envelope_digest: string | null;
  envelope_digest: string;
}

const toEnvelope = (r: LedgerRow): EvidenceEnvelope =>
  decodeWire(EvidenceEnvelopeSchema, {
    schemaVersion: 1,
    evidenceId: r.id,
    tenantId: r.tenant_id,
    sequence: r.sequence,
    kind: r.kind,
    trust: r.trust,
    subject: { aggregateType: r.subject_aggregate_type, aggregateId: r.subject_aggregate_id },
    incidentId: r.incident_id,
    recordedAt: isoNN(r.recorded_at),
    correlation: { correlationId: r.correlation_id, causationId: r.causation_id },
    payloadSchema: r.payload_schema,
    payloadDigest: r.payload_digest,
    payloadRef: r.payload_ref,
    supersedesEvidenceId: r.supersedes_evidence_id,
    previousEnvelopeDigest: r.previous_envelope_digest,
    envelopeDigest: r.envelope_digest,
  });

/** Append one envelope to the tenant's evidence chain (serialized per tenant). */
export async function appendLedgerEvidence(
  pool: Db,
  ctx: TenantContext,
  input: LedgerEvidenceInput,
): Promise<EvidenceEnvelope> {
  const meta = { action: 'evidence_ledger.append', resourceType: 'evidence', resourceId: input.supersedesEvidenceId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'evidence.submit', siteId: null });
    await lockKey(c, `evidence-ledger:${ctx.tenantId}`);
    const last = await c.query<LedgerRow>(
      `SELECT * FROM evidence_ledger_entries WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [ctx.tenantId],
    );
    const prev = last.rows[0];
    const now = await dbNow(c);
    const recordedAt = (
      prev && prev.recorded_at.getTime() > Date.parse(now) ? isoNN(prev.recorded_at) : now
    ) as UtcInstant;
    const body = {
      schemaVersion: 1 as const,
      evidenceId: newId('evidence'),
      tenantId: ctx.tenantId,
      sequence: (prev?.sequence ?? 0) + 1,
      kind: input.kind,
      trust: input.trust,
      subject: input.subject,
      incidentId: input.incidentId,
      recordedAt,
      correlation: input.correlation ?? { correlationId: ctx.correlationId, causationId: null },
      payloadSchema: input.payloadSchema,
      payloadDigest: input.payloadDigest,
      payloadRef: input.payloadRef,
      supersedesEvidenceId: input.supersedesEvidenceId,
      previousEnvelopeDigest: prev ? prev.envelope_digest : null,
    };
    let envelope: EvidenceEnvelope;
    try {
      envelope = decodeWire(EvidenceEnvelopeSchema, { ...body, envelopeDigest: computeEnvelopeDigest(body as never) });
    } catch {
      throw validation('INVALID_EVIDENCE_ENVELOPE');
    }
    encodeWire(EvidenceEnvelopeSchema, envelope);
    await c.query(
      `INSERT INTO evidence_ledger_entries (tenant_id, id, sequence, kind, trust, subject_aggregate_type, subject_aggregate_id,
         incident_id, recorded_at, correlation_id, causation_id, payload_schema, payload_digest, payload_ref,
         supersedes_evidence_id, previous_envelope_digest, envelope_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        envelope.tenantId,
        envelope.evidenceId,
        envelope.sequence,
        envelope.kind,
        envelope.trust,
        envelope.subject.aggregateType,
        envelope.subject.aggregateId,
        envelope.incidentId,
        envelope.recordedAt,
        envelope.correlation.correlationId,
        envelope.correlation.causationId,
        envelope.payloadSchema,
        envelope.payloadDigest,
        envelope.payloadRef,
        envelope.supersedesEvidenceId,
        envelope.previousEnvelopeDigest,
        envelope.envelopeDigest,
      ],
    );
    await recordAudit(c, ctx, { ...meta, resourceId: envelope.evidenceId, result: 'SUCCEEDED' });
    return envelope;
  });
}

export async function readEvidenceLedger(pool: Db, ctx: TenantContext): Promise<EvidenceEnvelope[]> {
  return (await exportEvidenceLedger(pool, ctx)).entries;
}

export interface EvidenceLedgerExport {
  tenantId: TenantId;
  cutoffAt: UtcInstant;
  entries: EvidenceEnvelope[];
  chain: ChainVerification;
}

/** Redaction-safe export: envelopes reference payloads by digest only; the chain is re-verified on read. */
export async function exportEvidenceLedger(pool: Db, ctx: TenantContext): Promise<EvidenceLedgerExport> {
  const meta = { action: 'evidence.export', resourceType: 'evidence', resourceId: null };
  return tenantCommand(pool, ctx, meta, async (c) => {
    requireAuthorized(ctx, { action: 'evidence.export', siteId: null });
    const cutoffAt = await dbNow(c);
    const { rows } = await c.query<LedgerRow>(
      `SELECT * FROM evidence_ledger_entries WHERE tenant_id = $1 ORDER BY sequence`,
      [ctx.tenantId],
    );
    const entries = rows.map(toEnvelope);
    return { tenantId: ctx.tenantId, cutoffAt, entries, chain: verifyEvidenceChain(entries) };
  });
}
