// T-027 — Substitute requires named engineer (FR-10, INV-02, INV-15). Every substitute, non-exact match or
// safety-critical intervention needs an authorized named-engineer authority record with an immutable reason, scope,
// expiry, signature and action digest; policy overrides and out-of-bounds amounts route to the approver role named
// by the governing policy revision. Wrong role, tenant, site, incident, revision, digest, expired, not-yet-valid,
// inactive or tampered records are never applied. Known incompatibility can never be overridden.
import { describe, expect, it } from 'vitest';
import {
  authoritySignatureDigest,
  classifyIntervention,
  evaluateCompatibility,
  exactMatchInput,
  fixtureAuthority,
  fixtureFact,
  fixtureGoverningPolicy,
  fixtureSource,
  verifyAuthorityRecord,
  type AuthorityRecord,
  type CompatibilityInput,
} from '../src/index.js';

const substitute = (): CompatibilityInput => {
  const i = exactMatchInput();
  i.candidate.partNumber = '5A1-0398';
  return i;
};
const vendorNotApproved = (): CompatibilityInput => {
  const i = exactMatchInput();
  i.facts.vendor = fixtureFact(
    'NOT_APPROVED',
    fixtureSource({ role: 'VENDOR_RECORD', sourceKind: 'REGISTRY_SNAPSHOT', basis: 'STRUCTURED_RECORD' }),
  );
  return i;
};
const engineer = (i: CompatibilityInput, over: Partial<AuthorityRecord> = {}) =>
  fixtureAuthority(i, { kind: 'ENGINEER_EXCEPTION', actorRole: 'engineer', exceptionClasses: ['SUBSTITUTE'], ...over });

