// Immutable evidence revisions (FR-05, INV-03, INV-10, T-024). A commit gathers exactly the documents that apply to
// the asset's current immutable revision (manufacturer + model, plus BOM revision, serial or asset where a document
// is that specific), snapshots the asset's warranty and the site's approved-vendor registry records as citable
// documents, detects deterministic fact conflicts and, when the content differs from the latest revision, commits a
// new revision with a new manifest digest. In the same transaction every current model proposal of the incident is
// stamped SUPERSEDED and `plan.invalidated.v1` is emitted next to `evidence.revision_committed.v1`.
import type { AssetId, EvidenceRevisionId, IncidentId, SiteId, UtcInstant } from '@uptimebuyer/contracts';
import { canonicalDigest } from '@uptimebuyer/domain';
import {
  appendOutboxEvent,
  commitEvidenceRevisionInTx,
  evidenceManifestDigest,
  lockKey,
  recordAudit,
  tenantCommand,
  unavailable,
  type Db,
  type TenantContext,
  type Tx,
} from '@uptimebuyer/data';
import { newId } from '@uptimebuyer/contracts';
import { policyHold, rejected } from './errors.js';
import { DOCUMENT_SELECT, storeDocumentTx, toDocumentRecord, type DocumentRecord, type DocumentRow } from './documents.js';
import { newEvidenceId, type DocumentId } from './ids.js';
import { RETRIEVAL_LIMITS } from './limits.js';
import type { ObjectStorePort } from './object-store.js';
import { loadIncident, requireEvidenceRead, requireEvidenceWrite, type IncidentRow } from './scope.js';

export interface AssetSnapshot {
  assetId: string;
  assetRevisionId: string;
  revision: number;
  manufacturer: string;
  model: string;
  serial: string | null;
  bomRevision: string;
  safetyClass: string;
  current: boolean;
}

interface AssetRevisionRow {
  id: string;
  asset_id: string;
  revision: number;
  manufacturer: string;
  model: string;
  serial: string | null;
  bom_revision: string;
  safety_class: string;
  superseded_at: Date | null;
}

const toSnapshot = (r: AssetRevisionRow): AssetSnapshot => ({
  assetId: r.asset_id,
  assetRevisionId: r.id,
  revision: r.revision,
  manufacturer: r.manufacturer,
  model: r.model,
  serial: r.serial,
  bomRevision: r.bom_revision,
  safetyClass: r.safety_class,
  current: r.superseded_at === null,
});

export async function loadAssetRevision(c: Tx, tenantId: string, assetRevisionId: string): Promise<AssetSnapshot> {
  const { rows } = await c.query<AssetRevisionRow>(`SELECT * FROM asset_revisions WHERE tenant_id = $1 AND id = $2`, [
    tenantId,
    assetRevisionId,
  ]);
  return toSnapshot(rows[0]!);
}

export interface ConflictSource {
  documentId: string;
  spanId: string;
}
export interface ConflictRecord {
  factKey: string;
  values: { value: string; sources: ConflictSource[] }[];
}

