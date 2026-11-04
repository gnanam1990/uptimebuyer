// Deterministic decision fixtures (M06 scope item 6): a complete exact-match input for the fictional Northwind
// NWR-2D-48 evaporator fan motor, a governing policy, and builders for sources and facts. Every builder returns a
// fresh object so callers may mutate it. These are synthetic: no real OEM data, vendor or person. Signed authority
// fixtures are test-only (no signer with a known key ships here). Downstream modules (M08 planning, M13 UI) use them
// to exercise ALLOW/HOLD/REJECT rendering.
import type { UtcInstant } from '@uptimebuyer/contracts';
import type { CompatibilityInput, Fact, FactSource } from './input.js';
import type { CompatibilityPolicy, GoverningPolicy } from './policy.js';

export const FIXTURE_EVALUATED_AT = '2026-11-01T12:00:00.000Z' as UtcInstant;
export const FIXTURE_IDS = Object.freeze({
  tenantId: 'ten_fixture-0001',
  siteId: 'sit_fixture-0001',
  incidentId: 'inc_fixture-0001',
  candidateActionId: 'cand_fixture-0001',
  assetRevisionId: 'arv_fixture-0001',
  evidenceRevisionId: 'evr_fixture-0001',
  policyRevisionId: 'pol_fixture-0001',
});
const DAY = 86_400_000;

export function fixtureSource(over: Partial<FactSource> = {}): FactSource {
  return {
    ref: 'doc_fixture-manual',
    role: 'MANUAL',
    sourceKind: 'OEM_PUBLICATION',
    trustLevel: 'OPERATOR_ATTESTED',
    basis: 'EXACT_EXTRACTION',
    observedAt: '2026-10-31T12:00:00.000Z' as UtcInstant,
    ...over,
  };
}

export function fixtureFact(value: string, ...sources: FactSource[]): Fact {
  return { values: [{ value, sources: sources.length > 0 ? sources : [fixtureSource()] }] };
}

export function fixtureCompatibilityPolicy(): CompatibilityPolicy {
  return {
    schemaVersion: 1,
    ruleSet: 'fixture-cold-chain.r1',
    authoritativeSources: [
      {
        category: 'PART_IDENTITY',
        roles: ['MANUAL', 'PARTS_LIST'],
        sourceKinds: ['OEM_PUBLICATION'],
        trustLevels: ['AUTHORITATIVE', 'OPERATOR_ATTESTED'],
      },
      {
        category: 'ELECTRICAL',
        roles: ['MANUAL', 'OTHER'],
        sourceKinds: ['OEM_PUBLICATION'],
        trustLevels: ['AUTHORITATIVE', 'OPERATOR_ATTESTED'],
      },
      {
        category: 'MECHANICAL',
        roles: ['MANUAL', 'OTHER'],
        sourceKinds: ['OEM_PUBLICATION'],
        trustLevels: ['AUTHORITATIVE', 'OPERATOR_ATTESTED'],
      },
      {
        category: 'CERTIFICATION',
        roles: ['MANUAL', 'OTHER'],
        sourceKinds: ['OEM_PUBLICATION'],
        trustLevels: ['AUTHORITATIVE', 'OPERATOR_ATTESTED'],
      },
      {
        category: 'WARRANTY',
        roles: ['WARRANTY'],
        sourceKinds: ['REGISTRY_SNAPSHOT'],
        trustLevels: ['OPERATOR_ATTESTED'],
      },
      {
        category: 'VENDOR',
        roles: ['VENDOR_RECORD'],
        sourceKinds: ['REGISTRY_SNAPSHOT'],
        trustLevels: ['OPERATOR_ATTESTED'],
      },
    ],
    mandatoryConstraints: [
      { key: 'rated-voltage', category: 'ELECTRICAL' },
      { key: 'frequency', category: 'ELECTRICAL' },
      { key: 'refrigerant', category: 'MECHANICAL' },
    ],
    requiredCertifications: [{ code: 'UL 471', components: null }],
    warranty: { statusRequired: true },
    substitution: { mode: 'ENGINEER_EXCEPTION' },
    safetyClasses: [
      {
        components: ['evaporator-fan-motor', 'condenser-fan-motor', 'door-gasket-left', 'defrost-thermostat'],
        actionKinds: null,
        assetSafetyClasses: null,
        safetyClass: 'STANDARD',
      },
      { components: ['compressor'], actionKinds: null, assetSafetyClasses: null, safetyClass: 'SAFETY_CRITICAL' },
      { components: ['refrigerant-circuit'], actionKinds: null, assetSafetyClasses: null, safetyClass: 'PROHIBITED' },
    ],
    overridableReasons: ['VENDOR_NOT_APPROVED', 'WARRANTY_REQUIRES_OEM_PART'],
    freshness: { maxOfferAgeMs: DAY },
    autoPermit: [{ siteIds: null, currency: 'USD', maxAmountMinor: 50_000n, actionKinds: ['PART_PURCHASE'] }],
    authorityMaxTtlMs: 3 * DAY,
  } as CompatibilityPolicy;
}

