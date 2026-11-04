// T-026 — Ambiguous compatibility hold (FR-06, INV-02, INV-04). Missing, semantic-only, seller-authored, stale or
// conflicting compatibility evidence returns HOLD or REJECT and never ALLOW. A case table names the expected
// decision and reason for each single defect; a seeded property run combines defects (and maximal model confidence)
// and asserts that no combination is ever ALLOW. Every HOLD names its missing or conflicting evidence or the
// authorized recovery path. Policy authoring validation refuses policies that would make seller or model evidence
// authoritative.
import { describe, expect, it } from 'vitest';
import {
  evaluateCompatibility,
  requiredCertificationsFor,
  exactMatchInput,
  fixtureFact,
  fixtureGoverningPolicy,
  fixtureSource,
  validateCompatibilityPolicy,
  type CompatibilityInput,
  type GoverningPolicy,
} from '../src/index.js';

type Mutation = (i: CompatibilityInput, p: GoverningPolicy) => void;

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const ago = (ms: number) => new Date(T0 - ms).toISOString() as never;

const CASES: [string, Mutation, 'HOLD' | 'REJECT', string][] = [
  ['required OEM part missing', (i) => void (i.facts.requiredPart = { values: [] }), 'HOLD', 'MISSING_EXACT_MPN'],
  [
    'conflicting manuals on the OEM part',
    (i) =>
      void (i.facts.requiredPart = { values: [...i.facts.requiredPart.values, ...fixtureFact('5A1-0398').values] }),
    'HOLD',
    'CONFLICTING_MANUALS',
  ],
  [
    'OEM part only from seller text',
    (i) =>
      void (i.facts.requiredPart = fixtureFact(
        '5A1-0402',
        fixtureSource({
          sourceKind: 'PROVIDER_DOCUMENT',
          trustLevel: 'PROVIDER_REPORTED',
          basis: 'SELLER_TEXT',
          role: 'OTHER',
        }),
      )),
    'HOLD',
    'SELLER_AUTHORED_EVIDENCE',
  ],
  [
    'OEM part only from a semantic match',
    (i) => void (i.facts.requiredPart = fixtureFact('5A1-0402', fixtureSource({ basis: 'SEMANTIC_MATCH' }))),
    'HOLD',
    'SEMANTIC_EVIDENCE_ONLY',
  ],
  [
    'OEM part only from model extraction',
    (i) => void (i.facts.requiredPart = fixtureFact('5A1-0402', fixtureSource({ basis: 'MODEL_EXTRACTION' }))),
    'HOLD',
    'SEMANTIC_EVIDENCE_ONLY',
  ],
  [
    'OEM part only from a provider-reported OEM document',
    (i) => void (i.facts.requiredPart = fixtureFact('5A1-0402', fixtureSource({ trustLevel: 'PROVIDER_REPORTED' }))),
    'HOLD',
    'NON_AUTHORITATIVE_SOURCE',
  ],
  [
    'OEM part only from service history',
    (i) =>
      void (i.facts.requiredPart = fixtureFact(
        '5A1-0402',
        fixtureSource({ role: 'WORK_ORDER', sourceKind: 'SERVICE_HISTORY' }),
      )),
    'HOLD',
    'NON_AUTHORITATIVE_SOURCE',
  ],
  [
    'OEM part source observed in the future',
    (i) => void (i.facts.requiredPart = fixtureFact('5A1-0402', fixtureSource({ observedAt: ago(-60_000) }))),
    'HOLD',
    'NON_AUTHORITATIVE_SOURCE',
  ],
  ['candidate part number missing', (i) => void (i.candidate.partNumber = null), 'HOLD', 'MISSING_EXACT_MPN'],
  ['candidate manufacturer missing', (i) => void (i.candidate.manufacturer = null), 'HOLD', 'MISSING_EXACT_MPN'],
  [
    'evidence revision superseded',
    (i) => void (i.state.evidenceRevisionCurrent = false),
    'HOLD',
    'EVIDENCE_REVISION_NOT_CURRENT',
  ],
  [
    'policy revision not effective',
    (i) => void (i.state.policyRevisionEffective = false),
    'HOLD',
    'POLICY_REVISION_NOT_EFFECTIVE',
  ],
  [
    'policy revision differs from the binding',
    (i) => void (i.binding.policyRevisionId = 'pol_fixture-other' as never),
    'HOLD',
    'POLICY_REVISION_NOT_EFFECTIVE',
  ],
  [
    'asset revision superseded',
    (i) => void (i.state.assetRevisionCurrent = false),
    'HOLD',
    'ASSET_REVISION_SUPERSEDED',
  ],
  ['asset serial unknown', (i) => void (i.asset.serial = null), 'HOLD', 'ASSET_IDENTITY_UNRESOLVED'],
  ['asset BOM revision unknown', (i) => void (i.asset.bomRevision = null), 'HOLD', 'ASSET_IDENTITY_UNRESOLVED'],
  [
    'evidence bound to another asset revision',
    (i) => void (i.state.evidenceAssetRevisionId = 'arv_fixture-other' as never),
    'HOLD',
    'ASSET_IDENTITY_UNRESOLVED',
  ],
  [
    'mandatory electrical constraint missing',
    (i) => void (i.facts.requiredConstraints = i.facts.requiredConstraints.filter((c) => c.key !== 'rated-voltage')),
    'HOLD',
    'MISSING_CONSTRAINT_EVIDENCE',
  ],
  [
    'mandatory constraint conflicting',
    (i) => {
      const c = i.facts.requiredConstraints.find((x) => x.key === 'frequency')!;
      c.fact = { values: [...c.fact.values, ...fixtureFact('50 Hz').values] };
    },
    'HOLD',
    'CONFLICTING_MANUALS',
  ],
  [
    'mandatory constraint from seller text only',
    (i) => {
      const c = i.facts.requiredConstraints.find((x) => x.key === 'refrigerant')!;
      c.fact = fixtureFact(
        'R-290',
        fixtureSource({ sourceKind: 'COMMUNICATION', basis: 'SELLER_TEXT', role: 'TRANSCRIPT' }),
      );
    },
    'HOLD',
    'SELLER_AUTHORED_EVIDENCE',
  ],
  [
    'candidate claims a different voltage',
    (i) => void i.facts.candidateConstraints.push({ key: 'rated-voltage', fact: fixtureFact('230 V') }),
    'REJECT',
    'KNOWN_INCOMPATIBILITY',
  ],
  [
    'seller claims a different refrigerant',
    (i) =>
      void i.facts.candidateConstraints.push({
        key: 'refrigerant',
        fact: fixtureFact('R-134a', fixtureSource({ sourceKind: 'PROVIDER_DOCUMENT', basis: 'SELLER_TEXT' })),
      }),
    'REJECT',
    'KNOWN_INCOMPATIBILITY',
  ],
  ['required certification missing', (i) => void (i.facts.certifications = []), 'HOLD', 'MISSING_CERTIFICATION'],
  [
    'certification only seller-authored',
    (i) =>
      void (i.facts.certifications = [
        {
          code: 'UL 471',
          fact: fixtureFact('CERTIFIED', fixtureSource({ sourceKind: 'PROVIDER_DOCUMENT', basis: 'SELLER_TEXT' })),
        },
      ]),
    'HOLD',
    'MISSING_CERTIFICATION',
  ],
  [
    'certification authoritatively absent',
    (i) => void (i.facts.certifications = [{ code: 'UL 471', fact: fixtureFact('NOT_CERTIFIED') }]),
    'REJECT',
    'CERTIFICATION_ABSENT',
  ],
  ['warranty status unknown', (i) => void (i.facts.warranty = { values: [] }), 'HOLD', 'WARRANTY_STATUS_UNKNOWN'],
  [
    'vendor not approved',
    (i) =>
      void (i.facts.vendor = fixtureFact(
        'NOT_APPROVED',
        fixtureSource({
          role: 'VENDOR_RECORD',
          sourceKind: 'REGISTRY_SNAPSHOT',
          basis: 'STRUCTURED_RECORD',
          trustLevel: 'OPERATOR_ATTESTED',
        }),
      )),
    'HOLD',
    'VENDOR_NOT_APPROVED',
  ],
  ['vendor unknown', (i) => void (i.facts.vendor = { values: [] }), 'HOLD', 'VENDOR_STATUS_UNKNOWN'],
  ['no vendor named', (i) => void (i.candidate.vendorId = null), 'HOLD', 'VENDOR_STATUS_UNKNOWN'],
  [
    'stale price/stock snapshot',
    (i) => void (i.candidate.offerObservedAt = ago(25 * 3_600_000)),
    'HOLD',
    'STALE_PRICE_OR_STOCK',
  ],
  ['offer snapshot missing', (i) => void (i.candidate.offerObservedAt = null), 'HOLD', 'STALE_PRICE_OR_STOCK'],
  [
    'offer snapshot from the future',
    (i) => void (i.candidate.offerObservedAt = ago(-3_600_000)),
    'HOLD',
    'STALE_PRICE_OR_STOCK',
  ],
  ['substitute part number', (i) => void (i.candidate.partNumber = '5A1-0398'), 'HOLD', 'UNSUPPORTED_SUBSTITUTE'],
  [
    'non-OEM manufacturer for the OEM number',
    (i) => void (i.candidate.manufacturer = 'Coldline Generic'),
    'HOLD',
    'NON_EXACT_MATCH',
  ],
  [
    'substitution forbidden by policy',
    (i, p) => {
      i.candidate.partNumber = '5A1-0398';
      p.compatibility!.substitution = { mode: 'FORBIDDEN' };
    },
    'REJECT',
    'SUBSTITUTION_FORBIDDEN',
  ],
  ['safety-critical component', (i) => void (i.candidate.component = 'compressor'), 'HOLD', 'SAFETY_CLASSIFICATION'],
  ['safety-critical asset', (i) => void (i.asset.safetyClass = 'SAFETY_CRITICAL'), 'HOLD', 'SAFETY_CLASSIFICATION'],
  ['unknown asset safety class', (i) => void (i.asset.safetyClass = 'UNCLASSIFIED'), 'HOLD', 'SAFETY_CLASSIFICATION'],
  [
    'prohibited intervention',
    (i) => void (i.candidate.component = 'refrigerant-circuit'),
    'REJECT',
    'SAFETY_PROHIBITED',
  ],
  ['policy without compatibility rules', (_i, p) => void (p.compatibility = null), 'HOLD', 'POLICY_RULES_MISSING'],
];

