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
  type SiteId,
  type TenantId,
  type UtcInstant,
  decodeWire,
} from '@uptimebuyer/contracts';
import { canonicalize, computeEnvelopeDigest, verifyEvidenceChain, type ChainVerification } from '@uptimebuyer/domain';
import { authorize, requireAuthorized } from './authz.js';
import { Denial, notPermitted, recordAudit, resourceUnavailable, tenantCommand, unavailable } from './command.js';
import { actorOf, assertTenantContext, type TenantContext } from './context.js';
import {
  dbNow,
  isoNN,
  lockKey,
  pgCode,
  sha256Digest,
  UNIQUE_VIOLATION,
  versionConflict,
  type Db,
  type Tx,
} from './db.js';
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

export interface EvidenceRevisionCommitInput {
  incidentId: IncidentId | string;
  assetRevisionId: AssetRevisionId;
  items: readonly EvidenceRevisionItemInput[];
}

export interface EvidenceRevisionCommitted {
  evidenceRevisionId: EvidenceRevisionId;
  revision: number;
  manifestSha256: string;
  previousRevisionId: EvidenceRevisionId | null;
}

function validateRevisionInput(input: EvidenceRevisionCommitInput): void {
  if (!IncidentIdSchema.safeParse(input.incidentId).success || input.items.length > 10_000)
    throw validation('INVALID_EVIDENCE_REVISION');
  for (const it of input.items)
    if (
      !BlobIdSchema.safeParse(it.blobId).success ||
      !(EVIDENCE_ITEM_ROLES as readonly string[]).includes(it.role) ||
      Number.isNaN(Date.parse(String(it.sourceAt)))
    )
      throw validation('INVALID_EVIDENCE_ITEM');
}

/** Commit the next immutable evidence manifest for an incident, bound to an exact asset revision. */
export async function commitEvidenceRevision(
  pool: Db,
  ctx: TenantContext,
  input: EvidenceRevisionCommitInput,
): Promise<{ evidenceRevisionId: EvidenceRevisionId; revision: number; manifestSha256: string }> {
  validateRevisionInput(input);
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
    const r = await insertEvidenceRevision(c, ctx, input);
    return { evidenceRevisionId: r.evidenceRevisionId, revision: r.revision, manifestSha256: r.manifestSha256 };
  });
}

/**
 * The evidence-revision commit inside the caller's domain transaction (M05 commits the manifest atomically with its
 * document set, conflicts, proposal supersession and invalidation events). A human needs `evidence.submit` at the
 * incident's site; a server path needs `evidence.engine`. The caller has already resolved the incident and the
 * asset revision in this tenant; the database additionally binds the asset revision to the incident's asset.
 */
export async function commitEvidenceRevisionInTx(
  client: Tx,
  ctx: TenantContext,
  input: EvidenceRevisionCommitInput,
  scope: { siteId: SiteId },
): Promise<EvidenceRevisionCommitted> {
  assertTenantContext(ctx);
  validateRevisionInput(input);
  const decision =
    ctx.principal.kind === 'HUMAN'
      ? authorize(ctx, { action: 'evidence.submit', siteId: scope.siteId })
      : authorize(ctx, { action: 'evidence.engine' });
  if (!decision.allowed) throw notPermitted(decision.reasonCode);
  return insertEvidenceRevision(client, ctx, input);
}

async function insertEvidenceRevision(
  c: Tx,
  ctx: TenantContext,
  input: EvidenceRevisionCommitInput,
): Promise<EvidenceRevisionCommitted> {
  await lockKey(c, `evidence-revision:${ctx.tenantId}:${input.incidentId}`);
  const prev = await c.query<{ id: EvidenceRevisionId; revision: number }>(
    `SELECT id, revision FROM evidence_revisions WHERE tenant_id = $1 AND incident_id = $2 ORDER BY revision DESC LIMIT 1`,
    [ctx.tenantId, input.incidentId],
  );
  const revision = (prev.rows[0]?.revision ?? 0) + 1;
  const previousRevisionId = prev.rows[0]?.id ?? null;
  const evidenceRevisionId = newId('evidenceRevision');
  const items = input.items.map((it, i) => ({
    ordinal: i + 1,
    blobId: it.blobId,
    role: it.role,
    locator: it.locator ?? null,
    sourceAt: new Date(it.sourceAt).toISOString(),
  }));
  const manifestSha256 = evidenceManifestDigest({
    tenantId: ctx.tenantId,
    evidenceRevisionId,
    incidentId: input.incidentId,
    assetRevisionId: input.assetRevisionId,
    revision,
    previousRevisionId,
    items,
  });
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
      previousRevisionId,
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
    payload: {
      evidenceRevisionId,
      incidentId: input.incidentId,
      revision,
      manifestSha256,
      assetRevisionId: input.assetRevisionId,
      previousRevisionId,
    },
    correlationId: ctx.correlationId,
    causationId: newId('command'),
  });
  await recordAudit(c, ctx, {
    action: 'evidence_revision.commit',
    resourceType: 'evidence_revision',
    resourceId: evidenceRevisionId,
    result: 'SUCCEEDED',
  });
  return { evidenceRevisionId, revision, manifestSha256, previousRevisionId };
}