export function fixtureGoverningPolicy(
  over: Partial<Pick<GoverningPolicy, 'policyRevisionId' | 'bodyDigest' | 'approvalLimits'>> & {
    compatibility?: CompatibilityPolicy | null;
  } = {},
): GoverningPolicy & { compatibility: CompatibilityPolicy | null } {
  return {
    policyRevisionId: over.policyRevisionId ?? FIXTURE_IDS.policyRevisionId,
    bodyDigest: over.bodyDigest ?? `policy.v1:sha256:${'1'.repeat(64)}`,
    compatibility: over.compatibility === undefined ? fixtureCompatibilityPolicy() : over.compatibility,
    approvalLimits: over.approvalLimits ?? [
      {
        approvalKind: 'PLAN_ACTION',
        actionClass: 'STANDARD',
        role: 'maintenance_approver',
        currency: 'USD',
        maxAmountMinor: 500_000n,
        siteIds: null,
      },
      {
        approvalKind: 'PLAN_ACTION',
        actionClass: 'POLICY_OVERRIDE',
        role: 'maintenance_approver',
        currency: 'USD',
        maxAmountMinor: 500_000n,
        siteIds: null,
      },
      // Misconfigured: an operator row never makes an operator an approver.
      {
        approvalKind: 'PLAN_ACTION',
        actionClass: 'POLICY_OVERRIDE',
        role: 'operator',
        currency: 'USD',
        maxAmountMinor: 500_000n,
        siteIds: null,
      },
    ],
  };
}

/** The complete exact OEM match: every check passes, so the fixture decision is ALLOW. */
export function exactMatchInput(): CompatibilityInput {
  const registry = (role: 'WARRANTY' | 'VENDOR_RECORD') =>
    fixtureSource({
      ref: `doc_fixture-${role.toLowerCase()}`,
      role,
      sourceKind: 'REGISTRY_SNAPSHOT',
      basis: 'STRUCTURED_RECORD',
    });
  return {
    schemaVersion: 1,
    binding: {
      ...FIXTURE_IDS,
      actionDigest: `action.v1:sha256:${'a'.repeat(64)}`,
    } as CompatibilityInput['binding'],
    state: {
      assetRevisionCurrent: true,
      evidenceRevisionCurrent: true,
      evidenceAssetRevisionId: FIXTURE_IDS.assetRevisionId as CompatibilityInput['state']['evidenceAssetRevisionId'],
      policyRevisionEffective: true,
    },
    asset: {
      manufacturer: 'Northwind Refrigeration',
      model: 'NWR-2D-48',
      serial: 'NW48-2400001',
      bomRevision: 'BOM-7',
      safetyClass: 'STANDARD',
    },
    candidate: {
      actionKind: 'PART_PURCHASE',
      component: 'evaporator-fan-motor',
      manufacturer: 'Northwind Refrigeration',
      partNumber: '5A1-0402',
      quantity: 1,
      vendorId: 'vnd_fixture-0001',
      amount: { amountMinor: 18_500n, currency: 'USD' },
      offerObservedAt: '2026-11-01T11:00:00.000Z' as UtcInstant,
    },
    facts: {
      requiredPart: {
        values: [
          {
            value: '5A1-0402',
            sources: [fixtureSource(), fixtureSource({ ref: 'doc_fixture-bom', role: 'PARTS_LIST' })],
          },
        ],
      },
      requiredConstraints: [
        { key: 'rated-voltage', fact: fixtureFact('115 V') },
        { key: 'frequency', fact: fixtureFact('60 Hz') },
        { key: 'refrigerant', fact: fixtureFact('R-290') },
      ],
      candidateConstraints: [],
      certifications: [
        {
          code: 'UL 471',
          fact: fixtureFact(
            'CERTIFIED',
            fixtureSource({ ref: 'doc_fixture-datasheet', role: 'OTHER', basis: 'CITED_EXACT_TEXT' }),
          ),
        },
      ],
      warranty: fixtureFact('OUT_OF_WARRANTY', registry('WARRANTY')),
      vendor: fixtureFact('APPROVED', registry('VENDOR_RECORD')),
    },
    authorities: [],
    evaluatedAt: FIXTURE_EVALUATED_AT,
  };
}
