// T-024 (parser re-derivation) — a parser upgrade must never silently rewrite recorded evidence. Spans are immutable
// and a citation is re-opened by re-deriving its span from the immutable object, so (1) a citation issued over a
// document ingested by an older parser keeps re-opening with the parser version recorded on that document, and (2)
// re-ingesting the same bytes under a parser whose extraction differs records a NEW derived document that supersedes
// the old derivation, and committing it produces a new evidence revision (which supersedes dependent proposals). A
// document whose extraction is unchanged by the upgrade (plain text, CSV, WinAnsi-only PDFs) is reused, not re-derived.
import { tenantCommand } from '@uptimebuyer/data';
import pg from 'pg';
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
  withdrawDocument,
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

/** Store a document exactly as an older parser recorded it before the upgrade (same table rows, same span digests). */
async function storeAsLegacy(input: IngestDocumentInput, parserVersion: string = LEGACY) {
  const parsed = parseDocument(input.bytes, input.mediaType, DOCUMENT_LIMITS, { parserVersion });
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
    // A parser re-derivation is recorded as such; supersedes_document_id is kept for explicit replacements (PR #20).
    expect(derivedRecord.rederivedFromDocumentId).toBe(legacy.documentId);
    expect(derivedRecord.supersedesDocumentId).toBeNull();
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

// PR #20 review findings: re-derivation against concurrent withdrawal, fact-only differences and explicit replacement.
describe('T-024 parser re-derivation: lineage withdrawal, facts and replacement (review findings)', () => {
  let x: EvidenceWorld;
  beforeAll(async () => {
    x = await createEvidenceWorld('t024r');
    w = x;
  });
  afterAll(async () => {
    await x?.close();
  });

  const manualOf = (label: string): IngestDocumentInput => {
    const g2 = glyphIds(`Probe ${label} alarm`);
    const bytes = buildFontPdf((g) => {
      const f1 = addHelvetica(g);
      const f2 = addType0Font(g, { toUnicode: g.stream('', toUnicodeCMap(g2.bfchar())) });
      return [
        {
          fonts: `/F1 ${f1} 0 R /F2 ${f2} 0 R`,
          content: `BT /F1 10 Tf (Notes ${label}) Tj 0 -14 Td /F2 10 Tf ${g2.hex(`Probe ${label} alarm`)} Tj ET`,
        },
      ];
    });
    return { ...MANUAL(), bytes, documentRevision: `R-${label}`, title: `Notes ${label}` };
  };
  /** Every document recorded for this blob, role and applicability (all parser derivations), with withdrawal state. */
  const lineage = async (sha256: string, documentRevision: string) =>
    (
      await x.db.admin(
        `SELECT d.id, d.parser_version,
                EXISTS (SELECT 1 FROM evidence_document_events e WHERE e.tenant_id = d.tenant_id AND e.document_id = d.id)
                  AS withdrawn
           FROM evidence_documents d JOIN evidence_blobs b ON b.tenant_id = d.tenant_id AND b.id = d.blob_id
          WHERE d.tenant_id = $1 AND b.sha256 = $2 AND d.document_revision = $3`,
        [x.tenant.tenantId, sha256, documentRevision],
      )
    ).rows as { id: string; parser_version: string; withdrawn: boolean }[];

  it('withdrawing a document withdraws every derivation of its bytes (no active re-derivation survives)', async () => {
    const input = manualOf('seq');
    const legacy = await storeAsLegacy(input);
    const derived = await ingestAs(x, x.librarian, input);
    expect(derived.existing).toBe(false);
    await withdrawDocument(x.db.pool, x.librarian.ctx, legacy.documentId, { reasonCode: 'WRONG_DOCUMENT' });
    expect((await lineage(legacy.sha256, input.documentRevision)).filter((d) => !d.withdrawn)).toEqual([]);
  });

  it('a withdrawal racing a re-ingest never leaves an active derivation of the withdrawn bytes', async () => {
    const input = manualOf('race');
    const legacy = await storeAsLegacy(input);
    // Hold a SHARE lock on evidence_documents: the re-ingest reads the lineage and then blocks at its INSERT, so the
    // withdrawal is issued after the re-derivation check and before the new derivation exists. Lock waits are observed
    // from a separate connection (pg_stat_activity is a per-transaction snapshot inside the blocker).
    const blocker = new pg.Client({ connectionString: x.db.url });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE evidence_documents IN SHARE MODE');
      const waiting = async (pattern: string) => {
        for (let i = 0; i < 200; i++) {
          const r = await x.db.admin(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`,
            [pattern],
          );
          if (r.rows[0].n > 0) return true;
          await new Promise((res) => setTimeout(res, 25));
        }
        return false;
      };
      const ingest = ingestAs(x, x.librarian, input);
      expect(await waiting('%INSERT INTO evidence_documents%')).toBe(true);
      let settled = false;
      const withdraw = withdrawDocument(x.db.pool, x.librarian.ctx, legacy.documentId, { reasonCode: 'WRONG_DOCUMENT' }).finally(
        () => (settled = true),
      );
      // Either the withdrawal completes (no serialization) or it waits on the lineage lock (serialized).
      for (let i = 0; i < 200 && !settled; i++) {
        const r = await x.db.admin(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'`,
        );
        if (r.rows[0].n > 0) break;
        await new Promise((res) => setTimeout(res, 25));
      }
      await blocker.query('COMMIT');
      await Promise.all([ingest, withdraw]);
    } finally {
      await blocker.end();
    }
    expect((await lineage(legacy.sha256, input.documentRevision)).filter((d) => !d.withdrawn)).toEqual([]);
    // And a later re-ingest of the withdrawn bytes does not bring them back.
    const again = await ingestAs(x, x.librarian, input);
    expect(again.existing).toBe(true);
    expect((await lineage(legacy.sha256, input.documentRevision)).filter((d) => !d.withdrawn)).toEqual([]);
  });

  it('a v1 document whose spans are unchanged but whose facts differ under v3 is re-derived, not reused', async () => {
    const input: IngestDocumentInput = {
      ...MANUAL(),
      mediaType: 'text/plain',
      bytes: Buffer.from('Controller sheet\nCertification: UL 471, CSA C22.2\nRefrigerant: R-290\n'),
      documentRevision: 'R-facts',
    };
    const legacy = await storeAsLegacy(input, 'uptimebuyer-parser.v1');
    expect(legacy.factCount).toBe(1); // v1 had no certification facts
    const again = await ingestAs(x, x.librarian, input);
    expect(again.existing).toBe(false);
    expect(again.documentId).not.toBe(legacy.documentId);
    expect(again).toMatchObject({ factCount: 3, rederivedFromDocumentId: legacy.documentId, parserVersion: PARSER_VERSION });
    expect((await getDocument(x.db.pool, x.librarian.ctx, legacy.documentId)).withdrawn).toBe(true);
  });

  it('an explicit replacement that is also a re-derivation records both relationships and withdraws both', async () => {
    const replaced = await ingestAs(x, x.librarian, manualOf('old-revision'));
    const input = manualOf('new-revision');
    const legacy = await storeAsLegacy(input);
    const created = await ingestAs(x, x.librarian, { ...input, supersedesDocumentId: replaced.documentId });
    expect(created).toMatchObject({ existing: false, rederivedFromDocumentId: legacy.documentId });
    const rec = await getDocument(x.db.pool, x.librarian.ctx, created.documentId);
    expect(rec).toMatchObject({
      supersedesDocumentId: replaced.documentId,
      rederivedFromDocumentId: legacy.documentId,
      withdrawn: false,
    });
    expect((await getDocument(x.db.pool, x.librarian.ctx, replaced.documentId)).withdrawn).toBe(true);
    expect((await getDocument(x.db.pool, x.librarian.ctx, legacy.documentId)).withdrawn).toBe(true);
    const reasons = (
      await x.db.admin(`SELECT document_id, reason_code FROM evidence_document_events WHERE tenant_id = $1 AND document_id = ANY($2)`, [
        x.tenant.tenantId,
        [replaced.documentId, legacy.documentId],
      ])
    ).rows as { document_id: string; reason_code: string }[];
    expect(Object.fromEntries(reasons.map((r) => [r.document_id, r.reason_code]))).toEqual({
      [replaced.documentId]: 'SUPERSEDED_BY_REPLACEMENT',
      [legacy.documentId]: 'REDERIVED_BY_PARSER',
    });
  });

  it('replacing a document withdraws every derivation of the replaced bytes', async () => {
    const oldInput = manualOf('lineage-old');
    const oldLegacy = await storeAsLegacy(oldInput);
    const oldDerived = await ingestAs(x, x.librarian, oldInput);
    expect(oldDerived.existing).toBe(false);
    // The operator replaces the (already superseded) legacy row: its active v3 derivation must go too.
    await ingestAs(x, x.librarian, { ...manualOf('lineage-new'), supersedesDocumentId: oldLegacy.documentId });
    expect((await lineage(oldLegacy.sha256, oldInput.documentRevision)).filter((d) => !d.withdrawn)).toEqual([]);
  });
});