/** Exact fact values across `documentIds`, grouped by key; a key with more than one value is a conflict. */
export async function factsForDocuments(c: Tx, tenantId: string, documentIds: readonly string[]) {
  const { rows } = await c.query<{ fact_key: string; value: string; document_id: string; span_id: string }>(
    `SELECT fact_key, value, document_id, span_id FROM evidence_document_facts
      WHERE tenant_id = $1 AND document_id = ANY($2) ORDER BY fact_key, value, document_id, span_id`,
    [tenantId, documentIds],
  );
  const byKey = new Map<string, Map<string, ConflictSource[]>>();
  for (const r of rows) {
    const values = byKey.get(r.fact_key) ?? new Map<string, ConflictSource[]>();
    byKey.set(r.fact_key, values);
    const list = values.get(r.value) ?? [];
    values.set(r.value, list);
    list.push({ documentId: r.document_id, spanId: r.span_id });
  }
  const facts: ConflictRecord[] = [...byKey.entries()].map(([factKey, values]) => ({
    factKey,
    values: [...values.entries()].map(([value, sources]) => ({ value, sources })),
  }));
  return { facts, conflicts: facts.filter((f) => f.values.length > 1) };
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (header: string[], rows: string[][]) =>
  `${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')}\n`;

/** Registry records cited as evidence: the asset's latest warranty and the site's approved vendors. */
async function registrySnapshots(
  c: Tx,
  ctx: TenantContext,
  store: ObjectStorePort,
  incident: IncidentRow,
  asset: AssetSnapshot,
): Promise<DocumentId[]> {
  const ids: DocumentId[] = [];
  const base = {
    mediaType: 'text/csv',
    applicability: {
      manufacturer: asset.manufacturer,
      model: asset.model,
      bomRevision: null,
      serial: null,
      assetId: incident.asset_id,
    },
    siteId: incident.site_id,
    sourceKind: 'REGISTRY_SNAPSHOT' as const,
    sourceRef: null,
    trustLevel: 'OPERATOR_ATTESTED' as const,
    consentRef: null,
    purposes: [],
    supersedesDocumentId: null,
  };
  const w = await c.query<{ revision: number; body: Record<string, unknown> }>(
    `SELECT revision, body FROM registry_revisions WHERE tenant_id = $1 AND entity_kind = 'WARRANTY' AND entity_id = $2
      ORDER BY revision DESC LIMIT 1`,
    [ctx.tenantId, incident.asset_id],
  );
  if (w.rows[0]) {
    const b = w.rows[0].body as { provider: string; expiresOn: string; termsBlobId: string | null };
    const bytes = Buffer.from(
      csv(
        ['record', 'asset_id', 'provider', 'expires_on', 'terms_blob_id', 'registry_revision'],
        [[`warranty-r${w.rows[0].revision}`, incident.asset_id, b.provider, b.expiresOn, b.termsBlobId ?? '', String(w.rows[0].revision)]],
      ),
    );
    const d = await storeDocumentTx(c, ctx, store, {
      ...base,
      role: 'WARRANTY',
      bytes,
      title: 'Registry warranty record',
      documentRevision: `registry-r${w.rows[0].revision}`,
    });
    ids.push(d.documentId);
  }
  const v = await c.query<{ entity_id: string; revision: number; body: Record<string, unknown> }>(
    `SELECT DISTINCT ON (entity_id) entity_id, revision, body FROM registry_revisions
      WHERE tenant_id = $1 AND entity_kind = 'APPROVED_VENDOR' ORDER BY entity_id, revision DESC`,
    [ctx.tenantId],
  );
  const vendors = v.rows
    .map((r) => ({ id: r.entity_id, revision: r.revision, body: r.body as { vendorName: string; status: string; siteIds: string[] } }))
    .filter((r) => r.body.siteIds.length === 0 || r.body.siteIds.includes(incident.site_id))
    .slice(0, 500);
  if (vendors.length) {
    const rows = vendors.map((r) => [r.id, r.body.vendorName, r.body.status, String(r.revision)]);
    const bytes = Buffer.from(csv(['vendor_id', 'vendor_name', 'status', 'registry_revision'], rows));
    const label = canonicalDigest('vendor-snapshot', 1, { rows }).slice(-12);
    const d = await storeDocumentTx(c, ctx, store, {
      ...base,
      role: 'VENDOR_RECORD',
      bytes,
      title: 'Registry approved-vendor records',
      documentRevision: `registry-${label}`,
    });
    ids.push(d.documentId);
  }
  return ids;
}

export interface EvidenceCommitResult {
  changed: boolean;
  evidenceRevisionId: EvidenceRevisionId;
  revision: number;
  previousRevisionId: EvidenceRevisionId | null;
  manifestSha256: string;
  contentDigest: string;
  assetRevisionId: string;
  documentIds: string[];
  conflictCount: number;
  supersededProposalIds: string[];
}

const contentDigestOf = (incidentId: string, assetRevisionId: string, docs: { id: string; sha256: string; role: string }[]) =>
  canonicalDigest('evidence-content', 1, {
    incidentId,
    assetRevisionId,
    documents: [...docs]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((d) => ({ documentId: d.id, sha256: d.sha256, role: d.role })),
  });

/** Commit the incident's next evidence revision when its applicable content changed; otherwise return the latest. */
export async function commitIncidentEvidence(
  pool: Db,
  ctx: TenantContext,
  store: ObjectStorePort,
  input: { incidentId: IncidentId | string; reasonCode: string },
): Promise<EvidenceCommitResult> {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(input?.reasonCode ?? '')) throw rejected('INVALID_REASON_CODE');
  const meta = { action: 'evidence_revision.commit', resourceType: 'incident', resourceId: input.incidentId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const incident = await loadIncident(c, ctx, meta, input.incidentId);
    requireEvidenceWrite(ctx, incident.site_id, { type: 'incident', id: incident.id });
    // Same advisory key as the data-layer commit (re-entrant): content, comparison and commit are one critical section.
    await lockKey(c, `evidence-revision:${ctx.tenantId}:${incident.id}`);
    // FOR SHARE serializes with reviseAssetIdentity (FOR UPDATE on the asset row).
    const cur = await c.query<{ current_revision_id: string }>(
      `SELECT current_revision_id FROM assets WHERE tenant_id = $1 AND id = $2 FOR SHARE`,
      [ctx.tenantId, incident.asset_id],
    );
    const asset = await loadAssetRevision(c, ctx.tenantId, cur.rows[0]!.current_revision_id);
    const snapshots = await registrySnapshots(c, ctx, store, incident, asset);
    const docs = await c.query<DocumentRow>(
      `${DOCUMENT_SELECT}
        WHERE d.tenant_id = $1 AND d.manufacturer = $2 AND d.model = $3
          AND (d.bom_revision IS NULL OR d.bom_revision = $4)
          AND (d.serial IS NULL OR d.serial = $5)
          AND (d.asset_id IS NULL OR d.asset_id = $6)
          AND (d.source_kind <> 'REGISTRY_SNAPSHOT' OR d.id = ANY($7))
          AND NOT EXISTS (SELECT 1 FROM evidence_document_events e WHERE e.tenant_id = d.tenant_id AND e.document_id = d.id)
        ORDER BY d.created_at, d.id
        LIMIT $8`,
      [
        ctx.tenantId,
        asset.manufacturer,
        asset.model,
        asset.bomRevision,
        asset.serial,
        incident.asset_id,
        snapshots,
        RETRIEVAL_LIMITS.maxDocumentsPerRevision + 1,
      ],
    );
    if (docs.rows.length > RETRIEVAL_LIMITS.maxDocumentsPerRevision) throw policyHold('TOO_MANY_DOCUMENTS');
    const contentDigest = contentDigestOf(incident.id, asset.assetRevisionId, docs.rows);
    const latest = await c.query<{
      id: EvidenceRevisionId;
      revision: number;
      asset_revision_id: string;
      manifest_sha256: string;
      content_digest: string | null;
    }>(
      `SELECT r.id, r.revision, r.asset_revision_id, r.manifest_sha256, c.content_digest
         FROM evidence_revisions r LEFT JOIN evidence_revision_contents c ON c.tenant_id = r.tenant_id AND c.id = r.id
        WHERE r.tenant_id = $1 AND r.incident_id = $2 ORDER BY r.revision DESC LIMIT 1`,
      [ctx.tenantId, incident.id],
    );
    const prev = latest.rows[0];
    const documentIds = docs.rows.map((d) => d.id);
    const { conflicts } = await factsForDocuments(c, ctx.tenantId, documentIds);
    if (prev && prev.content_digest === contentDigest && prev.asset_revision_id === asset.assetRevisionId)
      return {
        changed: false,
        evidenceRevisionId: prev.id,
        revision: prev.revision,
        previousRevisionId: null,
        manifestSha256: prev.manifest_sha256,
        contentDigest,
        assetRevisionId: asset.assetRevisionId,
        documentIds,
        conflictCount: conflicts.length,
        supersededProposalIds: [],
      };

    const seen = new Set<string>();
    const items = docs.rows
      .filter((d) => {
        const k = `${d.blob_id}:${d.role}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((d) => ({ blobId: d.blob_id, role: d.role, locator: null, sourceAt: d.created_at.toISOString() as UtcInstant }));
    const committed = await commitEvidenceRevisionInTx(
      c,
      ctx,
      { incidentId: incident.id, assetRevisionId: asset.assetRevisionId as never, items },
      { siteId: incident.site_id },
    );
    const evr = committed.evidenceRevisionId;
    await c.query(
      `INSERT INTO evidence_revision_contents (tenant_id, id, incident_id, content_digest, reason_code, document_count,
                                               conflict_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.tenantId, evr, incident.id, contentDigest, input.reasonCode, documentIds.length, conflicts.length],
    );
    for (const [i, id] of documentIds.entries())
      await c.query(
        `INSERT INTO evidence_revision_documents (tenant_id, id, evidence_revision_id, document_id, ordinal)
         VALUES ($1, $2, $3, $4, $5)`,
        [ctx.tenantId, newEvidenceId('revisionDocument'), evr, id, i + 1],
      );
    for (const conflict of conflicts)
      await c.query(
        `INSERT INTO evidence_revision_conflicts (tenant_id, id, evidence_revision_id, fact_key, sources)
         VALUES ($1, $2, $3, $4, $5)`,
        [ctx.tenantId, newEvidenceId('conflict'), evr, conflict.factKey, JSON.stringify(conflict.values)],
      );
    const superseded = await c.query<{ id: string }>(
      `UPDATE reasoning_proposals SET superseded_at = clock_timestamp(), superseded_by_evidence_revision_id = $3
        WHERE tenant_id = $1 AND incident_id = $2 AND superseded_at IS NULL RETURNING id`,
      [ctx.tenantId, incident.id, evr],
    );
    const supersededProposalIds = superseded.rows.map((r) => r.id).sort();
    if (prev) {
      const v = await c.query<{ next: number }>(
        `SELECT coalesce(max(aggregate_version), 0) + 1 AS next FROM outbox_events
          WHERE tenant_id = $1 AND aggregate_type = 'plan' AND aggregate_id = $2 AND event_type = 'plan.invalidated.v1'`,
        [ctx.tenantId, incident.id],
      );
      await appendOutboxEvent(c, ctx, {
        eventType: 'plan.invalidated.v1',
        aggregateType: 'plan',
        aggregateId: incident.id,
        aggregateVersion: v.rows[0]!.next,
        payload: {
          incidentId: incident.id,
          reasonCode: prev.asset_revision_id === asset.assetRevisionId ? 'EVIDENCE_REVISION_CHANGED' : 'ASSET_REVISION_CHANGED',
          commitReasonCode: input.reasonCode,
          supersededEvidenceRevisionId: prev.id,
          evidenceRevisionId: evr,
          supersededAssetRevisionId: prev.asset_revision_id,
          assetRevisionId: asset.assetRevisionId,
          supersededProposalIds,
        },
        correlationId: ctx.correlationId,
        causationId: newId('command'),
      });
    }
    await recordAudit(c, ctx, {
      action: meta.action,
      resourceType: 'evidence_revision',
      resourceId: evr,
      result: 'SUCCEEDED',
      metadata: { revision: committed.revision, supersededProposals: supersededProposalIds.length },
    });
    return {
      changed: true,
      evidenceRevisionId: evr,
      revision: committed.revision,
      previousRevisionId: committed.previousRevisionId,
      manifestSha256: committed.manifestSha256,
      contentDigest,
      assetRevisionId: asset.assetRevisionId,
      documentIds,
      conflictCount: conflicts.length,
      supersededProposalIds,
    };
  });
}