const fresh = () => ({ input: exactMatchInput(), policy: fixtureGoverningPolicy() });

describe('T-026 ambiguous compatibility hold', () => {
  it.each(CASES)('%s → never ALLOW', (_name, mutate, expected, reason) => {
    const { input, policy } = fresh();
    mutate(input, policy);
    const r = evaluateCompatibility(input, policy, {
      explanation: {
        origin: 'MODEL_PROPOSAL',
        modelConfidencePpm: 1_000_000,
        searchRank: 1,
        semanticScorePpm: 1_000_000,
        sellerClaim: 'OEM equivalent, guaranteed fit',
      },
    });
    expect(r.decision).toBe(expected);
    expect(r.blockingReasons).toContain(reason);
    expect(r.reasonCodes).toEqual(r.blockingReasons);
    if (r.decision === 'HOLD') expect(r.recoveryPaths.length).toBeGreaterThan(0);
  });

  it('names the missing and conflicting fields', () => {
    const { input, policy } = fresh();
    input.facts.requiredPart = { values: [...input.facts.requiredPart.values, ...fixtureFact('5A1-0398').values] };
    input.facts.certifications = [];
    input.asset.serial = null;
    const r = evaluateCompatibility(input, policy);
    expect(r.conflictingFields).toContain('part:evaporator-fan-motor');
    expect(r.missingFields).toEqual(expect.arrayContaining(['asset.serial', 'certification:UL 471']));
    expect(r.recoveryPaths).toEqual(expect.arrayContaining(['NEW_EVIDENCE_REVISION']));
  });

  it('property: no combination of defects is ever ALLOW, however confident the model is', () => {
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let nonAllow = 0;
    for (let n = 0; n < 400; n++) {
      const { input, policy } = fresh();
      const picks = CASES.filter(() => rand() < 0.12);
      if (picks.length === 0) picks.push(CASES[Math.floor(rand() * CASES.length)]!);
      for (const [, m] of picks) m(input, policy);
      const r = evaluateCompatibility(input, policy, {
        explanation: {
          origin: 'MODEL_PROPOSAL',
          modelConfidencePpm: 1_000_000,
          searchRank: 1,
          semanticScorePpm: 1_000_000,
          sellerClaim: null,
        },
      });
      expect(r.decision, picks.map((p) => p[0]).join(' + ')).not.toBe('ALLOW');
      // Mutations interact (e.g. no policy rules, or no candidate part number to compare), so a combined REJECT case
      // may surface as HOLD; the property is only that the outcome is fail-closed.
      expect(['HOLD', 'REJECT']).toContain(r.decision);
      nonAllow++;
    }
    expect(nonAllow).toBe(400);
  });

  it('policy validation refuses seller, model or provider-reported evidence as authoritative', () => {
    const p = fixtureGoverningPolicy().compatibility!;
    const withSource = (extra: Record<string, unknown>) => ({
      ...p,
      authoritativeSources: [...p.authoritativeSources, { category: 'PART_IDENTITY', roles: ['OTHER'], ...extra }],
    });
    expect(validateCompatibilityPolicy(p).ok).toBe(true);
    for (const bad of [
      withSource({ sourceKinds: ['PROVIDER_DOCUMENT'], trustLevels: ['OPERATOR_ATTESTED'] }),
      withSource({ sourceKinds: ['COMMUNICATION'], trustLevels: ['OPERATOR_ATTESTED'] }),
      withSource({ sourceKinds: ['OEM_PUBLICATION'], trustLevels: ['PROVIDER_REPORTED'] }),
      { ...p, authoritativeSources: [] },
      { ...p, overridableReasons: ['KNOWN_INCOMPATIBILITY'] },
      { ...p, overridableReasons: ['UNSUPPORTED_SUBSTITUTE'] },
      { ...p, mandatoryConstraints: [p.mandatoryConstraints[0], p.mandatoryConstraints[0]] },
      { ...p, authorityMaxTtlMs: 0 },
      { ...p, unknownCatchAll: 'ALLOW' },
    ]) {
      const v = validateCompatibilityPolicy(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.issues.length).toBeGreaterThan(0);
    }
  });

  it('security review: one canonical component key drives classification and certification scoping', () => {
    const scoped = () => {
      const p = fixtureGoverningPolicy();
      p.compatibility!.requiredCertifications = [{ code: 'UL 471', components: ['compressor'] }];
      return p;
    };
    // Keys that pass the character pattern but change under canonicalization are refused, never compared raw.
    for (const variant of ['compressor-', 'compressor--relay', '-compressor']) {
      const i = exactMatchInput();
      i.candidate.component = variant;
      i.facts.certifications = [];
      expect(() => evaluateCompatibility(i, scoped()), variant).toThrow();
      const v = validateCompatibilityPolicy({
        ...scoped().compatibility!,
        requiredCertifications: [{ code: 'UL 471', components: [variant] }],
      });
      expect(v.ok, variant).toBe(false);
    }
    // Scoping helpers canonicalize both sides, so a case/whitespace variant still requires the certification.
    for (const variant of ['compressor', 'Compressor ', ' COMPRESSOR', 'compressor-'])
      expect(
        requiredCertificationsFor(variant, scoped().compatibility!).map((c) => c.code),
        variant,
      ).toEqual(['UL 471']);
    const i = exactMatchInput();
    i.candidate.component = 'compressor';
    i.facts.certifications = [];
    const r = evaluateCompatibility(i, scoped());
    expect(r.blockingReasons).toContain('MISSING_CERTIFICATION');
    expect(r.missingFields).toContain('certification:UL 471');
  });
});
