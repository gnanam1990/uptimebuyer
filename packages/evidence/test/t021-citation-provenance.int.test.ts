// T-021 — Manual and BOM citation provenance (FR-05, INV-03, INV-10). Retrieval from a versioned manual and parts list
// returns exact page/record citations, asset binding, content hash and source; the cited text re-opens from the
// immutable object and verifies against the recorded digest. Only documents for the exact asset revision apply.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CitationSchema } from '@uptimebuyer/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commitIncidentEvidence,
  getEvidenceRevision,
  reopenCitation,
  retrieveEvidence,
  searchEvidence,
} from '../src/index.js';
import {
  BOM_7,
  MANUAL_C,
  WORK_ORDERS,
  createEvidenceWorld,
  fixture,
  ingestAs,
  openIncident,
  rejection,
  seedRegistryRecords,
  sha256Of,
  type EvidenceWorld,
} from './helpers.js';

let w: EvidenceWorld;

describe('T-021 manual and BOM citation provenance', () => {
  beforeAll(async () => {
    w = await createEvidenceWorld('t021');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('ingests a versioned PDF manual with content hash, source, trust and page spans in a content-addressed store', async () => {
    const bytes = fixture('nwr-sm-48-rev-c.pdf');
    const doc = await ingestAs(w, w.librarian, MANUAL_C());
    expect(doc).toMatchObject({
      sha256: sha256Of(bytes),
      mediaType: 'application/pdf',
      extractionMethod: 'PDF_TEXT',
      pageCount: 4,
      spanCount: 4,
      trustLevel: 'OPERATOR_ATTESTED',
      existing: false,
      objectKey: `tenants/${w.tenant.tenantId}/evidence/${sha256Of(bytes).slice(7)}`,
    });
    expect(readFileSync(join(w.storeRoot, doc.objectKey))).toEqual(bytes);
    const again = await ingestAs(w, w.librarian, MANUAL_C());
    expect(again).toMatchObject({ documentId: doc.documentId, existing: true });
  });

  it('commits an evidence revision bound to the exact asset revision and returns page/record citations', async () => {
    await ingestAs(w, w.librarian, BOM_7());
    await ingestAs(w, w.librarian, { ...BOM_7(), bytes: Buffer.from('item,component,oem_part_number\nX,Evaporator fan motor,9Z9-0000\n'), documentRevision: 'BOM-6', applicability: { ...BOM_7().applicability, bomRevision: 'BOM-6' } });
    await ingestAs(w, w.librarian, { ...MANUAL_C(), applicability: { ...MANUAL_C().applicability, model: 'NWR-3D-72' }, bytes: Buffer.from('Other model manual\n'), mediaType: 'text/plain' });
    await ingestAs(w, w.people.operator!, WORK_ORDERS(w.nwr.assetId));
    await seedRegistryRecords(w, w.nwr.assetId);
    const incidentId = await openIncident(w, w.nwr.assetId);

    const committed = await commitIncidentEvidence(w.db.pool, w.people.operator!.ctx, w.store, {
      incidentId,
      reasonCode: 'TRIAGE_EVIDENCE',
    });
    expect(committed).toMatchObject({ changed: true, revision: 1, assetRevisionId: w.nwr.assetRevisionId });
    const rev = await getEvidenceRevision(w.db.pool, w.people.viewer!.ctx, committed.evidenceRevisionId);
    expect(rev.verification).toEqual({ manifestDigestMatches: true, contentDigestMatches: true });
    // Exactly the manual, the BOM-7 parts list, the asset's work orders and the registry snapshots; never BOM-6 or
    // the other model's manual.
    expect(rev.documents.map((d) => [d.role, d.documentRevision]).sort()).toEqual(
      [
        ['MANUAL', 'C'],
        ['PARTS_LIST', 'BOM-7'],
        ['VENDOR_RECORD', expect.stringMatching(/^registry-/)],
        ['WARRANTY', expect.stringMatching(/^registry-/)],
        ['WORK_ORDER', 'export-2025'],
      ].sort(),
    );

    const view = await retrieveEvidence(w.db.pool, w.people.viewer!.ctx, {
      evidenceRevisionId: committed.evidenceRevisionId,
    });
    expect(view.assetRevision).toMatchObject({
      assetRevisionId: w.nwr.assetRevisionId,
      manufacturer: 'Northwind Refrigeration',
      model: 'NWR-2D-48',
      bomRevision: 'BOM-7',
    });
    const fan = view.facts.find((f) => f.factKey === 'part:evaporator-fan-motor')!;
    expect(fan).toMatchObject({ status: 'CORROBORATED', authority: 'NONE' });
    expect(fan.values).toHaveLength(1);
    expect(fan.values[0]!.value).toBe('5A1-0402');
    expect(fan.values[0]!.sources.map((s) => s.role).sort()).toEqual(['MANUAL', 'PARTS_LIST', 'WORK_ORDER']);

    const hits = await searchEvidence(w.db.pool, w.people.viewer!.ctx, {
      evidenceRevisionId: committed.evidenceRevisionId,
      query: 'evaporator fan motor',
      limit: 8,
    });
    const manualHit = hits.find((h) => h.role === 'MANUAL' && h.excerpt.includes('5A1-0402'))!;
    expect(manualHit.citation.locator).toEqual({ kind: 'PAGE', page: 4, pageEnd: null });
    expect(manualHit.citation).toMatchObject({
      tenantId: w.tenant.tenantId,
      evidenceRevisionId: committed.evidenceRevisionId,
      sourceDigest: sha256Of(fixture('nwr-sm-48-rev-c.pdf')),
      extractionMethod: 'PDF_TEXT',
    });
    expect(CitationSchema.safeParse(manualHit.citation).success).toBe(true);
    const bomHit = hits.find((h) => h.role === 'PARTS_LIST')!;
    expect(bomHit.citation.locator).toEqual({ kind: 'RECORD', recordKey: 'BOM7-010' });
    expect(bomHit.citation.extractionMethod).toBe('STRUCTURED_IMPORT');

    // Same span in the same revision always yields the same citation id.
    const again = await searchEvidence(w.db.pool, w.people.viewer!.ctx, {
      evidenceRevisionId: committed.evidenceRevisionId,
      query: 'evaporator fan motor',
      limit: 8,
    });
    expect(again.map((h) => h.citation.citationId)).toEqual(hits.map((h) => h.citation.citationId));

    // Record-level registry citations for warranty and approved vendor.
    const warranty = await searchEvidence(w.db.pool, w.people.viewer!.ctx, {
      evidenceRevisionId: committed.evidenceRevisionId,
      query: 'warranty expires',
      roles: ['WARRANTY'],
    });
    expect(warranty[0]!.citation.locator).toMatchObject({ kind: 'RECORD' });
    expect(warranty[0]!.excerpt).toContain('2027-03-31');
    const vendor = await searchEvidence(w.db.pool, w.people.viewer!.ctx, {
      evidenceRevisionId: committed.evidenceRevisionId,
      query: 'Coldline',
      roles: ['VENDOR_RECORD'],
    });
    expect(vendor[0]!.excerpt).toContain('APPROVED');

    // Cited text re-opens from the immutable object and verifies.
    const opened = await reopenCitation(w.db.pool, w.people.viewer!.ctx, w.store, manualHit.citation.citationId);
    expect(opened.verified).toBe(true);
    expect(opened.text).toContain('Evaporator fan motor .......... 5A1-0402');
    expect(sha256Of(opened.text)).toBe(manualHit.citation.quotedDigest);
    expect(opened).toMatchObject({ role: 'MANUAL', documentRevision: 'C', mediaType: 'application/pdf' });
    const bomOpened = await reopenCitation(w.db.pool, w.people.viewer!.ctx, w.store, bomHit.citation.citationId);
    expect(bomOpened.text).toContain('oem_part_number: 5A1-0402');
  });

  it('fails closed when the stored object no longer matches its digest', async () => {
    const bytes = Buffer.from('work_order,component,part_number_installed\nWO-9,Condenser fan motor,5A1-0315\n');
    const doc = await ingestAs(w, w.people.operator!, { ...WORK_ORDERS(w.nwr.assetId), bytes, documentRevision: 'tamper' });
    const incidentId = await openIncident(w, w.nwr.assetId);
    const c = await commitIncidentEvidence(w.db.pool, w.people.operator!.ctx, w.store, {
      incidentId,
      reasonCode: 'TRIAGE_EVIDENCE',
    });
    const hit = (
      await searchEvidence(w.db.pool, w.people.operator!.ctx, {
        evidenceRevisionId: c.evidenceRevisionId,
        query: 'WO-9 condenser',
      })
    ).find((h) => h.documentId === doc.documentId)!;
    chmodSync(join(w.storeRoot, doc.objectKey), 0o640);
    writeFileSync(join(w.storeRoot, doc.objectKey), 'tampered bytes');
    const r = await rejection(reopenCitation(w.db.pool, w.people.operator!.ctx, w.store, hit.citation.citationId));
    expect(r.reasonCode).toBe('OBJECT_INTEGRITY_FAILED');
    writeFileSync(join(w.storeRoot, doc.objectKey), bytes);
  });

  it('a document with no parseable text or an unauthorized uploader is refused', async () => {
    const r1 = await rejection(
      ingestAs(w, w.people.viewer!, MANUAL_C()),
    );
    expect(r1.code).toBe('FORBIDDEN');
    // Site-scoped operators can attach asset-specific records but not tenant-wide model manuals.
    const r2 = await rejection(ingestAs(w, w.people.operator!, { ...MANUAL_C(), documentRevision: 'C2' }));
    expect(r2.code).toBe('FORBIDDEN');
    const r3 = await rejection(
      ingestAs(w, w.librarian, { ...MANUAL_C(), bytes: Buffer.from('%PDF-1.7\n%%EOF\n'), documentRevision: 'empty' }),
    );
    expect(r3.reasonCode).toBe('PDF_TEXT_UNAVAILABLE');
  });
});
