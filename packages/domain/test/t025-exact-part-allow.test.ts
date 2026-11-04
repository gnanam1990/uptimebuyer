// T-025 — Exact manufacturer part allow (FR-06, INV-04). A complete exact OEM part / equipment match that satisfies
// the electrical, mechanical, certification, warranty, vendor and offer-freshness rules deterministically returns
// ALLOW with machine-readable reasons and the exact input digest. Model confidence, search rank and seller text are
// explanation only: they never enter the input digest or change the decision (INV-02).
import { describe, expect, it } from 'vitest';
import {
  COMPATIBILITY_ENGINE_VERSION,
  compatibilityInputDigest,
  evaluateCompatibility,
  exactMatchInput,
  fixtureGoverningPolicy,
} from '../src/index.js';

describe('T-025 exact manufacturer part allow', () => {
  it('returns ALLOW with the satisfied checks, no missing fields and the exact input digest', () => {
    const input = exactMatchInput();
    const policy = fixtureGoverningPolicy();
    const r = evaluateCompatibility(input, policy);
    expect(r.decision).toBe('ALLOW');
    expect(r.reasonCodes).toEqual([
      'APPROVED_VENDOR',
      'ASSET_IDENTITY_RESOLVED',
      'CERTIFICATION_SATISFIED',
      'ELECTRICAL_CONSTRAINTS_SATISFIED',
      'EXACT_OEM_MATCH',
      'MECHANICAL_CONSTRAINTS_SATISFIED',
      'OFFER_FRESH',
      'WARRANTY_COMPATIBLE',
    ]);
    expect(r.blockingReasons).toEqual([]);
    expect(r.missingFields).toEqual([]);
    expect(r.conflictingFields).toEqual([]);
    expect(r.requiredAuthorities).toEqual([]);
    expect(r.exactMatch).toBe(true);
    expect(r.safetyClass).toBe('STANDARD');
    expect(r.ruleVersion).toBe(COMPATIBILITY_ENGINE_VERSION);
    expect(r.inputDigest).toBe(compatibilityInputDigest(input, policy));
    expect(r.inputDigest).toMatch(/^compatibility-input\.v1:sha256:[0-9a-f]{64}$/);
    expect(r.approvalRoute).toEqual({
      outcome: 'AUTO_PERMITTED',
      requirements: [],
      reasonCodes: ['WITHIN_AUTO_PERMIT'],
    });
  });

  it('is deterministic: the same input and policy always give the same result', () => {
    const a = evaluateCompatibility(exactMatchInput(), fixtureGoverningPolicy());
    const b = evaluateCompatibility(exactMatchInput(), fixtureGoverningPolicy());
    expect(b).toEqual(a);
  });

  it('normalizes part numbers and manufacturers exactly (case and surrounding space), never fuzzily', () => {
    const input = exactMatchInput();
    input.candidate.partNumber = '  5a1-0402 ';
    input.candidate.manufacturer = 'NORTHWIND refrigeration';
    expect(evaluateCompatibility(input, fixtureGoverningPolicy()).decision).toBe('ALLOW');
    const near = exactMatchInput();
    near.candidate.partNumber = '5A1-0402A';
    expect(evaluateCompatibility(near, fixtureGoverningPolicy()).decision).not.toBe('ALLOW');
    const spaced = exactMatchInput();
    spaced.candidate.partNumber = '5A1 0402';
    expect(evaluateCompatibility(spaced, fixtureGoverningPolicy()).decision).not.toBe('ALLOW');
  });

  it('model confidence, search rank and seller claims are explanation only (digest and decision unchanged)', () => {
    const policy = fixtureGoverningPolicy();
    const base = evaluateCompatibility(exactMatchInput(), policy);
    for (const explanation of [
      {
        origin: 'MODEL_PROPOSAL' as const,
        modelConfidencePpm: 0,
        searchRank: 50,
        semanticScorePpm: 1,
        sellerClaim: null,
      },
      {
        origin: 'PROVIDER_OFFER' as const,
        modelConfidencePpm: 1_000_000,
        searchRank: 1,
        semanticScorePpm: 1_000_000,
        sellerClaim: 'Guaranteed compatible',
      },
    ]) {
      const r = evaluateCompatibility(exactMatchInput(), policy, { explanation });
      expect(r.decision).toBe(base.decision);
      expect(r.inputDigest).toBe(base.inputDigest);
      expect(r.reasonCodes).toEqual(base.reasonCodes);
      expect(r.explanation).toEqual({ ...explanation, authority: 'NONE' });
    }
  });

  it('the input digest binds every decision-relevant field and the governing policy revision', () => {
    const policy = fixtureGoverningPolicy();
    const base = compatibilityInputDigest(exactMatchInput(), policy);
    const changed = exactMatchInput();
    changed.binding.actionDigest = `action.v1:sha256:${'b'.repeat(64)}` as never;
    expect(compatibilityInputDigest(changed, policy)).not.toBe(base);
    expect(
      compatibilityInputDigest(
        exactMatchInput(),
        fixtureGoverningPolicy({ bodyDigest: `policy.v1:sha256:${'c'.repeat(64)}` }),
      ),
    ).not.toBe(base);
  });
});