/**
 * Re-commit evidence for every non-recovered incident of an asset (e.g. after its identity revision changed). The asset
 * is resolved in the caller's tenant and the caller must hold evidence write authority at its site first.
 */
export async function refreshEvidenceForAsset(
  pool: Db,
  ctx: TenantContext,
  store: ObjectStorePort,
  assetId: AssetId | string,
  input: { reasonCode: string },
): Promise<EvidenceCommitResult[]> {
  const meta = { action: 'evidence_revision.refresh', resourceType: 'asset', resourceId: assetId };
  const incidents = await tenantCommand(pool, ctx, meta, async (c) => {
    if (!/^ast_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(String(assetId))) throw unavailable(meta);
    const a = await c.query<{ site_id: SiteId }>(`SELECT site_id FROM assets WHERE tenant_id = $1 AND id = $2`, [
      ctx.tenantId,
      assetId,
    ]);
    if (!a.rows[0]) throw unavailable(meta);
    requireEvidenceWrite(ctx, a.rows[0].site_id, { type: 'asset', id: String(assetId) });
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM incidents WHERE tenant_id = $1 AND asset_id = $2 AND state <> 'RECOVERED'
        ORDER BY opened_at, id LIMIT 100`,
      [ctx.tenantId, assetId],
    );
    return rows.map((r) => r.id);
  });
  const out: EvidenceCommitResult[] = [];
  for (const id of incidents)
    out.push(await commitIncidentEvidence(pool, ctx, store, { incidentId: id, reasonCode: input.reasonCode }));
  return out;
}

export interface EvidenceRevisionView {
  evidenceRevisionId: EvidenceRevisionId;
  incidentId: string;
  siteId: SiteId;
  revision: number;
  previousRevisionId: string | null;
  assetRevisionId: string;
  manifestSha256: string;
  contentDigest: string | null;
  reasonCode: string | null;
  current: boolean;
  createdAt: string;
  items: { ordinal: number; blobId: string; role: string; sourceAt: string }[];
  documents: DocumentRecord[];
  conflicts: ConflictRecord[];
  verification: { manifestDigestMatches: boolean; contentDigestMatches: boolean };
}

export interface RevisionRow {
  id: EvidenceRevisionId;
  incident_id: string;
  site_id: SiteId;
  asset_id: string;
  revision: number;
  previous_revision_id: string | null;
  asset_revision_id: string;
  manifest_sha256: string;
  created_at: Date;
  content_digest: string | null;
  reason_code: string | null;
  latest: number;
}

export async function loadRevision(
  c: Tx,
  ctx: TenantContext,
  meta: { action: string; resourceType: string },
  evidenceRevisionId: string,
): Promise<RevisionRow> {
  if (!/^evr_[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(evidenceRevisionId ?? '')) throw unavailable(meta);
  const { rows } = await c.query<RevisionRow>(
    `SELECT r.*, i.site_id, i.asset_id, c.content_digest, c.reason_code,
            (SELECT max(revision) FROM evidence_revisions x WHERE x.tenant_id = r.tenant_id AND x.incident_id = r.incident_id) AS latest
       FROM evidence_revisions r
       JOIN incidents i ON i.tenant_id = r.tenant_id AND i.id = r.incident_id
       LEFT JOIN evidence_revision_contents c ON c.tenant_id = r.tenant_id AND c.id = r.id
      WHERE r.tenant_id = $1 AND r.id = $2`,
    [ctx.tenantId, evidenceRevisionId],
  );
  if (!rows[0]) throw unavailable(meta, evidenceRevisionId);
  requireEvidenceRead(ctx, rows[0].site_id, meta, evidenceRevisionId);
  return rows[0];
}

export async function revisionDocuments(c: Tx, tenantId: string, evidenceRevisionId: string): Promise<DocumentRow[]> {
  const { rows } = await c.query<DocumentRow>(
    `${DOCUMENT_SELECT}
       JOIN evidence_revision_documents rd ON rd.tenant_id = d.tenant_id AND rd.document_id = d.id
      WHERE d.tenant_id = $1 AND rd.evidence_revision_id = $2 ORDER BY rd.ordinal`,
    [tenantId, evidenceRevisionId],
  );
  return rows;
}

/** One immutable evidence revision with its documents, conflicts and a recomputed digest check. */
export async function getEvidenceRevision(
  pool: Db,
  ctx: TenantContext,
  evidenceRevisionId: EvidenceRevisionId | string,
): Promise<EvidenceRevisionView> {
  const meta = { action: 'evidence_revision.read', resourceType: 'evidence_revision', resourceId: evidenceRevisionId };
  return tenantCommand(pool, ctx, meta, async (c) => {
    const r = await loadRevision(c, ctx, meta, evidenceRevisionId);
    const items = await c.query<{ ordinal: number; blob_id: string; role: string; locator: unknown; source_at: Date }>(
      `SELECT ordinal, blob_id, role, locator, source_at FROM evidence_revision_items
        WHERE tenant_id = $1 AND revision_id = $2 ORDER BY ordinal`,
      [ctx.tenantId, r.id],
    );
    const docs = await revisionDocuments(c, ctx.tenantId, r.id);
    const conflicts = await c.query<{ fact_key: string; sources: ConflictRecord['values'] }>(
      `SELECT fact_key, sources FROM evidence_revision_conflicts WHERE tenant_id = $1 AND evidence_revision_id = $2
        ORDER BY fact_key`,
      [ctx.tenantId, r.id],
    );
    const manifest = evidenceManifestDigest({
      tenantId: ctx.tenantId,
      evidenceRevisionId: r.id,
      incidentId: r.incident_id,
      assetRevisionId: r.asset_revision_id,
      revision: r.revision,
      previousRevisionId: r.previous_revision_id,
      items: items.rows.map((it) => ({
        ordinal: it.ordinal,
        blobId: it.blob_id,
        role: it.role,
        locator: it.locator,
        sourceAt: it.source_at.toISOString(),
      })),
    });
    const content = contentDigestOf(r.incident_id, r.asset_revision_id, docs);
    return {
      evidenceRevisionId: r.id,
      incidentId: r.incident_id,
      siteId: r.site_id,
      revision: r.revision,
      previousRevisionId: r.previous_revision_id,
      assetRevisionId: r.asset_revision_id,
      manifestSha256: r.manifest_sha256,
      contentDigest: r.content_digest,
      reasonCode: r.reason_code,
      current: r.revision === Number(r.latest),
      createdAt: r.created_at.toISOString(),
      items: items.rows.map((it) => ({
        ordinal: it.ordinal,
        blobId: it.blob_id,
        role: it.role,
        sourceAt: it.source_at.toISOString(),
      })),
      documents: docs.map(toDocumentRecord),
      conflicts: conflicts.rows.map((x) => ({ factKey: x.fact_key, values: x.sources })),
      verification: {
        manifestDigestMatches: manifest === r.manifest_sha256,
        contentDigestMatches: r.content_digest !== null && content === r.content_digest,
      },
    };
  });
}