/**
 * The manifest digest of an evidence revision, recomputable from its stored rows (INV-10: historical revisions stay
 * reproducible). `items[].sourceAt` is the ISO-8601 UTC instant with milliseconds.
 */
export function evidenceManifestDigest(m: {
  tenantId: string;
  evidenceRevisionId: string;
  incidentId: string;
  assetRevisionId: string;
  revision: number;
  previousRevisionId: string | null;
  items: readonly { ordinal: number; blobId: string; role: string; locator: unknown; sourceAt: string }[];
}): string {
  return sha256Digest(
    canonicalize({
      tenantId: m.tenantId,
      evidenceRevisionId: m.evidenceRevisionId,
      incidentId: m.incidentId,
      assetRevisionId: m.assetRevisionId,
      revision: m.revision,
      previousRevisionId: m.previousRevisionId,
      items: m.items.map((it) => ({
        ordinal: it.ordinal,
        blobId: it.blobId,
        role: it.role,
        locator: it.locator ?? null,
        sourceAt: it.sourceAt,
      })),
    }),
  );
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

type LedgerWriter = 'HUMAN' | 'DEVICE' | 'SYSTEM';

const ledgerDenied = (reasonCode: string, resourceId: string | null = null) =>
  new Denial(notPermitted(reasonCode), {
    action: 'evidence_ledger.append',
    resourceType: 'evidence',
    resourceId,
    reasonCode,
  });

/**
 * Generic evidence submission (the only ledger path reachable from request handlers). Humans holding
 * `evidence.submit` append OPERATOR_ATTESTED material input; devices append AUTHORITATIVE telemetry-derived
 * (`telemetry.*`) material input about themselves and never correct. Every other kind or trust is server-produced
 * and goes through `appendSystemEvidence`.
 */
export async function appendLedgerEvidence(
  pool: Db,
  ctx: TenantContext,
  input: LedgerEvidenceInput,
): Promise<EvidenceEnvelope> {
  const meta = { action: 'evidence_ledger.append', resourceType: 'evidence', resourceId: input.supersedesEvidenceId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const p = ctx.principal;
    let writer: LedgerWriter;
    if (p.kind === 'HUMAN') {
      requireAuthorized(ctx, { action: 'evidence.submit', siteId: null });
      if (input.kind !== 'MATERIAL_INPUT') throw ledgerDenied('EVIDENCE_KIND_NOT_PERMITTED');
      if (input.trust !== 'OPERATOR_ATTESTED') throw ledgerDenied('EVIDENCE_TRUST_NOT_PERMITTED');
      writer = 'HUMAN';
    } else if (p.kind === 'DEVICE') {
      requireAuthorized(ctx, { action: 'telemetry.ingest', siteId: p.siteId });
      if (input.kind !== 'MATERIAL_INPUT') throw ledgerDenied('EVIDENCE_KIND_NOT_PERMITTED');
      if (input.trust !== 'AUTHORITATIVE') throw ledgerDenied('EVIDENCE_TRUST_NOT_PERMITTED');
      if (input.subject.aggregateType !== 'device' || input.subject.aggregateId !== p.id)
        throw ledgerDenied('EVIDENCE_SUBJECT_NOT_SELF');
      if (!/^telemetry\.[a-z0-9_.]+\.v[1-9][0-9]*$/.test(input.payloadSchema))
        throw ledgerDenied('EVIDENCE_PAYLOAD_NOT_TELEMETRY');
      if (input.supersedesEvidenceId !== null) throw ledgerDenied('DEVICE_CANNOT_CORRECT');
      writer = 'DEVICE';
    } else throw ledgerDenied('PRINCIPAL_KIND_NOT_PERMITTED');
    return insertLedgerEntry(c, ctx, input, writer);
  });
}

/**
 * Server-side ledger path for server-produced kinds (approval, policy decision, external action, payment state,
 * receipt, recovery decision, model proposal). Runs inside the caller's domain transaction and is permitted only
 * for outbox/job worker contexts and authenticated service workloads holding the `worker` role; it can never
 * claim human attestation.
 */
export async function appendSystemEvidence(
  client: Tx,
  ctx: TenantContext,
  input: LedgerEvidenceInput,
): Promise<EvidenceEnvelope> {
  assertTenantContext(ctx);
  const p = ctx.principal;
  const permitted = p.kind === 'WORKER' || (p.kind === 'SERVICE' && authorize(ctx, { action: 'job.execute' }).allowed);
  if (!permitted) throw notPermitted('PRINCIPAL_KIND_NOT_PERMITTED');
  if (input.trust === 'OPERATOR_ATTESTED') throw notPermitted('EVIDENCE_TRUST_NOT_PERMITTED');
  try {
    return await insertLedgerEntry(client, ctx, input, 'SYSTEM');
  } catch (e) {
    if (e instanceof Denial) throw e.error;
    throw e;
  }
}

