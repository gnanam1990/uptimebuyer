// T-026 — Ambiguous compatibility hold (FR-06, INV-02, INV-04), persisted. Against real M05 evidence revisions:
// conflicting manual revisions, a component no authoritative document names, a seller listing offering a "compatible
// replacement", a model proposal with maximal confidence, a stale offer and an unapproved vendor each persist HOLD or
// REJECT, never ALLOW. Candidate claims must cite text inside the bound evidence revision: a claim whose value is
// not in the cited span, a citation from another revision, or a forged source attribute is refused, and every source
// attribute used by the engine is server-derived.
import { money } from '@uptimebuyer/contracts';
import { commitIncidentEvidence } from '@uptimebuyer/evidence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateCandidate, getCandidateAction, registerCandidateAction } from '../src/index.js';
import { MANUAL_B, ingestAs } from '../../evidence/test/helpers.js';
import {
  SELLER_LISTING,
  citationFor,
  createCompatWorld,
  exactCandidate,
  incidentWithEvidence,
  merchant,
  rejection,
  type CompatWorld,
} from './helpers.js';

let w: CompatWorld;
let inc: Awaited<ReturnType<typeof incidentWithEvidence>>;

const evaluate = (candidateActionId: string) => evaluateCandidate(w.db.pool, w.service, { candidateActionId });

