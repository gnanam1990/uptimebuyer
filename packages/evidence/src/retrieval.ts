// Revision-scoped retrieval with re-openable citations (FR-05, T-021, T-022). Every result is bound to one evidence
// revision of one tenant: search, facts and conflicts only read documents recorded in that revision. Citations are
// issued once per (revision, span) and name the blob digest, locator and quoted-text digest; re-opening reads the
// immutable object, verifies its digest, re-parses it and verifies the span. Fact views carry `authority: 'NONE'`;
// a conflict keeps every value and source, so retrieval can never yield an authoritative exact-match claim.
import {
  CitationSchema,
  decodeWire,
  newId,
  DomainError,
  type Citation,
  type CitationLocator,
  type EvidenceRevisionId,
} from '@uptimebuyer/contracts';
import { canonicalize } from '@uptimebuyer/domain';
import { tenantCommand, unavailable, type Db, type TenantContext, type Tx } from '@uptimebuyer/data';
import { rejected } from './errors.js';
import type { DocumentRole } from './documents.js';
import { DOCUMENT_LIMITS, RETRIEVAL_LIMITS } from './limits.js';
import { type ObjectStorePort } from './object-store.js';
import { parseDocument } from './parse.js';
import {
  factsForDocuments,
  loadAssetRevision,
  loadRevision,
  revisionDocuments,
  type AssetSnapshot,
} from './revisions.js';
import { requireEvidenceRead } from './scope.js';
import { redactContacts, redactSecrets } from './untrusted.js';

export interface SpanRow {
  span_id: string;
  document_id: string;
  blob_id: string;
  ordinal: number;
  locator: CitationLocator;
  text: string;
  text_digest: string;
  injection_flags: string[];
  role: DocumentRole;
  title: string;
  document_revision: string;
  trust_level: string;
  extraction_method: Citation['extractionMethod'];
  sha256: string;
  score?: number;
}

const SPAN_SELECT = `SELECT s.id AS span_id, s.document_id, s.blob_id, s.ordinal, s.locator, s.text, s.text_digest,
    s.injection_flags, d.role, d.title, d.document_revision, d.trust_level, d.extraction_method, b.sha256
  FROM evidence_document_spans s
  JOIN evidence_documents d ON d.tenant_id = s.tenant_id AND d.id = s.document_id
  JOIN evidence_blobs b ON b.tenant_id = d.tenant_id AND b.id = d.blob_id`;

