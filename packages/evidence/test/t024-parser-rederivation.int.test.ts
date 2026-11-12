// T-024 (parser re-derivation) — a parser upgrade must never silently rewrite recorded evidence. Spans are immutable
// and a citation is re-opened by re-deriving its span from the immutable object, so (1) a citation issued over a
// document ingested by an older parser keeps re-opening with the parser version recorded on that document, and (2)
// re-ingesting the same bytes under a parser whose extraction differs records a NEW derived document that supersedes
// the old derivation, and committing it produces a new evidence revision (which supersedes dependent proposals). A
// document whose extraction is unchanged by the upgrade (plain text, CSV, WinAnsi-only PDFs) is reused, not re-derived.
import { tenantCommand } from '@uptimebuyer/data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DOCUMENT_LIMITS,
  PARSER_VERSION,
  commitIncidentEvidence,
  getDocument,
  getEvidenceRevision,
  parseDocument,
  reopenCitation,
  searchEvidence,
  type IngestDocumentInput,
} from '../src/index.js';
import { storeDocumentTx } from '../src/documents.js';
import { addHelvetica, addType0Font, buildFontPdf, glyphIds, toUnicodeCMap } from './fixtures/font-pdf-builder.js';
import { BOM_7, createEvidenceWorld, ingestAs, openIncident, type EvidenceWorld } from './helpers.js';
import { MANUFACTURER, MODEL } from './fixtures/content.js';

const LEGACY = 'uptimebuyer-parser.v2';
let w: EvidenceWorld;

const ids = glyphIds('Evaporator fan delay after defrost');
const MANUAL_BYTES = buildFontPdf((g) => {
  const f1 = addHelvetica(g);
  const f2 = addType0Font(g, { toUnicode: g.stream('', toUnicodeCMap(ids.bfchar())) });
  return [
    {
      fonts: `/F1 ${f1} 0 R /F2 ${f2} 0 R`,
      content: `BT /F1 10 Tf 72 740 Td (Controller service notes) Tj 0 -14 Td /F2 10 Tf ${ids.hex('Evaporator fan delay after defrost')} Tj ET`,
    },
  ];
});
const MANUAL = (): IngestDocumentInput => ({
  role: 'MANUAL',
  mediaType: 'application/pdf',
  bytes: MANUAL_BYTES,
  title: 'Controller service notes',
  documentRevision: 'R1',
  applicability: { manufacturer: MANUFACTURER, model: MODEL, bomRevision: null, serial: null, assetId: null },
  sourceKind: 'OEM_PUBLICATION',
  sourceRef: 'synthetic Identity-H manual',
});

/** Store a document exactly as the v2 parser recorded it before the upgrade (same table rows, same span digests). */
async function storeAsLegacy(input: IngestDocumentInput) {
  const parsed = parseDocument(input.bytes, input.mediaType, DOCUMENT_LIMITS, { parserVersion: LEGACY });
  return tenantCommand(
    w.db.pool,
    w.librarian.ctx,
    { action: 'evidence_document.ingest', resourceType: 'evidence_document', resourceId: null },
    (c) =>
      storeDocumentTx(
        c,
        w.librarian.ctx,
        w.store,
        {
          role: input.role,
          mediaType: input.mediaType,
          bytes: input.bytes,
          title: input.title,
          documentRevision: input.documentRevision,
          applicability: {
            manufacturer: input.applicability.manufacturer,
            model: input.applicability.model,
            bomRevision: input.applicability.bomRevision ?? null,
            serial: input.applicability.serial ?? null,
            assetId: input.applicability.assetId ?? null,
          },
          siteId: null,
          sourceKind: input.sourceKind,
          sourceRef: input.sourceRef ?? null,
          trustLevel: 'OPERATOR_ATTESTED',
          consentRef: null,
          purposes: [],
          supersedesDocumentId: null,
        },
        parsed,
      ),
  );
}

