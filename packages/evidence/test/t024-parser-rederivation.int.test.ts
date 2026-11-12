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
  withdrawConsentedCommunicationsInTx,
  withdrawDocument,
  type IngestDocumentInput,
} from '../src/index.js';
import { storeDocumentTx } from '../src/documents.js';
import { addHelvetica, addType0Font, buildFontPdf, glyphIds, toUnicodeCMap } from './fixtures/font-pdf-builder.js';
import { BOM_7, createEvidenceWorld, ingestAs, openIncident, rejection, type EvidenceWorld } from './helpers.js';
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
async function storeAsLegacy(input: IngestDocumentInput, parserVersion: string = LEGACY, siteId: string | null = null) {
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
          siteId: siteId as never,
          sourceKind: input.sourceKind,
          sourceRef: input.sourceRef ?? null,
          trustLevel: 'OPERATOR_ATTESTED',
          consentRef: input.communication?.consentRef ?? null,
          purposes: input.communication?.purposes ?? [],
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

// PR #20 second review pass: consent withdrawal against re-derivation, replacement inside one lineage, replacement
// requested for bytes that are already recorded.
describe('T-024 parser re-derivation: consent and replacement transitions (second review pass)', () => {
  let x: EvidenceWorld;
  beforeAll(async () => {
    x = await createEvidenceWorld('t024c');
    w = x;
  });
  afterAll(async () => {
    await x?.close();
  });

  /** A consented transcript whose v1 and v3 derivations differ (v1 extracted no certification facts). */
  const transcript = (consentRef: string, label: string): IngestDocumentInput => ({
    role: 'TRANSCRIPT',
    mediaType: 'text/plain',
    bytes: Buffer.from(`Technician ${label}: replacement controller in stock\nCertification: UL 471, CSA C22.2\n`),
    title: `Call transcript ${label}`,
    documentRevision: `call-${label}`,
    applicability: { manufacturer: MANUFACTURER, model: MODEL, bomRevision: null, serial: null, assetId: x.nwr.assetId },
    sourceKind: 'COMMUNICATION',
    communication: { consentRef, purposes: ['EVIDENCE_REASONING'] },
  });
  const activeWithConsent = async (consentRef: string) =>
    (
      await x.db.admin(
        `SELECT d.id FROM evidence_documents d
          WHERE d.tenant_id = $1 AND d.consent_ref = $2
            AND NOT EXISTS (SELECT 1 FROM evidence_document_events e WHERE e.tenant_id = d.tenant_id AND e.document_id = d.id)`,
        [x.tenant.tenantId, consentRef],
      )
    ).rows;
  const withdrawConsent = async (consentRef: string) => {
    const c = await x.db.pool.connect();
    try {
      await c.query('BEGIN');
      await withdrawConsentedCommunicationsInTx(c as never, x.tenant.tenantId, [consentRef], {
        reasonCode: 'PROCESSING_CONSENT_WITHDRAWN',
        systemActorId: 'test-consent-withdrawal',
      });
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  };

  it('a consent withdrawal racing a re-derivation never leaves an active document with the withdrawn consent', async () => {
    const consentRef = 'consent-race-0001';
    const input = transcript(consentRef, 'race');
    const legacy = await storeAsLegacy(input, 'uptimebuyer-parser.v1', x.siteId);
    // Hold a SHARE lock on evidence_document_spans: the re-derivation inserts its document row and the prior row's
    // WITHDRAWN event, then blocks at its first span INSERT, still uncommitted. The consent withdrawal starts there.
    const blocker = new pg.Client({ connectionString: x.db.url });
    await blocker.connect();
    const waiting = async (sql: string) => {
      for (let i = 0; i < 200; i++) {
        if ((await x.db.admin(sql)).rows[0].n > 0) return true;
        await new Promise((res) => setTimeout(res, 25));
      }
      return false;
    };
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE evidence_document_spans IN SHARE MODE');
      const ingest = ingestAs(x, x.librarian, input);
      expect(
        await waiting(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO evidence_document_spans%'`,
        ),
      ).toBe(true);
      const withdraw = withdrawConsent(consentRef);
      // Unserialized, the withdrawal waits on the prior row's uncommitted event; serialized, on the consent lock.
      expect(
        await waiting(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND (wait_event = 'advisory' OR query LIKE '%consent_ref = ANY%')`,
        ),
      ).toBe(true);
      await blocker.query('COMMIT');
      const [ingested] = await Promise.all([ingest, withdraw]);
      expect(ingested.rederivedFromDocumentId).toBe(legacy.documentId);
    } finally {
      await blocker.end();
    }
    expect(await activeWithConsent(consentRef)).toEqual([]);
  });

  it('a document cannot be recorded under a consent that was already withdrawn', async () => {
    const consentRef = 'consent-gone-0002';
    await withdrawConsent(consentRef);
    const r = await rejection(ingestAs(x, x.librarian, transcript(consentRef, 'late')));
    expect(r.reasonCode).toBe('CONSENT_WITHDRAWN');
    expect(await activeWithConsent(consentRef)).toEqual([]);
  });

  const manualOf = (label: string): IngestDocumentInput => {
    const g2 = glyphIds(`Fan ${label} delay`);
    const bytes = buildFontPdf((g) => {
      const f1 = addHelvetica(g);
      const f2 = addType0Font(g, { toUnicode: g.stream('', toUnicodeCMap(g2.bfchar())) });
      return [
        {
          fonts: `/F1 ${f1} 0 R /F2 ${f2} 0 R`,
          content: `BT /F1 10 Tf (Sheet ${label}) Tj 0 -14 Td /F2 10 Tf ${g2.hex(`Fan ${label} delay`)} Tj ET`,
        },
      ];
    });
    return { ...MANUAL(), bytes, documentRevision: `S-${label}`, title: `Sheet ${label}` };
  };

  it('a replacement naming a derivation of the same bytes is refused with a clear code', async () => {
    const input = manualOf('self');
    const legacy = await storeAsLegacy(input);
    const r1 = await rejection(ingestAs(x, x.librarian, { ...input, supersedesDocumentId: legacy.documentId }));
    expect(r1.reasonCode).toBe('SUPERSEDED_DOCUMENT_SAME_LINEAGE');
    expect((await getDocument(x.db.pool, x.librarian.ctx, legacy.documentId)).withdrawn).toBe(false);
    // After a plain re-derivation, naming the (now withdrawn) older derivation is refused the same way, and the
    // active derivation stays active.
    const derived = await ingestAs(x, x.librarian, input);
    const r2 = await rejection(ingestAs(x, x.librarian, { ...input, supersedesDocumentId: legacy.documentId }));
    expect(r2.reasonCode).toBe('SUPERSEDED_DOCUMENT_SAME_LINEAGE');
    expect((await getDocument(x.db.pool, x.librarian.ctx, derived.documentId)).withdrawn).toBe(false);
  });

  it('a replacement requested for bytes already recorded is refused, never reported as done without the transition', async () => {
    const replaced = await ingestAs(x, x.librarian, { ...BOM_7(), documentRevision: 'BOM-7-A', applicability: { ...BOM_7().applicability, bomRevision: 'BOM-7-A' } });
    const bInput = { ...BOM_7(), bytes: Buffer.from('item,component,oem_part_number\nX1,Door gasket,2G4-0048\n'), documentRevision: 'BOM-7-B', applicability: { ...BOM_7().applicability, bomRevision: 'BOM-7-B' } };
    // B was stored by v2; v3 extracts identical spans and facts from it, so it would be reused as is.
    const b = await storeAsLegacy(bInput);
    const r = await rejection(ingestAs(x, x.librarian, { ...bInput, supersedesDocumentId: replaced.documentId }));
    expect(r.reasonCode).toBe('REPLACEMENT_BYTES_ALREADY_RECORDED');
    expect((await getDocument(x.db.pool, x.librarian.ctx, replaced.documentId)).withdrawn).toBe(false);
    expect((await getDocument(x.db.pool, x.librarian.ctx, b.documentId)).supersedesDocumentId).toBeNull();
  });

  it('retrying an applied replacement is idempotent (the recorded link is the transition)', async () => {
    const replaced = await ingestAs(x, x.librarian, manualOf('retry-old'));
    const input = { ...manualOf('retry-new'), supersedesDocumentId: replaced.documentId };
    const first = await ingestAs(x, x.librarian, input);
    expect(first.existing).toBe(false);
    const again = await ingestAs(x, x.librarian, input);
    expect(again).toMatchObject({ existing: true, documentId: first.documentId });
    expect((await getDocument(x.db.pool, x.librarian.ctx, replaced.documentId)).withdrawn).toBe(true);
  });
});