/** Issue (or return) the citation for each span inside `evidenceRevisionId`. The span's document must belong to it. */
export async function issueCitations(
  c: Tx,
  ctx: TenantContext,
  evidenceRevisionId: string,
  spans: readonly SpanRow[],
): Promise<Map<string, Citation>> {
  const out = new Map<string, Citation>();
  for (const s of spans) {
    if (out.has(s.span_id)) continue;
    await c.query(
      `INSERT INTO citations (tenant_id, id, evidence_revision_id, document_id, span_id, blob_id, locator, quoted_digest,
                              extraction_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (tenant_id, evidence_revision_id, span_id) DO NOTHING`,
      [
        ctx.tenantId,
        newId('citation'),
        evidenceRevisionId,
        s.document_id,
        s.span_id,
        s.blob_id,
        JSON.stringify(s.locator),
        s.text_digest,
        s.extraction_method,
      ],
    );
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM citations WHERE tenant_id = $1 AND evidence_revision_id = $2 AND span_id = $3`,
      [ctx.tenantId, evidenceRevisionId, s.span_id],
    );
    out.set(
      s.span_id,
      decodeWire(CitationSchema, {
        citationId: rows[0]!.id,
        tenantId: ctx.tenantId,
        evidenceRevisionId,
        blobId: s.blob_id,
        sourceDigest: s.sha256,
        locator: s.locator,
        quotedDigest: s.text_digest,
        extractionMethod: s.extraction_method,
      }),
    );
  }
  return out;
}

export async function spansById(c: Tx, tenantId: string, spanIds: readonly string[]): Promise<SpanRow[]> {
  if (spanIds.length === 0) return [];
  const { rows } = await c.query<SpanRow>(`${SPAN_SELECT} WHERE s.tenant_id = $1 AND s.id = ANY($2) ORDER BY s.id`, [
    tenantId,
    spanIds,
  ]);
  return rows;
}

/** Lower-case alphanumeric terms only; nothing from the query reaches SQL except bound, sanitized tokens. */
export function queryTerms(query: string): string[] {
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length <= 40))];
  return terms.slice(0, RETRIEVAL_LIMITS.maxQueryTerms);
}

export async function searchSpans(
  c: Tx,
  tenantId: string,
  evidenceRevisionId: string,
  query: string,
  roles: readonly string[] | null,
  limit: number,
): Promise<SpanRow[]> {
  const terms = queryTerms(query.slice(0, RETRIEVAL_LIMITS.maxQueryChars));
  if (terms.length === 0) return [];
  const { rows } = await c.query<SpanRow>(
    `${SPAN_SELECT.replace('SELECT s.id', 'SELECT ts_rank(s.search_vector, q) AS score, s.id')}
       JOIN evidence_revision_documents rd ON rd.tenant_id = d.tenant_id AND rd.document_id = d.id
       CROSS JOIN to_tsquery('simple', $3) q
      WHERE s.tenant_id = $1 AND rd.evidence_revision_id = $2 AND s.search_vector @@ q
        AND ($4::text[] IS NULL OR d.role = ANY($4))
      ORDER BY score DESC, d.id, s.ordinal
      LIMIT $5`,
    [tenantId, evidenceRevisionId, terms.join(' | '), roles, limit],
  );
  return rows;
}

/** Display text for a span: communication excerpts are always contact- and secret-redacted. */
const displayText = (s: SpanRow) =>
  s.role === 'TRANSCRIPT' ? redactSecrets(redactContacts(s.text).text).text : s.text;

export interface SearchHit {
  citation: Citation;
  documentId: string;
  role: DocumentRole;
  title: string;
  documentRevision: string;
  trustLevel: string;
  locator: CitationLocator;
  excerpt: string;
  injectionFlags: string[];
  score: number;
}

export async function searchEvidence(
  pool: Db,
  ctx: TenantContext,
  input: { evidenceRevisionId: EvidenceRevisionId | string; query: string; roles?: DocumentRole[]; limit?: number },
): Promise<SearchHit[]> {
  if (typeof input?.query !== 'string' || input.query.length === 0 || input.query.length > RETRIEVAL_LIMITS.maxQueryChars)
    throw rejected('INVALID_QUERY');
  const limit = Math.max(1, Math.min(input.limit ?? 8, RETRIEVAL_LIMITS.maxSearchResults));
  const meta = { action: 'evidence.search', resourceType: 'evidence_revision', resourceId: input.evidenceRevisionId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const r = await loadRevision(c, ctx, meta, input.evidenceRevisionId);
    const spans = await searchSpans(c, ctx.tenantId, r.id, input.query, input.roles ?? null, limit);
    const cites = await issueCitations(c, ctx, r.id, spans);
    return spans.map((s) => ({
      citation: cites.get(s.span_id)!,
      documentId: s.document_id,
      role: s.role,
      title: s.title,
      documentRevision: s.document_revision,
      trustLevel: s.trust_level,
      locator: s.locator,
      excerpt: displayText(s),
      injectionFlags: s.injection_flags,
      score: Number(s.score ?? 0),
    }));
  });
}

export interface FactSourceView {
  documentId: string;
  role: DocumentRole;
  title: string;
  documentRevision: string;
  trustLevel: string;
  citation: Citation;
}

export interface FactView {
  factKey: string;
  /** SINGLE_SOURCE: one document; CORROBORATED: several documents agree; CONFLICT: documents disagree. */
  status: 'SINGLE_SOURCE' | 'CORROBORATED' | 'CONFLICT';
  /** Retrieval never decides: compatibility and exact-match authority belong to deterministic policy (M06). */
  authority: 'NONE';
  values: { value: string; sources: FactSourceView[] }[];
}

export interface EvidenceRetrieval {
  evidenceRevisionId: EvidenceRevisionId;
  revision: number;
  incidentId: string;
  current: boolean;
  assetRevision: AssetSnapshot;
  documents: {
    documentId: string;
    role: DocumentRole;
    title: string;
    documentRevision: string;
    trustLevel: string;
    sourceDigest: string;
    sourceKind: string;
    mediaType: string;
  }[];
  facts: FactView[];
  conflicts: { factKey: string; values: FactView['values'] }[];
}

/** Facts, conflicts and documents of one revision, each fact source carrying its issued citation. */
export async function buildRetrieval(c: Tx, ctx: TenantContext, r: { id: string; revision: number; incident_id: string; asset_revision_id: string; latest: number }) {
  const docs = await revisionDocuments(c, ctx.tenantId, r.id);
  const { facts } = await factsForDocuments(
    c,
    ctx.tenantId,
    docs.map((d) => d.id),
  );
  const spanIds = [...new Set(facts.flatMap((f) => f.values.flatMap((v) => v.sources.map((s) => s.spanId))))];
  const spans = await spansById(c, ctx.tenantId, spanIds);
  const spanMap = new Map(spans.map((s) => [s.span_id, s]));
  const cites = await issueCitations(c, ctx, r.id, spans);
  const factViews: FactView[] = facts.map((f) => {
    const docCount = new Set(f.values.flatMap((v) => v.sources.map((s) => s.documentId))).size;
    return {
      factKey: f.factKey,
      status: f.values.length > 1 ? 'CONFLICT' : docCount > 1 ? 'CORROBORATED' : 'SINGLE_SOURCE',
      authority: 'NONE',
      values: f.values.map((v) => ({
        value: v.value,
        sources: v.sources.map((s) => {
          const span = spanMap.get(s.spanId)!;
          return {
            documentId: s.documentId,
            role: span.role,
            title: span.title,
            documentRevision: span.document_revision,
            trustLevel: span.trust_level,
            citation: cites.get(s.spanId)!,
          };
        }),
      })),
    };
  });
  return {
    evidenceRevisionId: r.id as EvidenceRevisionId,
    revision: r.revision,
    incidentId: r.incident_id,
    current: r.revision === Number(r.latest),
    assetRevision: await loadAssetRevision(c, ctx.tenantId, r.asset_revision_id),
    documents: docs.map((d) => ({
      documentId: d.id,
      role: d.role,
      title: d.title,
      documentRevision: d.document_revision,
      trustLevel: d.trust_level,
      sourceDigest: d.sha256,
      sourceKind: d.source_kind,
      mediaType: d.media_type,
    })),
    facts: factViews,
    conflicts: factViews.filter((f) => f.status === 'CONFLICT').map((f) => ({ factKey: f.factKey, values: f.values })),
    spans: spanMap,
    citations: cites,
  };
}

export async function retrieveEvidence(
  pool: Db,
  ctx: TenantContext,
  input: { evidenceRevisionId: EvidenceRevisionId | string },
): Promise<EvidenceRetrieval> {
  const meta = { action: 'evidence.retrieve', resourceType: 'evidence_revision', resourceId: input.evidenceRevisionId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const r = await loadRevision(c, ctx, meta, input.evidenceRevisionId);
    const { spans: _spans, citations: _citations, ...view } = await buildRetrieval(c, ctx, r);
    return view;
  });
}

export interface ReopenedCitation {
  citation: Citation;
  text: string;
  verified: true;
  documentId: string;
  role: DocumentRole;
  title: string;
  documentRevision: string;
  mediaType: string;
  trustLevel: string;
}

/** Re-open cited text from the immutable object: digest, re-parse (recorded parser version) and span digest must all match. */
export async function reopenCitation(
  pool: Db,
  ctx: TenantContext,
  store: ObjectStorePort,
  citationId: string,
): Promise<ReopenedCitation> {
  const meta = { action: 'evidence.citation_reopen', resourceType: 'citation', resourceId: citationId };
  const row = await tenantCommand(pool, ctx, meta, async (c) => {
    if (!/^cit_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(citationId ?? '')) throw unavailable(meta);
    const { rows } = await c.query<
      SpanRow & { citation_id: string; evidence_revision_id: string; quoted_digest: string; object_key: string; media_type: string; parser_version: string; site_id: string; cited_locator: CitationLocator }
    >(
      `SELECT ct.id AS citation_id, ct.evidence_revision_id, ct.quoted_digest, ct.locator AS cited_locator,
              s.id AS span_id, s.document_id, s.blob_id, s.ordinal, s.locator, s.text, s.text_digest, s.injection_flags,
              d.role, d.title, d.document_revision, d.trust_level, d.extraction_method, d.media_type, d.parser_version,
              b.sha256, b.object_key, i.site_id
         FROM citations ct
         JOIN evidence_document_spans s ON s.tenant_id = ct.tenant_id AND s.id = ct.span_id
         JOIN evidence_documents d ON d.tenant_id = s.tenant_id AND d.id = s.document_id
         JOIN evidence_blobs b ON b.tenant_id = d.tenant_id AND b.id = d.blob_id
         JOIN evidence_revisions r ON r.tenant_id = ct.tenant_id AND r.id = ct.evidence_revision_id
         JOIN incidents i ON i.tenant_id = r.tenant_id AND i.id = r.incident_id
        WHERE ct.tenant_id = $1 AND ct.id = $2`,
      [ctx.tenantId, citationId],
    );
    if (!rows[0]) throw unavailable(meta, citationId);
    requireEvidenceRead(ctx, rows[0].site_id as never, meta, citationId);
    return rows[0];
  });
  const bytes = await store.get(row.object_key);
  // Re-derive with the parser version that produced the cited span (a parser upgrade never invalidates a citation).
  const parsed = parseDocument(bytes, row.media_type, DOCUMENT_LIMITS, { parserVersion: row.parser_version });
  const span = parsed.spans.find((s) => s.ordinal === row.ordinal);
  if (
    !span ||
    span.textDigest !== row.quoted_digest ||
    canonicalize(span.locator) !== canonicalize(row.cited_locator)
  )
    throw new DomainError('DIGEST_MISMATCH', 'Cited text could not be re-derived from its source.', {
      reasonCode: 'CITATION_REPARSE_MISMATCH',
    });
  return {
    citation: decodeWire(CitationSchema, {
      citationId: row.citation_id,
      tenantId: ctx.tenantId,
      evidenceRevisionId: row.evidence_revision_id,
      blobId: row.blob_id,
      sourceDigest: row.sha256,
      locator: row.cited_locator,
      quotedDigest: row.quoted_digest,
      extractionMethod: row.extraction_method,
    }),
    text: row.role === 'TRANSCRIPT' ? redactSecrets(redactContacts(span.text).text).text : span.text,
    verified: true,
    documentId: row.document_id,
    role: row.role,
    title: row.title,
    documentRevision: row.document_revision,
    mediaType: row.media_type,
    trustLevel: row.trust_level,
  };
}
