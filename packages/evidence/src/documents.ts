// Versioned document ingestion (FR-05, NFR-04, INV-10, INV-13). Bytes are size-checked and parsed before anything is
// stored; the object is content-addressed in the caller's tenant namespace; the document row records source, trust,
// extraction method, parser version and exact applicability (manufacturer, model and optionally BOM revision, serial
// or a specific asset). Spans and exact facts are immutable. Withdrawal and replacement are append-only events.
import {
  AssetIdSchema,
  newId,
  type AssetId,
  type BlobId,
  type EvidenceTrust,
  type SiteId,
} from '@uptimebuyer/contracts';
import { canonicalDigest, canonicalize } from '@uptimebuyer/domain';
import {
  requireAuthorized,
  Denial,
  actorOf,
  lockKey,
  versionConflict,
  notPermitted,
  recordAudit,
  tenantCommand,
  unavailable,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { z } from 'zod';
import { rejected } from './errors.js';
import { newEvidenceId, type DocumentId } from './ids.js';
import { DOCUMENT_LIMITS } from './limits.js';
import { objectKeyFor, sha256DigestOf, type ObjectStorePort } from './object-store.js';
import type { WithheldReason } from './cmap.js';
import { extractFacts, parseDocument, SUPPORTED_MEDIA_TYPES, type ParsedDocument } from './parse.js';
import { requireAnyEvidenceRead, requireEvidenceRead, requireEvidenceWrite } from './scope.js';
import { scanUntrustedText } from './untrusted.js';

export const DOCUMENT_ROLES = Object.freeze([
  'MANUAL',
  'PARTS_LIST',
  'WARRANTY',
  'WORK_ORDER',
  'VENDOR_RECORD',
  'TRANSCRIPT',
  'OTHER',
] as const);
export type DocumentRole = (typeof DOCUMENT_ROLES)[number];
export const DOCUMENT_SOURCE_KINDS = Object.freeze([
  'OEM_PUBLICATION',
  'TENANT_RECORD',
  'SERVICE_HISTORY',
  'PROVIDER_DOCUMENT',
  'COMMUNICATION',
] as const);
export type DocumentSourceKind = (typeof DOCUMENT_SOURCE_KINDS)[number] | 'REGISTRY_SNAPSHOT';

const text = (max: number) => z.string().trim().min(1).max(max);
const ApplicabilitySchema = z.strictObject({
  manufacturer: text(200),
  model: text(200),
  bomRevision: text(100).nullable().optional(),
  serial: text(200).nullable().optional(),
  assetId: AssetIdSchema.nullable().optional(),
});

const IngestSchema = z.strictObject({
  role: z.enum(DOCUMENT_ROLES),
  mediaType: z.enum(SUPPORTED_MEDIA_TYPES),
  bytes: z.instanceof(Uint8Array),
  title: text(300),
  documentRevision: text(100),
  applicability: ApplicabilitySchema,
  sourceKind: z.enum(DOCUMENT_SOURCE_KINDS),
  /** Provenance label only (e.g. "dealer portal export"); never fetched or dereferenced. */
  sourceRef: text(300).nullable().optional(),
  communication: z
    .strictObject({ consentRef: text(200), purposes: z.array(z.literal('EVIDENCE_REASONING')).min(1).max(1) })
    .nullable()
    .optional(),
  supersedesDocumentId: z.string().regex(/^doc_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/).nullable().optional(),
});

export interface IngestDocumentInput {
  role: DocumentRole;
  mediaType: string;
  bytes: Uint8Array;
  title: string;
  documentRevision: string;
  applicability: {
    manufacturer: string;
    model: string;
    bomRevision?: string | null;
    serial?: string | null;
    assetId?: AssetId | null;
  };
  sourceKind: (typeof DOCUMENT_SOURCE_KINDS)[number];
  sourceRef?: string | null;
  communication?: { consentRef: string; purposes: 'EVIDENCE_REASONING'[] } | null;
  supersedesDocumentId?: string | null;
}

export interface IngestedDocument {
  documentId: DocumentId;
  blobId: BlobId;
  sha256: string;
  objectKey: string;
  mediaType: string;
  extractionMethod: ParsedDocument['extractionMethod'];
  pageCount: number;
  spanCount: number;
  factCount: number;
  injectionFlaggedSpanCount: number;
  activeContentRemoved: string[];
  /** Why some PDF text was withheld (shown as U+FFFD) instead of decoded; empty when nothing was withheld. */
  textWithheld: WithheldReason[];
  /** The parser version that derived the returned document's spans. */
  parserVersion: string;
  /** The older derivation of the same blob this document re-derived (parser upgrade), if any. */
  rederivedFromDocumentId: DocumentId | null;
  trustLevel: EvidenceTrust;
  existing: boolean;
}

export interface DocumentRecord {
  documentId: DocumentId;
  blobId: BlobId;
  sha256: string;
  objectKey: string;
  role: DocumentRole;
  title: string;
  documentRevision: string;
  applicability: { manufacturer: string; model: string; bomRevision: string | null; serial: string | null; assetId: string | null };
  siteId: SiteId | null;
  sourceKind: DocumentSourceKind;
  sourceRef: string | null;
  trustLevel: EvidenceTrust;
  mediaType: string;
  extractionMethod: ParsedDocument['extractionMethod'];
  parserVersion: string;
  pageCount: number;
  spanCount: number;
  activeContentRemoved: string[];
  textWithheld: WithheldReason[];
  /** An explicit replacement: the document this one replaced. */
  supersedesDocumentId: DocumentId | null;
  /** A parser re-derivation: the older derivation of the same blob this one replaced. */
  rederivedFromDocumentId: DocumentId | null;
  withdrawn: boolean;
  createdAt: string;
}

export interface DocumentRow {
  id: DocumentId;
  blob_id: BlobId;
  sha256: string;
  object_key: string;
  role: DocumentRole;
  title: string;
  document_revision: string;
  manufacturer: string;
  model: string;
  bom_revision: string | null;
  serial: string | null;
  asset_id: string | null;
  site_id: SiteId | null;
  source_kind: DocumentSourceKind;
  source_ref: string | null;
  trust_level: EvidenceTrust;
  media_type: string;
  extraction_method: ParsedDocument['extractionMethod'];
  parser_version: string;
  page_count: number;
  span_count: number;
  active_content_removed: string[];
  text_withheld: WithheldReason[];
  supersedes_document_id: DocumentId | null;
  rederived_from_document_id: DocumentId | null;
  applicability_digest: string;
  purposes: string[];
  consent_ref: string | null;
  withdrawn: boolean;
  created_at: Date;
}

export const DOCUMENT_SELECT = `SELECT d.*, b.sha256, b.object_key,
    EXISTS (SELECT 1 FROM evidence_document_events e WHERE e.tenant_id = d.tenant_id AND e.document_id = d.id) AS withdrawn
  FROM evidence_documents d JOIN evidence_blobs b ON b.tenant_id = d.tenant_id AND b.id = d.blob_id`;

export const toDocumentRecord = (r: DocumentRow): DocumentRecord => ({
  documentId: r.id,
  blobId: r.blob_id,
  sha256: r.sha256,
  objectKey: r.object_key,
  role: r.role,
  title: r.title,
  documentRevision: r.document_revision,
  applicability: {
    manufacturer: r.manufacturer,
    model: r.model,
    bomRevision: r.bom_revision,
    serial: r.serial,
    assetId: r.asset_id,
  },
  siteId: r.site_id,
  sourceKind: r.source_kind,
  sourceRef: r.source_ref,
  trustLevel: r.trust_level,
  mediaType: r.media_type,
  extractionMethod: r.extraction_method,
  parserVersion: r.parser_version,
  pageCount: r.page_count,
  spanCount: r.span_count,
  activeContentRemoved: r.active_content_removed,
  textWithheld: r.text_withheld,
  supersedesDocumentId: r.supersedes_document_id,
  rederivedFromDocumentId: r.rederived_from_document_id,
  withdrawn: r.withdrawn,
  createdAt: r.created_at.toISOString(),
});

const trustFor = (ctx: TenantContext): EvidenceTrust =>
  ctx.principal.kind === 'HUMAN' ? 'OPERATOR_ATTESTED' : 'PROVIDER_REPORTED';

export interface StoreDocumentInput {
  role: DocumentRole;
  mediaType: string;
  bytes: Uint8Array;
  title: string;
  documentRevision: string;
  applicability: { manufacturer: string; model: string; bomRevision: string | null; serial: string | null; assetId: string | null };
  siteId: SiteId | null;
  sourceKind: DocumentSourceKind;
  sourceRef: string | null;
  trustLevel: EvidenceTrust;
  consentRef: string | null;
  purposes: string[];
  supersedesDocumentId: string | null;
}

const applicabilityDigestOf = (input: Pick<StoreDocumentInput, 'applicability' | 'documentRevision' | 'sourceKind'>) =>
  canonicalDigest('evidence-applicability', 1, {
    ...input.applicability,
    documentRevision: input.documentRevision,
    sourceKind: input.sourceKind,
  });

/**
 * A document lineage is one blob (by content digest) under one role and applicability: every parser derivation of it.
 * Its advisory lock serializes re-derivation with withdrawal and replacement of any derivation of the same bytes. It is
 * a leaf lock (ADR 0006 lock order): taken after every other lock a caller holds (incident, evidence revision, M07
 * excerpt promotion), and nothing else is acquired while it is held. Two lineages are locked in key order.
 */
const lineageKey = (tenantId: string, sha256: string, role: string, applicabilityDigest: string) =>
  `evidence-document-lineage:${tenantId}:${sha256}:${role}:${applicabilityDigest}`;
async function lockLineages(c: Tx, keys: string[]): Promise<void> {
  for (const k of [...new Set(keys)].sort()) await lockKey(c, k);
}

/** Withdraw every derivation of a lineage not yet withdrawn (append-only events). Returns the ids withdrawn now. */
async function withdrawLineageTx(
  c: Tx,
  ctx: TenantContext,
  lineage: { blobId: string; role: string; applicabilityDigest: string },
  reasonCode: string,
): Promise<string[]> {
  const actor = actorOf(ctx);
  const r = await c.query<{ document_id: string }>(
    `INSERT INTO evidence_document_events (tenant_id, id, document_id, event_type, reason_code, actor_kind, actor_id)
     SELECT d.tenant_id, 'dve_' || gen_random_uuid(), d.id, 'WITHDRAWN', $5, $6, $7
       FROM evidence_documents d
      WHERE d.tenant_id = $1 AND d.blob_id = $2 AND d.role = $3 AND d.applicability_digest = $4
        AND NOT EXISTS (SELECT 1 FROM evidence_document_events e WHERE e.tenant_id = d.tenant_id AND e.document_id = d.id)
     ON CONFLICT (tenant_id, document_id) DO NOTHING
     RETURNING document_id`,
    [ctx.tenantId, lineage.blobId, lineage.role, lineage.applicabilityDigest, reasonCode, actor.kind, actor.id],
  );
  return r.rows.map((x) => x.document_id);
}

/**
 * Parse, store and record one document inside the caller's transaction. Authorization is the caller's job. Returns
 * the existing document when identical bytes were already recorded with the same role and applicability.
 */
export async function storeDocumentTx(
  c: Tx,
  ctx: TenantContext,
  store: ObjectStorePort,
  input: StoreDocumentInput,
  parsed: ParsedDocument = parseDocument(input.bytes, input.mediaType),
): Promise<IngestedDocument> {
  const sha256 = sha256DigestOf(input.bytes);
  const objectKey = objectKeyFor(ctx.tenantId, 'evidence', sha256);
  const applicabilityDigest = applicabilityDigestOf(input);
  // Serialize with withdrawal and replacement of any derivation of these bytes (re-entrant if the caller holds it).
  await lockLineages(c, [lineageKey(ctx.tenantId, sha256, input.role, applicabilityDigest)]);
  await store.put(objectKey, input.bytes);
  await c.query(
    `INSERT INTO evidence_blobs (tenant_id, id, object_key, sha256, media_type, size_bytes, trust_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_id, sha256) DO NOTHING`,
    [ctx.tenantId, newId('blob'), objectKey, sha256, input.mediaType, input.bytes.length, input.trustLevel],
  );
  const blob = await c.query<{ id: BlobId }>(`SELECT id FROM evidence_blobs WHERE tenant_id = $1 AND sha256 = $2`, [
    ctx.tenantId,
    sha256,
  ]);
  const blobId = blob.rows[0]!.id;
  const spanFlags = parsed.spans.map((s) => scanUntrustedText(s.text));
  const facts = parsed.spans.flatMap((s) => extractFacts(s.text, parsed.extractionMethod, s.ordinal, parsed.parserVersion));
  const fresh = (documentId: DocumentId, rederivedFrom: DocumentId | null): IngestedDocument => ({
    documentId,
    blobId,
    sha256,
    objectKey,
    mediaType: input.mediaType,
    extractionMethod: parsed.extractionMethod,
    pageCount: parsed.pageCount,
    spanCount: parsed.spans.length,
    factCount: facts.length,
    injectionFlaggedSpanCount: spanFlags.filter((f) => f.length > 0).length,
    activeContentRemoved: parsed.activeContentRemoved,
    textWithheld: parsed.textWithheld,
    parserVersion: parsed.parserVersion,
    rederivedFromDocumentId: rederivedFrom,
    trustLevel: input.trustLevel,
    existing: false,
  });
  // An existing derivation is reported from what was recorded for it, not from this parse.
  const recorded = async (id: DocumentId): Promise<IngestedDocument> => {
    const r = await c.query<{
      media_type: string;
      extraction_method: ParsedDocument['extractionMethod'];
      page_count: number;
      span_count: number;
      active_content_removed: string[];
      text_withheld: WithheldReason[];
      parser_version: string;
      rederived_from_document_id: DocumentId | null;
      trust_level: EvidenceTrust;
      facts: string;
      flagged: string;
    }>(
      `SELECT d.media_type, d.extraction_method, d.page_count, d.span_count, d.active_content_removed, d.text_withheld,
              d.parser_version, d.rederived_from_document_id, d.trust_level,
              (SELECT count(*) FROM evidence_document_facts f WHERE f.tenant_id = d.tenant_id AND f.document_id = d.id) AS facts,
              (SELECT count(*) FROM evidence_document_spans s WHERE s.tenant_id = d.tenant_id AND s.document_id = d.id
                  AND cardinality(s.injection_flags) > 0) AS flagged
         FROM evidence_documents d WHERE d.tenant_id = $1 AND d.id = $2`,
      [ctx.tenantId, id],
    );
    const d = r.rows[0]!;
    return {
      documentId: id,
      blobId,
      sha256,
      objectKey,
      mediaType: d.media_type,
      extractionMethod: d.extraction_method,
      pageCount: d.page_count,
      spanCount: d.span_count,
      factCount: Number(d.facts),
      injectionFlaggedSpanCount: Number(d.flagged),
      activeContentRemoved: d.active_content_removed,
      textWithheld: d.text_withheld,
      parserVersion: d.parser_version,
      rederivedFromDocumentId: d.rederived_from_document_id,
      trustLevel: d.trust_level,
      existing: true,
    };
  };
  // Every derivation of this blob for this role and applicability, newest first.
  const derivations = async () =>
    (
      await c.query<{ id: DocumentId; parser_version: string; withdrawn: boolean }>(
        `SELECT d.id, d.parser_version,
                EXISTS (SELECT 1 FROM evidence_document_events e WHERE e.tenant_id = d.tenant_id AND e.document_id = d.id)
                  AS withdrawn
           FROM evidence_documents d
          WHERE d.tenant_id = $1 AND d.blob_id = $2 AND d.role = $3 AND d.applicability_digest = $4
          ORDER BY d.created_at DESC, d.id DESC`,
        [ctx.tenantId, blobId, input.role, applicabilityDigest],
      )
    ).rows;
  const prior = await derivations();
  const same = prior.find((d) => d.parser_version === parsed.parserVersion);
  if (same) return recorded(same.id);
  // Re-derivation semantics (T-024): an older parser's derivation is reused when this parser extracts exactly the same
  // spans, and is never resurrected when it was withdrawn; otherwise this extraction becomes a new derived document
  // that supersedes it. Recorded spans are never rewritten.
  let rederivedFrom: DocumentId | null = null;
  const latest = prior[0];
  if (latest) {
    if (latest.withdrawn) return recorded(latest.id);
    const spans = await c.query<{ ordinal: number; locator: unknown; text_digest: string }>(
      `SELECT ordinal, locator, text_digest FROM evidence_document_spans WHERE tenant_id = $1 AND document_id = $2
        ORDER BY ordinal`,
      [ctx.tenantId, latest.id],
    );
    const spansUnchanged =
      spans.rows.length === parsed.spans.length &&
      spans.rows.every(
        (r, i) =>
          r.ordinal === parsed.spans[i]!.ordinal &&
          r.text_digest === parsed.spans[i]!.textDigest &&
          canonicalize(r.locator) === canonicalize(parsed.spans[i]!.locator),
      );
    // Facts are part of the derivation (M06 binds claims to them): a fact difference is a new derivation too.
    const factSet = (rows: { ordinal: number; key: string; value: string }[]) =>
      [...new Set(rows.map((f) => JSON.stringify([f.ordinal, f.key, f.value])))].sort();
    const storedFacts = spansUnchanged
      ? await c.query<{ ordinal: number; key: string; value: string }>(
          `SELECT s.ordinal, f.fact_key AS key, f.value
             FROM evidence_document_facts f
             JOIN evidence_document_spans s ON s.tenant_id = f.tenant_id AND s.id = f.span_id
            WHERE f.tenant_id = $1 AND f.document_id = $2`,
          [ctx.tenantId, latest.id],
        )
      : null;
    const factsUnchanged =
      storedFacts !== null &&
      canonicalize(factSet(storedFacts.rows)) ===
        canonicalize(factSet(facts.map((f) => ({ ordinal: f.spanOrdinal, key: f.factKey, value: f.value }))));
    if (spansUnchanged && factsUnchanged) return recorded(latest.id);
    rederivedFrom = latest.id;
  }

  const documentId = newEvidenceId('document') as DocumentId;
  const actor = actorOf(ctx);
  const ins = await c.query(
    `INSERT INTO evidence_documents (tenant_id, id, blob_id, role, title, document_revision, manufacturer, model,
       bom_revision, serial, site_id, asset_id, source_kind, source_ref, trust_level, media_type, extraction_method,
       parser_version, page_count, span_count, active_content_removed, consent_ref, purposes, applicability_digest,
       supersedes_document_id, created_by_kind, created_by_id, text_withheld, rederived_from_document_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
             $24, $25, $26, $27, $28, $29)
     ON CONFLICT (tenant_id, blob_id, role, applicability_digest, parser_version) DO NOTHING`,
    [
      ctx.tenantId,
      documentId,
      blobId,
      input.role,
      input.title,
      input.documentRevision,
      input.applicability.manufacturer,
      input.applicability.model,
      input.applicability.bomRevision,
      input.applicability.serial,
      input.siteId,
      input.applicability.assetId,
      input.sourceKind,
      input.sourceRef,
      input.trustLevel,
      input.mediaType,
      parsed.extractionMethod,
      parsed.parserVersion,
      parsed.pageCount,
      parsed.spans.length,
      parsed.activeContentRemoved,
      input.consentRef,
      input.purposes,
      applicabilityDigest,
      input.supersedesDocumentId,
      actor.kind,
      actor.id,
      parsed.textWithheld,
      rederivedFrom,
    ],
  );
  if (ins.rowCount === 0) {
    const raced = (await derivations()).find((d) => d.parser_version === parsed.parserVersion);
    return recorded(raced!.id);
  }
  // Recheck before activation: under the lineage lock the older derivation is still active; if a path that does not
  // take the lineage lock (consent withdrawal) withdrew it meanwhile, the new derivation must not become active.
  if (rederivedFrom && !(await withdrawTx(c, ctx, rederivedFrom, 'REDERIVED_BY_PARSER')))
    throw versionConflict('DOCUMENT_WITHDRAWN_DURING_REDERIVATION');
  const spanIds: string[] = [];
  for (const [i, s] of parsed.spans.entries()) {
    const spanId = newEvidenceId('span');
    spanIds.push(spanId);
    await c.query(
      `INSERT INTO evidence_document_spans (tenant_id, id, document_id, blob_id, ordinal, locator, text, text_digest,
                                            injection_flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [ctx.tenantId, spanId, documentId, blobId, s.ordinal, JSON.stringify(s.locator), s.text, s.textDigest, spanFlags[i]],
    );
  }
  for (const f of facts)
    await c.query(
      `INSERT INTO evidence_document_facts (tenant_id, id, document_id, span_id, fact_key, value)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [ctx.tenantId, newEvidenceId('fact'), documentId, spanIds[f.spanOrdinal - 1], f.factKey, f.value],
    );
  return fresh(documentId, rederivedFrom);
}

async function loadDocument(c: Tx, ctx: TenantContext, meta: { action: string; resourceType: string }, id: string) {
  if (!/^doc_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(id)) throw unavailable(meta);
  const { rows } = await c.query<DocumentRow>(`${DOCUMENT_SELECT} WHERE d.tenant_id = $1 AND d.id = $2`, [
    ctx.tenantId,
    id,
  ]);
  if (!rows[0]) throw unavailable(meta, id);
  return rows[0];
}

/** Ingest one document for the caller's tenant (bounded, parsed, content-addressed, immutable). */
function parseIngest(raw: IngestDocumentInput) {
  if (raw?.bytes instanceof Uint8Array && raw.bytes.length > DOCUMENT_LIMITS.maxBytes)
    throw rejected('DOCUMENT_TOO_LARGE', 'The document exceeds the size bound.');
  const p = IngestSchema.safeParse(raw);
  if (!p.success) throw rejected('INVALID_DOCUMENT_INPUT');
  const input = p.data;
  if ((input.role === 'TRANSCRIPT') !== (input.sourceKind === 'COMMUNICATION'))
    throw rejected('COMMUNICATION_ROLE_MISMATCH');
  if (input.sourceKind === 'COMMUNICATION' && (!input.communication || !input.applicability.assetId))
    throw rejected('COMMUNICATION_CONSENT_REQUIRED', 'Communication content needs consent, purpose and an asset.');
  // Parse before opening a transaction: hostile bytes never reach storage.
  const parsed = parseDocument(input.bytes, input.mediaType);
  return { input, parsed };
}

const INGEST_META = { action: 'evidence_document.ingest', resourceType: 'evidence_document', resourceId: null };

async function ingestParsedTx(
  c: Tx,
  ctx: TenantContext,
  store: ObjectStorePort,
  { input, parsed }: ReturnType<typeof parseIngest>,
): Promise<IngestedDocument> {
  const meta = INGEST_META;
    let siteId: SiteId | null = null;
    const assetId = input.applicability.assetId ?? null;
    if (assetId) {
      const a = await c.query<{ site_id: SiteId }>(`SELECT site_id FROM assets WHERE tenant_id = $1 AND id = $2`, [
        ctx.tenantId,
        assetId,
      ]);
      if (!a.rows[0]) throw unavailable(meta, assetId, 'asset');
      siteId = a.rows[0].site_id;
    }
    requireEvidenceWrite(ctx, siteId, { type: 'evidence_document', id: null });
    // Declaring a manufacturer publication is a library act: compatibility policy reads OEM_PUBLICATION as
    // manufacturer-sourced, so a site-scoped uploader may not self-declare it, even for an asset at their own site.
    if (input.sourceKind === 'OEM_PUBLICATION' && ctx.principal.kind === 'HUMAN')
      requireAuthorized(ctx, { action: 'evidence.library_write', siteId: null }, undefined, {
        type: 'evidence_document',
        id: null,
      });
    let supersedes: DocumentRow | null = null;
    if (input.supersedesDocumentId) {
      const old = await loadDocument(c, ctx, meta, input.supersedesDocumentId);
      if (old.role !== input.role || old.source_kind === 'REGISTRY_SNAPSHOT')
        throw rejected('SUPERSEDED_DOCUMENT_MISMATCH');
      if ((old.site_id ?? null) !== siteId) throw rejected('SUPERSEDED_DOCUMENT_MISMATCH');
      supersedes = old;
    }
    const applicability = {
      manufacturer: input.applicability.manufacturer,
      model: input.applicability.model,
      bomRevision: input.applicability.bomRevision ?? null,
      serial: input.applicability.serial ?? null,
      assetId,
    };
    // Both lineages (these bytes, and the replaced document's) are locked up front, in key order.
    await lockLineages(c, [
      lineageKey(
        ctx.tenantId,
        sha256DigestOf(input.bytes),
        input.role,
        applicabilityDigestOf({ applicability, documentRevision: input.documentRevision, sourceKind: input.sourceKind }),
      ),
      ...(supersedes
        ? [lineageKey(ctx.tenantId, supersedes.sha256, supersedes.role, supersedes.applicability_digest)]
        : []),
    ]);
    const result = await storeDocumentTx(
      c,
      ctx,
      store,
      {
        role: input.role,
        mediaType: input.mediaType,
        bytes: input.bytes,
        title: input.title,
        documentRevision: input.documentRevision,
        applicability,
        siteId,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef ?? null,
        trustLevel: trustFor(ctx),
        consentRef: input.communication?.consentRef ?? null,
        purposes: input.communication?.purposes ?? [],
        supersedesDocumentId: supersedes?.id ?? null,
      },
      parsed,
    );
    // A replacement withdraws every derivation of the replaced bytes, not only the row named.
    if (supersedes && !result.existing)
      await withdrawLineageTx(
        c,
        ctx,
        { blobId: supersedes.blob_id, role: supersedes.role, applicabilityDigest: supersedes.applicability_digest },
        'SUPERSEDED_BY_REPLACEMENT',
      );
    await recordAudit(c, ctx, {
      action: meta.action,
      resourceType: 'evidence_document',
      resourceId: result.documentId,
      result: 'SUCCEEDED',
      metadata: { existing: result.existing, flaggedSpans: result.injectionFlaggedSpanCount },
    });
    return result;
}

export async function ingestDocument(
  pool: Db,
  ctx: TenantContext,
  store: ObjectStorePort,
  raw: IngestDocumentInput,
): Promise<IngestedDocument> {
  const prepared = parseIngest(raw);
  return tenantCommand(pool, ctx, INGEST_META, (c) => ingestParsedTx(c, ctx, store, prepared));
}

/**
 * Ingest inside the caller's tenant transaction (one connection), for callers that must make the ingest atomic
 * with their own checks and locks (M07 excerpt promotion). Denials propagate to the caller's tenantCommand.
 */
export async function ingestDocumentInTx(
  c: Tx,
  ctx: TenantContext,
  store: ObjectStorePort,
  raw: IngestDocumentInput,
): Promise<IngestedDocument> {
  return ingestParsedTx(c, ctx, store, parseIngest(raw));
}

async function withdrawTx(c: Tx, ctx: TenantContext, documentId: string, reasonCode: string): Promise<boolean> {
  const actor = actorOf(ctx);
  const r = await c.query(
    `INSERT INTO evidence_document_events (tenant_id, id, document_id, event_type, reason_code, actor_kind, actor_id)
     VALUES ($1, $2, $3, 'WITHDRAWN', $4, $5, $6) ON CONFLICT (tenant_id, document_id) DO NOTHING`,
    [ctx.tenantId, newEvidenceId('documentEvent'), documentId, reasonCode, actor.kind, actor.id],
  );
  return r.rowCount === 1;
}

/**
 * System withdrawal of every consented COMMUNICATION document bound to `consentRefs`, inside the caller's
 * transaction (used by M07 when processing consent is withdrawn). It is a consequence of the consent record, not a
 * caller evidence write, so it is attributed to a WORKER system actor and needs no evidence.submit grant. Unbounded
 * by design (one INSERT ... SELECT), idempotent: already-withdrawn documents are skipped. Returns the count withdrawn.
 */
export async function withdrawConsentedCommunicationsInTx(
  c: Tx,
  tenantId: string,
  consentRefs: readonly string[],
  input: { reasonCode: string; systemActorId: string },
): Promise<number> {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(input.reasonCode)) throw rejected('INVALID_REASON_CODE');
  if (consentRefs.length === 0) return 0;
  const r = await c.query(
    `INSERT INTO evidence_document_events (tenant_id, id, document_id, event_type, reason_code, actor_kind, actor_id)
     SELECT d.tenant_id, 'dve_' || gen_random_uuid(), d.id, 'WITHDRAWN', $3, 'WORKER', $4
       FROM evidence_documents d
      WHERE d.tenant_id = $1 AND d.source_kind = 'COMMUNICATION' AND d.consent_ref = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM evidence_document_events e WHERE e.tenant_id = d.tenant_id AND e.document_id = d.id)
     ON CONFLICT (tenant_id, document_id) DO NOTHING`,
    [tenantId, [...consentRefs], input.reasonCode, input.systemActorId.slice(0, 128)],
  );
  return r.rowCount ?? 0;
}

/**
 * Remove a document from every future evidence revision (append-only WITHDRAWN event). Historical revisions keep it.
 * Registry snapshots follow the registry and cannot be withdrawn directly.
 */
export async function withdrawDocument(
  pool: Db,
  ctx: TenantContext,
  documentId: DocumentId | string,
  input: { reasonCode: string },
): Promise<{ documentId: DocumentId; withdrawn: true; alreadyWithdrawn: boolean }> {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(input?.reasonCode ?? '')) throw rejected('INVALID_REASON_CODE');
  const meta = { action: 'evidence_document.withdraw', resourceType: 'evidence_document', resourceId: documentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const d = await loadDocument(c, ctx, meta, documentId);
    requireEvidenceWrite(ctx, d.site_id, { type: 'evidence_document', id: d.id });
    if (d.source_kind === 'OEM_PUBLICATION' && ctx.principal.kind === 'HUMAN')
      requireAuthorized(ctx, { action: 'evidence.library_write', siteId: null }, undefined, {
        type: 'evidence_document',
        id: d.id,
      });
    if (d.source_kind === 'REGISTRY_SNAPSHOT')
      throw new Denial(notPermitted('SNAPSHOT_NOT_WITHDRAWABLE'), {
        ...meta,
        reasonCode: 'SNAPSHOT_NOT_WITHDRAWABLE',
      });
    // Withdrawing a document withdraws every derivation of its bytes, serialized with re-derivation (lineage lock), so
    // no active derivation of withdrawn bytes can remain or appear.
    await lockLineages(c, [lineageKey(ctx.tenantId, d.sha256, d.role, d.applicability_digest)]);
    const withdrawn = await withdrawLineageTx(
      c,
      ctx,
      { blobId: d.blob_id, role: d.role, applicabilityDigest: d.applicability_digest },
      input.reasonCode,
    );
    const fresh = withdrawn.includes(d.id);
    await recordAudit(c, ctx, {
      ...meta,
      result: 'SUCCEEDED',
      metadata: { alreadyWithdrawn: !fresh, derivationsWithdrawn: withdrawn.length },
    });
    return { documentId: d.id, withdrawn: true as const, alreadyWithdrawn: !fresh };
  });
}

export async function getDocument(pool: Db, ctx: TenantContext, documentId: DocumentId | string): Promise<DocumentRecord> {
  const meta = { action: 'evidence_document.read', resourceType: 'evidence_document', resourceId: documentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const d = await loadDocument(c, ctx, meta, documentId);
    if (d.site_id) requireEvidenceRead(ctx, d.site_id, meta, d.id);
    else requireAnyEvidenceRead(ctx, meta, d.id);
    return toDocumentRecord(d);
  });
}