describe('T-027 substitute requires named engineer', () => {
  it('a substitute is HOLD naming a named-engineer requirement until a valid engineer authority is evidence', () => {
    const policy = fixtureGoverningPolicy();
    const held = evaluateCompatibility(substitute(), policy);
    expect(held.decision).toBe('HOLD');
    expect(held.blockingReasons).toEqual(expect.arrayContaining(['UNSUPPORTED_SUBSTITUTE', 'NAMED_APPROVAL_REQUIRED']));
    expect(held.requiredAuthorities).toEqual([
      { kind: 'ENGINEER_EXCEPTION', roles: ['engineer'], exceptionClasses: ['SUBSTITUTE'], overriddenReasons: [] },
    ]);
    expect(held.recoveryPaths).toContain('NAMED_ENGINEER');

    const i = substitute();
    const a = engineer(i);
    i.authorities = [a];
    const r = evaluateCompatibility(i, policy);
    expect(r.decision).toBe('ALLOW');
    expect(r.appliedAuthorityIds).toEqual([a.authorityRecordId]);
    expect(r.exceptionClassesApplied).toEqual(['SUBSTITUTE']);
    expect(r.reasonCodes).toContain('ENGINEER_EXCEPTION_APPLIED');
    expect(r.inputDigest).not.toBe(held.inputDigest);
  });

  it('safety-critical work and a non-exact match each need their own engineer exception class', () => {
    const policy = fixtureGoverningPolicy();
    const i = exactMatchInput();
    i.candidate.component = 'compressor';
    i.candidate.partNumber = '5A1-0398';
    i.facts.requiredPart = fixtureFact('5A1-0401');
    i.authorities = [engineer(i, { exceptionClasses: ['SUBSTITUTE'] })];
    const partial = evaluateCompatibility(i, policy);
    expect(partial.decision).toBe('HOLD');
    expect(partial.blockingReasons).toContain('SAFETY_CLASSIFICATION');
    i.authorities = [engineer(i, { exceptionClasses: ['SAFETY_CRITICAL', 'SUBSTITUTE'] })];
    expect(evaluateCompatibility(i, policy).decision).toBe('ALLOW');
  });

  it.each<[string, (i: CompatibilityInput) => AuthorityRecord, string]>([
    ['wrong role', (i) => engineer(i, { actorRole: 'maintenance_approver' }), 'AUTHORITY_ROLE_MISMATCH'],
    ['other tenant', (i) => engineer(i, { tenantId: 'ten_fixture-other' as never }), 'AUTHORITY_SCOPE_MISMATCH'],
    ['other site', (i) => engineer(i, { siteId: 'sit_fixture-other' as never }), 'AUTHORITY_SCOPE_MISMATCH'],
    ['other incident', (i) => engineer(i, { incidentId: 'inc_fixture-other' as never }), 'AUTHORITY_SCOPE_MISMATCH'],
    [
      'other candidate',
      (i) => engineer(i, { candidateActionId: 'cand_fixture-other' as never }),
      'AUTHORITY_SCOPE_MISMATCH',
    ],
    [
      'other asset revision',
      (i) => engineer(i, { assetRevisionId: 'arv_fixture-other' as never }),
      'AUTHORITY_SCOPE_MISMATCH',
    ],
    [
      'other evidence revision',
      (i) => engineer(i, { evidenceRevisionId: 'evr_fixture-other' as never }),
      'AUTHORITY_SCOPE_MISMATCH',
    ],
    [
      'other policy revision',
      (i) => engineer(i, { policyRevisionId: 'pol_fixture-other' as never }),
      'AUTHORITY_SCOPE_MISMATCH',
    ],
    [
      'other action digest',
      (i) => engineer(i, { actionDigest: `action.v1:sha256:${'e'.repeat(64)}` as never }),
      'AUTHORITY_SCOPE_MISMATCH',
    ],
    ['expired', (i) => engineer(i, { expiresAt: '2026-11-01T11:59:59.999Z' as never }), 'AUTHORITY_EXPIRED'],
    [
      'not yet issued',
      (i) =>
        engineer(i, { issuedAt: '2026-11-01T12:00:00.001Z' as never, expiresAt: '2026-11-02T00:00:00.000Z' as never }),
      'AUTHORITY_NOT_YET_VALID',
    ],
    ['invalidated', (i) => engineer(i, { status: 'INVALIDATED' }), 'AUTHORITY_INACTIVE'],
    ['revoked', (i) => engineer(i, { status: 'REVOKED' }), 'AUTHORITY_INACTIVE'],
    ['tampered reason', (i) => ({ ...engineer(i), reasonText: 'edited after signing' }), 'AUTHORITY_SIGNATURE_INVALID'],
    [
      'tampered expiry',
      (i) => ({ ...engineer(i), expiresAt: '2030-01-01T00:00:00.000Z' as never }),
      'AUTHORITY_SIGNATURE_INVALID',
    ],
    [
      'tampered classes',
      (i) => ({ ...engineer(i, { exceptionClasses: ['NON_EXACT_MATCH'] }), exceptionClasses: ['SUBSTITUTE' as const] }),
      'AUTHORITY_SIGNATURE_INVALID',
    ],
    [
      'lifetime beyond policy',
      (i) => engineer(i, { expiresAt: '2026-11-09T12:00:00.000Z' as never }),
      'AUTHORITY_TTL_EXCEEDED',
    ],
  ])('%s → not applied, still HOLD', (_name, make, reason) => {
    const policy = fixtureGoverningPolicy();
    const i = substitute();
    const a = make(i);
    i.authorities = [a];
    const r = evaluateCompatibility(i, policy);
    expect(r.decision).toBe('HOLD');
    expect(r.appliedAuthorityIds).toEqual([]);
    expect(r.authorityFindings).toEqual([{ authorityRecordId: a.authorityRecordId, reasonCode: reason }]);
    expect(verifyAuthorityRecord(a, i, policy)).toEqual({ valid: false, reasonCode: reason });
  });

  it('a policy override routes only to the approver role the policy names for that amount, site and class', () => {
    const policy = fixtureGoverningPolicy();
    const held = evaluateCompatibility(vendorNotApproved(), policy);
    expect(held.decision).toBe('HOLD');
    expect(held.requiredAuthorities).toEqual([
      {
        kind: 'POLICY_APPROVAL',
        roles: ['maintenance_approver'],
        exceptionClasses: [],
        overriddenReasons: ['VENDOR_NOT_APPROVED'],
      },
    ]);
    const approve = (i: CompatibilityInput, over: Partial<AuthorityRecord> = {}) =>
      fixtureAuthority(i, {
        kind: 'POLICY_APPROVAL',
        actorRole: 'maintenance_approver',
        overriddenReasons: ['VENDOR_NOT_APPROVED'],
        ...over,
      });

    const ok = vendorNotApproved();
    ok.authorities = [approve(ok)];
    const allowed = evaluateCompatibility(ok, policy);
    expect(allowed.decision).toBe('ALLOW');
    expect(allowed.reasonCodes).toContain('POLICY_OVERRIDE_APPLIED');

    // An engineer is not the policy-named approver for an override.
    const eng = vendorNotApproved();
    eng.authorities = [approve(eng, { actorRole: 'engineer' })];
    expect(evaluateCompatibility(eng, policy).authorityFindings[0]?.reasonCode).toBe('AUTHORITY_ROLE_MISMATCH');

    // finance_approver is not named; above the named role's amount bound nobody is.
    const fin = vendorNotApproved();
    fin.authorities = [approve(fin, { actorRole: 'finance_approver' })];
    expect(evaluateCompatibility(fin, policy).decision).toBe('HOLD');
    const big = vendorNotApproved();
    big.candidate.amount = { amountMinor: 900_000n, currency: 'USD' } as never;
    big.authorities = [approve(big)];
    const bigR = evaluateCompatibility(big, policy);
    expect(bigR.decision).toBe('HOLD');
    expect(bigR.authorityFindings[0]?.reasonCode).toBe('AUTHORITY_ROLE_MISMATCH');
  });

  it('an engineer cannot override policy, an approver cannot approve a substitute, nobody overrides incompatibility', () => {
    const policy = fixtureGoverningPolicy();
    const v = vendorNotApproved();
    v.authorities = [engineer(v, { exceptionClasses: ['SUBSTITUTE'] })];
    expect(evaluateCompatibility(v, policy).decision).toBe('HOLD');

    const s = substitute();
    s.authorities = [
      fixtureAuthority(s, {
        kind: 'POLICY_APPROVAL',
        actorRole: 'maintenance_approver',
        overriddenReasons: ['VENDOR_NOT_APPROVED'],
      }),
    ];
    expect(evaluateCompatibility(s, policy).decision).toBe('HOLD');

    const bad = substitute();
    bad.facts.candidateConstraints.push({ key: 'rated-voltage', fact: fixtureFact('230 V') });
    bad.authorities = [engineer(bad)];
    const r = evaluateCompatibility(bad, policy);
    expect(r.decision).toBe('REJECT');
    expect(r.blockingReasons).toContain('KNOWN_INCOMPATIBILITY');
  });

  it('the signature digest binds reason, scope, expiry, actor, role and action digest', () => {
    const i = substitute();
    const a = engineer(i);
    expect(a.signatureDigest).toBe(authoritySignatureDigest(a));
    expect(a.signatureDigest).toMatch(/^compatibility-authority\.v1:sha256:[0-9a-f]{64}$/);
    for (const field of [
      'reasonCode',
      'reasonText',
      'actorUserId',
      'actorRole',
      'actionDigest',
      'expiresAt',
      'siteId',
    ] as const) {
      const changed = {
        ...a,
        [field]:
          field === 'actionDigest'
            ? `action.v1:sha256:${'f'.repeat(64)}`
            : field.endsWith('At')
              ? '2026-11-02T01:00:00.000Z'
              : `${a[field]}x`,
      };
      expect(authoritySignatureDigest(changed as AuthorityRecord), field).not.toBe(a.signatureDigest);
    }
  });

  it('approval routing: amount bounds, substitution and safety class decide the required authority', () => {
    const policy = fixtureGoverningPolicy();
    const over = exactMatchInput();
    over.candidate.amount = { amountMinor: 75_000n, currency: 'USD' } as never;
    expect(evaluateCompatibility(over, policy).approvalRoute).toEqual({
      outcome: 'REQUIRES_APPROVAL',
      requirements: [
        { kind: 'POLICY_APPROVAL', roles: ['maintenance_approver'], scope: 'AMOUNT_OUT_OF_BOUNDS', satisfied: false },
      ],
      reasonCodes: ['AMOUNT_OUT_OF_BOUNDS'],
    });
    const beyond = exactMatchInput();
    beyond.candidate.amount = { amountMinor: 900_000n, currency: 'USD' } as never;
    expect(evaluateCompatibility(beyond, policy).approvalRoute).toEqual({
      outcome: 'REJECT',
      requirements: [],
      reasonCodes: ['NO_APPROVER_ROUTE'],
    });
    const eur = exactMatchInput();
    eur.candidate.amount = { amountMinor: 100n, currency: 'EUR' } as never;
    expect(evaluateCompatibility(eur, policy).approvalRoute.outcome).toBe('REJECT');

    const held = evaluateCompatibility(substitute(), policy).approvalRoute;
    expect(held.outcome).toBe('REQUIRES_APPROVAL');
    expect(held.requirements).toContainEqual({
      kind: 'ENGINEER_EXCEPTION',
      roles: ['engineer'],
      scope: 'COMPATIBILITY_EXCEPTION',
      satisfied: false,
    });

    const i = substitute();
    i.authorities = [engineer(i)];
    const satisfied = evaluateCompatibility(i, policy).approvalRoute;
    expect(satisfied.requirements).toContainEqual({
      kind: 'ENGINEER_EXCEPTION',
      roles: ['engineer'],
      scope: 'COMPATIBILITY_EXCEPTION',
      satisfied: true,
    });
    expect(satisfied.outcome).toBe('AUTO_PERMITTED');
  });

  it('safety classification only ever raises the asset floor and treats unknown classes as safety-critical', () => {
    const policy = fixtureGoverningPolicy().compatibility!;
    const c = (assetSafetyClass: string, component: string) =>
      classifyIntervention({ assetSafetyClass, actionKind: 'PART_PURCHASE', component }, policy);
    expect(c('STANDARD', 'evaporator-fan-motor')).toBe('STANDARD');
    expect(c('ELEVATED', 'evaporator-fan-motor')).toBe('SAFETY_CRITICAL');
    expect(c('SAFETY_CRITICAL', 'evaporator-fan-motor')).toBe('SAFETY_CRITICAL');
    expect(c('NEW_CLASS', 'evaporator-fan-motor')).toBe('SAFETY_CRITICAL');
    expect(c('STANDARD', 'compressor')).toBe('SAFETY_CRITICAL');
    expect(c('SAFETY_CRITICAL', 'refrigerant-circuit')).toBe('PROHIBITED');
    const lowering = {
      ...policy,
      safetyClasses: [
        { components: null, actionKinds: null, assetSafetyClasses: null, safetyClass: 'STANDARD' as const },
      ],
    };
    expect(
      classifyIntervention(
        { assetSafetyClass: 'SAFETY_CRITICAL', actionKind: 'PART_PURCHASE', component: 'x' },
        lowering,
      ),
    ).toBe('SAFETY_CRITICAL');
  });
});