/**
 * The human (operator-attested) ledger path inside the caller's domain transaction, so a server command that records
 * a human's material input (M04 manual reports) commits the ledger entry atomically with its own rows. Same rules as
 * `appendLedgerEvidence` for a human: `evidence.submit`, MATERIAL_INPUT and OPERATOR_ATTESTED only.
 */
export async function appendOperatorEvidence(
  client: Tx,
  ctx: TenantContext,
  input: LedgerEvidenceInput,
  scope: { siteId: SiteId },
): Promise<EvidenceEnvelope> {
  assertTenantContext(ctx);
  if (ctx.principal.kind !== 'HUMAN') throw notPermitted('PRINCIPAL_KIND_NOT_PERMITTED');
  const decision = authorize(ctx, { action: 'evidence.submit', siteId: scope.siteId });
  if (!decision.allowed) throw notPermitted(decision.reasonCode);
  if (input.kind !== 'MATERIAL_INPUT') throw notPermitted('EVIDENCE_KIND_NOT_PERMITTED');
  if (input.trust !== 'OPERATOR_ATTESTED') throw notPermitted('EVIDENCE_TRUST_NOT_PERMITTED');
  try {
    return await insertLedgerEntry(client, ctx, input, 'HUMAN');
  } catch (e) {
    if (e instanceof Denial) throw e.error;
    throw e;
  }
}

const RECORD_KINDS = new Set(['APPROVAL', 'PAYMENT_STATE', 'EXTERNAL_ACTION', 'RECEIPT']);
const RECORD_TRUST = new Set(['AUTHORITATIVE', 'PROVIDER_REPORTED', 'CONTRACT_FAKE']);

/**
 * M13 (FR-18, T-055): the ledger entry for a server-produced durable record — a signed approval, a commercial-intent
 * payment state, an external attempt or order outcome, a receipt — appended inside that record's own transaction
 * whatever principal triggered the command, so the exportable ledger is complete. The kind and trust are fixed by
 * server code (never request input): only record kinds, never human attestation, never a correction; a result from a
 * recorded contract or fake adapter must be labelled CONTRACT_FAKE by the caller.
 */
export async function appendRecordEvidence(
  client: Tx,
  ctx: TenantContext,
  input: LedgerEvidenceInput,
): Promise<EvidenceEnvelope> {
  assertTenantContext(ctx);
  if (!RECORD_KINDS.has(input.kind)) throw notPermitted('EVIDENCE_KIND_NOT_PERMITTED');
  if (!RECORD_TRUST.has(input.trust)) throw notPermitted('EVIDENCE_TRUST_NOT_PERMITTED');
  if (input.supersedesEvidenceId !== null) throw notPermitted('RECORD_EVIDENCE_NOT_CORRECTABLE');
  try {
    return await insertLedgerEntry(client, ctx, input, 'SYSTEM');
  } catch (e) {
    if (e instanceof Denial) throw e.error;
    throw e;
  }
}

/** Correction rules: same tenant, not already corrected, and of a kind the writer may correct. */
async function checkCorrection(c: Tx, ctx: TenantContext, writer: LedgerWriter, targetId: string): Promise<void> {
  const { rows } = await c.query<{ kind: string; trust: string }>(
    `SELECT kind, trust FROM evidence_ledger_entries WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, targetId],
  );
  const target = rows[0];
  if (!target)
    throw new Denial(resourceUnavailable(), {
      action: 'evidence_ledger.append',
      resourceType: 'evidence',
      resourceId: targetId,
      reasonCode: 'RESOURCE_UNAVAILABLE',
    });
  if (writer === 'HUMAN' && !(target.kind === 'MATERIAL_INPUT' && target.trust === 'OPERATOR_ATTESTED'))
    throw ledgerDenied('EVIDENCE_NOT_CORRECTABLE_BY_CALLER', targetId);
  if (writer === 'DEVICE') throw ledgerDenied('DEVICE_CANNOT_CORRECT', targetId);
  const already = await c.query(
    `SELECT 1 FROM evidence_ledger_entries WHERE tenant_id = $1 AND supersedes_evidence_id = $2`,
    [ctx.tenantId, targetId],
  );
  if (already.rowCount !== 0) throw versionConflict('EVIDENCE_ALREADY_CORRECTED');
}

async function insertLedgerEntry(
  c: Tx,
  ctx: TenantContext,
  input: LedgerEvidenceInput,
  writer: LedgerWriter,
): Promise<EvidenceEnvelope> {
  const meta = { action: 'evidence_ledger.append', resourceType: 'evidence', resourceId: input.supersedesEvidenceId };
  {
    await lockKey(c, `evidence-ledger:${ctx.tenantId}`);
    if (input.supersedesEvidenceId !== null) await checkCorrection(c, ctx, writer, input.supersedesEvidenceId);
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
    try {
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
    } catch (e) {
      if (pgCode(e) === UNIQUE_VIOLATION) throw versionConflict('EVIDENCE_ALREADY_CORRECTED');
      throw e;
    }
    await recordAudit(c, ctx, { ...meta, resourceId: envelope.evidenceId, result: 'SUCCEEDED' });
    return envelope;
  }
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