describe('T-026 ambiguous compatibility hold (persisted)', () => {
  beforeAll(async () => {
    w = await createCompatWorld('t026');
    await ingestAs(w, w.librarian, SELLER_LISTING());
    inc = await incidentWithEvidence(w);
  });
  afterAll(async () => {
    await w?.close();
  });

  it('a component without an authoritative exact part number is HOLD, whatever the model says', async () => {
    const cand = await exactCandidate(w, inc, {
      component: 'Compressor start relay',
      partNumber: '7R1-0007',
      merchantId: merchant() as never,
      explanation: {
        origin: 'MODEL_PROPOSAL',
        proposalId: null,
        modelConfidencePpm: 1_000_000,
        searchRank: 1,
        semanticScorePpm: 999_999,
        sellerClaim: null,
      },
    });
    const d = await evaluate(cand.candidateActionId);
    expect(d.decision).toBe('HOLD');
    expect(d.blockingReasons).toContain('MISSING_EXACT_MPN');
    expect(d.missingFields).toContain('part:compressor-start-relay');
    expect(d.explanation).toMatchObject({ origin: 'MODEL_PROPOSAL', modelConfidencePpm: 1_000_000, authority: 'NONE' });
  });

  it('a seller "compatible replacement" with seller-cited claims is HOLD (substitute, seller evidence), never ALLOW', async () => {
    const cite = await citationFor(w, inc.evidenceRevisionId, 'compatible replacement', 'Marketplace listing CL-9000');
    const cert = await citationFor(
      w,
      inc.evidenceRevisionId,
      'certification UL 471 claimed',
      'Marketplace listing CL-9000',
    );
    const cand = await exactCandidate(w, inc, {
      manufacturer: 'Coldline',
      partNumber: 'CL-9000',
      merchantId: merchant() as never,
      specClaims: [{ key: 'fit', value: 'compatible replacement for Northwind NWR-2D-48', citationId: cite }],
      certificationClaims: [{ code: 'UL 471', citationId: cert }],
      explanation: {
        origin: 'PROVIDER_OFFER',
        proposalId: null,
        modelConfidencePpm: null,
        searchRank: 1,
        semanticScorePpm: 950_000,
        sellerClaim: 'fits like OEM',
      },
    });
    const view = await getCandidateAction(w.db.pool, w.people.operator!.ctx, cand.candidateActionId);
    expect(view.certificationClaims[0]).toMatchObject({ sourceKind: 'PROVIDER_DOCUMENT', basis: 'SELLER_TEXT' });
    const d = await evaluate(cand.candidateActionId);
    expect(d.decision).toBe('HOLD');
    expect(d.blockingReasons).toEqual(
      expect.arrayContaining([
        'UNSUPPORTED_SUBSTITUTE',
        'NAMED_APPROVAL_REQUIRED',
        'MISSING_CERTIFICATION',
        'WARRANTY_REQUIRES_OEM_PART',
      ]),
    );
  });

  it('conflicting manual revisions are HOLD with the conflicting field named', async () => {
    const other = await incidentWithEvidence(w);
    await ingestAs(w, w.librarian, MANUAL_B());
    const rev = await commitIncidentEvidence(w.db.pool, w.people.operator!.ctx, w.store, {
      incidentId: other.incidentId,
      reasonCode: 'MANUAL_ADDED',
    });
    const cand = await exactCandidate(
      w,
      { incidentId: other.incidentId, evidenceRevisionId: rev.evidenceRevisionId },
      { merchantId: merchant() as never },
    );
    const d = await evaluate(cand.candidateActionId);
    expect(d.decision).toBe('HOLD');
    expect(d.blockingReasons).toContain('CONFLICTING_MANUALS');
    expect(d.conflictingFields).toContain('part:evaporator-fan-motor');
  });

  it('a stale offer, a missing offer and an unapproved vendor are HOLD', async () => {
    const stale = await exactCandidate(w, inc, {
      merchantId: merchant() as never,
      offerObservedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    expect((await evaluate(stale.candidateActionId)).blockingReasons).toContain('STALE_PRICE_OR_STOCK');
    const none = await exactCandidate(w, inc, { merchantId: merchant() as never, offerObservedAt: null });
    expect((await evaluate(none.candidateActionId)).blockingReasons).toContain('STALE_PRICE_OR_STOCK');
    const vendor = await exactCandidate(w, inc, { merchantId: merchant() as never, vendorId: w.unapprovedVendorId });
    const v = await evaluate(vendor.candidateActionId);
    expect(v.decision).toBe('HOLD');
    expect(v.blockingReasons).toContain('VENDOR_NOT_APPROVED');
    const unknown = await exactCandidate(w, inc, {
      merchantId: merchant() as never,
      vendorId: 'vnd_not-registered-0001',
    });
    expect((await evaluate(unknown.candidateActionId)).blockingReasons).toContain('VENDOR_STATUS_UNKNOWN');
  });

  it('a candidate claim contradicting the authoritative manual is REJECT', async () => {
    const cite = await citationFor(w, inc.evidenceRevisionId, 'Rated voltage 115', 'Northwind 5A1-0402 data sheet');
    // The claim must appear in the cited span: 230 V does not, so registration refuses it.
    const refused = await rejection(
      exactCandidate(w, inc, {
        merchantId: merchant() as never,
        specClaims: [{ key: 'rated-voltage', value: '230 V', citationId: cite }],
      }),
    );
    expect([refused.code, refused.reasonCode]).toEqual(['VALIDATION_FAILED', 'CLAIM_NOT_IN_CITATION']);
    const listing = await citationFor(
      w,
      inc.evidenceRevisionId,
      'compatible replacement',
      'Marketplace listing CL-9000',
    );
    const cand = await exactCandidate(w, inc, {
      merchantId: merchant() as never,
      specClaims: [{ key: 'refrigerant', value: 'Northwind NWR-2D-48', citationId: listing }],
    });
    const d = await evaluate(cand.candidateActionId);
    expect(d.decision).toBe('REJECT');
    expect(d.blockingReasons).toContain('KNOWN_INCOMPATIBILITY');
  });

  it('claims cannot cite another revision, forge source attributes or skip the citation', async () => {
    const other = await incidentWithEvidence(w);
    const foreignCite = await citationFor(
      w,
      other.evidenceRevisionId,
      'UL 471 listed',
      'Northwind 5A1-0402 data sheet',
    );
    const r = await rejection(
      exactCandidate(w, inc, {
        merchantId: merchant() as never,
        certificationClaims: [{ code: 'UL 471', citationId: foreignCite }],
      }),
    );
    expect([r.code, r.reasonCode]).toEqual(['FORBIDDEN', 'RESOURCE_UNAVAILABLE']);
    const forged = await rejection(
      exactCandidate(w, inc, {
        merchantId: merchant() as never,
        certificationClaims: [
          {
            code: 'UL 471',
            citationId: foreignCite,
            sourceKind: 'OEM_PUBLICATION',
            trustLevel: 'AUTHORITATIVE',
          } as never,
        ],
      }),
    );
    expect(forged.code).toBe('VALIDATION_FAILED');
    const smuggled = await rejection(
      registerCandidateAction(w.db.pool, w.people.operator!.ctx, {
        incidentId: inc.incidentId,
        kind: 'PART_PURCHASE',
        component: 'Evaporator fan motor',
        manufacturer: 'Northwind Refrigeration',
        partNumber: '5A1-0402',
        quantity: 1,
        vendorId: w.vendorId,
        providerAccountRevisionId: w.providerAccountRevisionId,
        merchantId: merchant(),
        amount: money(18_500n, 'USD'),
        purpose: 'PART_PURCHASE',
        offerObservedAt: new Date().toISOString(),
        specClaims: [],
        certificationClaims: [],
        decision: 'ALLOW',
        evidenceRevisionId: inc.evidenceRevisionId,
      } as never),
    );
    expect(smuggled.code).toBe('VALIDATION_FAILED');
  });

  it('every persisted outcome in this file is HOLD or REJECT except none', async () => {
    const { rows } = await w.db.pool.query(
      `SELECT decision, count(*)::int AS n FROM compatibility_decisions WHERE tenant_id = $1 GROUP BY decision ORDER BY decision`,
      [w.tenant.tenantId],
    );
    expect(rows.find((r) => r.decision === 'ALLOW')).toBeUndefined();
    expect(rows.reduce((n, r) => n + r.n, 0)).toBeGreaterThanOrEqual(8);
  });
});
