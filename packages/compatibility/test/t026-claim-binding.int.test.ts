// T-026 — claim binding (security review): a candidate claim is an authoritative exact citation only when the cited
// span carries a server-extracted M05 fact with the same key and an exactly equal normalized value. Text containment
// alone (a prefix or suffix of a longer value, a negated sentence, a value cited for another key) yields only a
// non-authoritative SEMANTIC_MATCH basis, and a seller-sourced fact stays SELLER_TEXT: none can produce ALLOW.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateCandidate, getCandidateAction } from '../src/index.js';
import { ingestAs } from '../../evidence/test/helpers.js';
import {
  MANUFACTURER,
  MODEL,
  citationFor,
  createCompatWorld,
  exactCandidate,
  incidentWithEvidence,
  merchant,
  type CompatWorld,
} from './helpers.js';

let w: CompatWorld;
let inc: Awaited<ReturnType<typeof incidentWithEvidence>>;

const doc = (title: string, sourceKind: 'OEM_PUBLICATION' | 'PROVIDER_DOCUMENT', lines: string[]) => ({
  role: 'OTHER' as const,
  mediaType: 'text/markdown' as const,
  bytes: Buffer.from(lines.join('\n\n') + '\n'),
  title,
  documentRevision: '1',
  applicability: { manufacturer: MANUFACTURER, model: MODEL, bomRevision: null, serial: null, assetId: null },
  sourceKind,
  sourceRef: null,
});

describe('T-026 claims bind to exact extracted facts (security review)', () => {
  beforeAll(async () => {
    w = await createCompatWorld('t026b');
    await ingestAs(
      w,
      w.librarian,
      doc('Tricky bulletin', 'OEM_PUBLICATION', ['Certification: UL 4710', 'Certification: not UL 471']),
    );
    await ingestAs(w, w.librarian, doc('Seller sheet', 'PROVIDER_DOCUMENT', ['Certification: UL 471']));
    inc = await incidentWithEvidence(w);
  });
  afterAll(async () => {
    await w?.close();
  });

  const certCase = async (query: string, title: string) => {
    const cite = await citationFor(w, inc.evidenceRevisionId, query, title);
    const cand = await exactCandidate(w, inc, {
      merchantId: merchant() as never,
      certificationClaims: [{ code: 'UL 471', citationId: cite }],
    });
    const view = await getCandidateAction(w.db.pool, w.people.operator!.ctx, cand.candidateActionId);
    const d = await evaluateCandidate(w.db.pool, w.service, { candidateActionId: cand.candidateActionId }, w.signing);
    return { basis: view.certificationClaims[0]!.basis, d };
  };

  it('the exact OEM certification fact is CITED_EXACT_TEXT and allows', async () => {
    const r = await certCase('Certification UL 471', 'Northwind 5A1-0402 data sheet');
    expect(r.basis).toBe('CITED_EXACT_TEXT');
    expect(r.d.decision).toBe('ALLOW');
  });

  it('a longer code containing the claim (prefix) is only a semantic match', async () => {
    const r = await certCase('UL 4710', 'Tricky bulletin');
    expect(r.basis).toBe('SEMANTIC_MATCH');
    expect(r.d.decision).not.toBe('ALLOW');
    expect(r.d.blockingReasons).toContain('MISSING_CERTIFICATION');
  });

  it('a negated sentence is only a semantic match', async () => {
    const r = await certCase('not UL 471', 'Tricky bulletin');
    expect(r.basis).toBe('SEMANTIC_MATCH');
    expect(r.d.decision).not.toBe('ALLOW');
  });

  it('a seller-sourced exact fact stays seller text', async () => {
    const r = await certCase('Certification UL 471', 'Seller sheet');
    expect(r.basis).toBe('SELLER_TEXT');
    expect(r.d.decision).not.toBe('ALLOW');
  });

  it('a suffix of a value and a value cited for another key are only semantic matches', async () => {
    const volt = await citationFor(w, inc.evidenceRevisionId, 'Rated voltage 115', 'Northwind 5A1-0402 data sheet');
    const freq = await citationFor(w, inc.evidenceRevisionId, 'Frequency 60', 'Northwind 5A1-0402 data sheet');
    const cand = await exactCandidate(w, inc, {
      merchantId: merchant() as never,
      specClaims: [
        { key: 'rated-voltage', value: '15 V', citationId: volt },
        { key: 'refrigerant', value: '60 Hz', citationId: freq },
      ],
    });
    const view = await getCandidateAction(w.db.pool, w.people.operator!.ctx, cand.candidateActionId);
    expect(view.specClaims.map((c) => c.basis)).toEqual(['SEMANTIC_MATCH', 'SEMANTIC_MATCH']);
    const d = await evaluateCandidate(w.db.pool, w.service, { candidateActionId: cand.candidateActionId }, w.signing);
    expect(d.decision).not.toBe('ALLOW');
  });

  it('an exact spec fact on the cited span is CITED_EXACT_TEXT', async () => {
    const volt = await citationFor(w, inc.evidenceRevisionId, 'Rated voltage 115', 'Northwind 5A1-0402 data sheet');
    const cand = await exactCandidate(w, inc, {
      merchantId: merchant() as never,
      specClaims: [{ key: 'rated-voltage', value: '115  V', citationId: volt }],
    });
    const view = await getCandidateAction(w.db.pool, w.people.operator!.ctx, cand.candidateActionId);
    expect(view.specClaims[0]!.basis).toBe('CITED_EXACT_TEXT');
  });
});