describe('T-024 parser re-derivation is a new derived revision, never a silent rewrite', () => {
  beforeAll(async () => {
    w = await createEvidenceWorld('t024p');
  });
  afterAll(async () => {
    await w?.close();
  });

  it('keeps legacy citations verifiable and records a re-extraction as a new superseding document and revision', async () => {
    expect(PARSER_VERSION).not.toBe(LEGACY);
    const legacy = await storeAsLegacy(MANUAL());
    expect((await getDocument(w.db.pool, w.librarian.ctx, legacy.documentId)).parserVersion).toBe(LEGACY);

    const incidentId = await openIncident(w, w.nwr.assetId);
    const r1 = await commitIncidentEvidence(w.db.pool, w.people.operator!.ctx, w.store, {
      incidentId,
      reasonCode: 'TRIAGE_EVIDENCE',
    });
    const hit1 = (
      await searchEvidence(w.db.pool, w.people.viewer!.ctx, { evidenceRevisionId: r1.evidenceRevisionId, query: 'controller service notes' })
    ).find((h) => h.documentId === legacy.documentId)!;
    expect(hit1).toBeDefined();
    // The legacy derivation could not read the Identity-H line.
    expect(hit1.excerpt).not.toContain('Evaporator fan delay');

    // (1) After the upgrade the legacy citation still re-opens, re-derived with the parser recorded on its document.
    const reopened1 = await reopenCitation(w.db.pool, w.people.viewer!.ctx, w.store, hit1.citation.citationId);
    expect(reopened1.verified).toBe(true);
    expect(reopened1.text).not.toContain('Evaporator fan delay');

    // (2) Re-ingesting the same bytes under the current parser records a new derived document that supersedes it.
    const derived = await ingestAs(w, w.librarian, MANUAL());
    expect(derived.existing).toBe(false);
    expect(derived.documentId).not.toBe(legacy.documentId);
    const derivedRecord = await getDocument(w.db.pool, w.librarian.ctx, derived.documentId);
    expect(derivedRecord).toMatchObject({ parserVersion: PARSER_VERSION, withdrawn: false, sha256: legacy.sha256 });
    expect(derivedRecord.supersedesDocumentId).toBe(legacy.documentId);
    expect((await getDocument(w.db.pool, w.librarian.ctx, legacy.documentId)).withdrawn).toBe(true);
    // Idempotent: the same bytes under the same parser return the derived document.
    const again = await ingestAs(w, w.librarian, MANUAL());
    expect(again).toMatchObject({ existing: true, documentId: derived.documentId });

    // Committing it is a new evidence revision with the derived document only.
    const r2 = await commitIncidentEvidence(w.db.pool, w.people.operator!.ctx, w.store, {
      incidentId,
      reasonCode: 'TRIAGE_EVIDENCE',
    });
    expect(r2).toMatchObject({ changed: true, revision: r1.revision + 1 });
    const rev2 = await getEvidenceRevision(w.db.pool, w.people.viewer!.ctx, r2.evidenceRevisionId);
    expect(rev2.verification).toEqual({ manifestDigestMatches: true, contentDigestMatches: true });
    const manualIds = rev2.documents.filter((d) => d.role === 'MANUAL').map((d) => d.documentId);
    expect(manualIds).toEqual([derived.documentId]);
    const hit2 = (
      await searchEvidence(w.db.pool, w.people.viewer!.ctx, { evidenceRevisionId: r2.evidenceRevisionId, query: 'evaporator fan delay' })
    ).find((h) => h.documentId === derived.documentId)!;
    expect(hit2.excerpt).toContain('Evaporator fan delay after defrost');
    const reopened2 = await reopenCitation(w.db.pool, w.people.viewer!.ctx, w.store, hit2.citation.citationId);
    expect(reopened2.verified).toBe(true);
    expect(reopened2.text).toContain('Evaporator fan delay after defrost');

    // The revision-1 citation is still verifiable after the re-derivation (its span was never rewritten).
    const reopenedLater = await reopenCitation(w.db.pool, w.people.viewer!.ctx, w.store, hit1.citation.citationId);
    expect(reopenedLater).toMatchObject({ verified: true, text: reopened1.text, documentId: legacy.documentId });
  });

  it('reuses a legacy document whose extraction the upgrade does not change (no churn)', async () => {
    const legacyBom = await storeAsLegacy(BOM_7());
    const again = await ingestAs(w, w.librarian, BOM_7());
    expect(again).toMatchObject({ existing: true, documentId: legacyBom.documentId });
    expect((await getDocument(w.db.pool, w.librarian.ctx, legacyBom.documentId)).withdrawn).toBe(false);
  });

  it('does not resurrect a withdrawn legacy document by re-deriving it', async () => {
    const bytes = buildFontPdf((g) => {
      const f1 = addHelvetica(g);
      const f2 = addType0Font(g, { toUnicode: g.stream('', toUnicodeCMap(ids.bfchar())) });
      return [{ fonts: `/F1 ${f1} 0 R /F2 ${f2} 0 R`, content: `BT /F1 10 Tf (Withdrawn notes) Tj /F2 10 Tf ${ids.hex('fan')} Tj ET` }];
    });
    const input = { ...MANUAL(), bytes, documentRevision: 'R-withdrawn' };
    const legacy = await storeAsLegacy(input);
    const { withdrawDocument } = await import('../src/index.js');
    await withdrawDocument(w.db.pool, w.librarian.ctx, legacy.documentId, { reasonCode: 'WRONG_DOCUMENT' });
    const again = await ingestAs(w, w.librarian, input);
    expect(again).toMatchObject({ existing: true, documentId: legacy.documentId });
  });
});
