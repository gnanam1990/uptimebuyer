// T-027 — Substitute requires named engineer (FR-10, INV-02, INV-15). Every substitute, non-exact match or
// safety-critical intervention needs an authorized named-engineer authority record with an immutable reason, scope,
// expiry, signature and action digest; policy overrides and out-of-bounds amounts route to the approver role named
// by the governing policy revision. Wrong role, tenant, site, incident, revision, digest, expired, not-yet-valid,
// inactive or tampered records are never applied. Known incompatibility can never be overridden.
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as domain from '../src/index.js';
import {
  classifyIntervention,
  evaluateCompatibility as evaluateUnkeyed,
  exactMatchInput,
  fixtureFact,
  fixtureGoverningPolicy,
  fixtureSource,
  signAuthorityRecord,
  validateCompatibilityPolicy,
  verifyAuthorityRecord,
  type AuthorityRecord,
  type CompatibilityInput,
  type GoverningPolicy,
} from '../src/index.js';
import {
  FIXTURE_KEYRING,
  FIXTURE_KEY_ID,
  fixtureAuthority,
  held as evidence,
  unsignedAuthority,
} from './authority-fixtures.js';

/** The server evaluates with its keyring; the pure function never trusts a signature it cannot verify. */
const evaluateCompatibility = (i: CompatibilityInput, p: GoverningPolicy) =>
  evaluateUnkeyed(i, p, { keyring: FIXTURE_KEYRING });

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
const engineer = (i: CompatibilityInput, over: Partial<Omit<AuthorityRecord, 'signature'>> = {}) =>
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
    i.authorities = [evidence(a)];
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
    i.authorities = [evidence(engineer(i, { exceptionClasses: ['SUBSTITUTE'] }))];
    const partial = evaluateCompatibility(i, policy);
    expect(partial.decision).toBe('HOLD');
    expect(partial.blockingReasons).toContain('SAFETY_CLASSIFICATION');
    i.authorities = [evidence(engineer(i, { exceptionClasses: ['SAFETY_CRITICAL', 'SUBSTITUTE'] }))];
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
    i.authorities = [evidence(a)];
    const r = evaluateCompatibility(i, policy);
    expect(r.decision).toBe('HOLD');
    expect(r.appliedAuthorityIds).toEqual([]);
    expect(r.authorityFindings).toEqual([{ authorityRecordId: a.authorityRecordId, reasonCode: reason }]);
    expect(verifyAuthorityRecord(evidence(a), i, policy, FIXTURE_KEYRING)).toEqual({
      valid: false,
      reasonCode: reason,
    });
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
    const approve = (i: CompatibilityInput, over: Partial<Omit<AuthorityRecord, 'signature'>> = {}) =>
      fixtureAuthority(i, {
        kind: 'POLICY_APPROVAL',
        actorRole: 'maintenance_approver',
        overriddenReasons: ['VENDOR_NOT_APPROVED'],
        ...over,
      });

    const ok = vendorNotApproved();
    ok.authorities = [evidence(approve(ok))];
    const allowed = evaluateCompatibility(ok, policy);
    expect(allowed.decision).toBe('ALLOW');
    expect(allowed.reasonCodes).toContain('POLICY_OVERRIDE_APPLIED');

    // An engineer is not the policy-named approver for an override.
    const eng = vendorNotApproved();
    eng.authorities = [evidence(approve(eng, { actorRole: 'engineer' }))];
    expect(evaluateCompatibility(eng, policy).authorityFindings[0]?.reasonCode).toBe('AUTHORITY_ROLE_MISMATCH');

    // finance_approver is not named; above the named role's amount bound nobody is.
    const fin = vendorNotApproved();
    fin.authorities = [evidence(approve(fin, { actorRole: 'finance_approver' }))];
    expect(evaluateCompatibility(fin, policy).decision).toBe('HOLD');
    const big = vendorNotApproved();
    big.candidate.amount = { amountMinor: 900_000n, currency: 'USD' } as never;
    big.authorities = [evidence(approve(big))];
    const bigR = evaluateCompatibility(big, policy);
    expect(bigR.decision).toBe('HOLD');
    expect(bigR.authorityFindings[0]?.reasonCode).toBe('AUTHORITY_ROLE_MISMATCH');
  });

  it('an engineer cannot override policy, an approver cannot approve a substitute, nobody overrides incompatibility', () => {
    const policy = fixtureGoverningPolicy();
    const v = vendorNotApproved();
    v.authorities = [evidence(engineer(v, { exceptionClasses: ['SUBSTITUTE'] }))];
    expect(evaluateCompatibility(v, policy).decision).toBe('HOLD');

    const s = substitute();
    s.authorities = [
      evidence(
        fixtureAuthority(s, {
          kind: 'POLICY_APPROVAL',
          actorRole: 'maintenance_approver',
          overriddenReasons: ['VENDOR_NOT_APPROVED'],
        }),
      ),
    ];
    expect(evaluateCompatibility(s, policy).decision).toBe('HOLD');

    const bad = substitute();
    bad.facts.candidateConstraints.push({ key: 'rated-voltage', fact: fixtureFact('230 V') });
    bad.authorities = [evidence(engineer(bad))];
    const r = evaluateCompatibility(bad, policy);
    expect(r.decision).toBe('REJECT');
    expect(r.blockingReasons).toContain('KNOWN_INCOMPATIBILITY');
  });

  it('the keyed signature binds reason, scope, expiry, actor, role and action digest', () => {
    const i = substitute();
    const a = engineer(i);
    expect(a.signature).toMatchObject({ algorithm: 'HMAC-SHA256', keyId: FIXTURE_KEY_ID });
    expect(a.signature.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
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
      } as AuthorityRecord;
      expect(verifyAuthorityRecord(evidence(changed), i, fixtureGoverningPolicy(), FIXTURE_KEYRING), field).toEqual({
        valid: false,
        reasonCode: 'AUTHORITY_SIGNATURE_INVALID',
      });
    }
  });

  it('security review: a forged or unverifiable signature, an unheld or revoked role and a foreign signer are rejected', () => {
    const policy = fixtureGoverningPolicy();
    const reject = (
      make: (i: CompatibilityInput) => CompatibilityInput['authorities'][number],
      reason: string,
      keyed = true,
    ) => {
      const i = substitute();
      const e = make(i);
      i.authorities = [e];
      const r = keyed ? evaluateCompatibility(i, policy) : evaluateUnkeyed(i, policy);
      expect(r.decision, reason).toBe('HOLD');
      expect(r.authorityFindings, reason).toEqual([
        { authorityRecordId: e.record.authorityRecordId, reasonCode: reason },
      ]);
    };
    // Anyone can recompute a plain hash: a digest-shaped value is not a signature.
    reject((i) => {
      const u = unsignedAuthority(i, { exceptionClasses: ['SUBSTITUTE'] });
      const value = createHash('sha256').update(JSON.stringify(u)).digest('base64url');
      return evidence({
        ...u,
        signature: { algorithm: 'HMAC-SHA256', keyId: FIXTURE_KEY_ID, value },
      } as AuthorityRecord);
    }, 'AUTHORITY_SIGNATURE_INVALID');
    // Signed with an attacker's key under the server's key id, or under an unknown key id.
    reject(
      (i) => evidence(fixtureAuthority(i, { exceptionClasses: ['SUBSTITUTE'] }, new Uint8Array(randomBytes(32)))),
      'AUTHORITY_SIGNATURE_INVALID',
    );
    reject(
      (i) =>
        evidence(
          fixtureAuthority(i, { exceptionClasses: ['SUBSTITUTE'] }, new Uint8Array(randomBytes(32)), 'rogue-k9'),
        ),
      'AUTHORITY_SIGNATURE_INVALID',
    );
    // Without the server keyring nothing can be verified, so nothing is applied.
    reject((i) => evidence(engineer(i)), 'AUTHORITY_SIGNATURE_UNVERIFIABLE', false);
    // The record claims engineer, but the role registry says the actor holds no engineer role at the site.
    reject((i) => evidence(engineer(i), ['operator']), 'AUTHORITY_ROLE_NOT_HELD');
    // Role revoked after signing: the registry now returns nothing for the actor.
    reject((i) => evidence(engineer(i), []), 'AUTHORITY_ROLE_NOT_HELD');
    // A policy approver whose claimed approver role is not held.
    const v = vendorNotApproved();
    const ap = fixtureAuthority(v, {
      kind: 'POLICY_APPROVAL',
      actorRole: 'maintenance_approver',
      overriddenReasons: ['VENDOR_NOT_APPROVED'],
    });
    v.authorities = [evidence(ap, ['viewer'])];
    expect(evaluateCompatibility(v, policy).authorityFindings).toEqual([
      { authorityRecordId: ap.authorityRecordId, reasonCode: 'AUTHORITY_ROLE_NOT_HELD' },
    ]);
    // A foreign tenant's signature transplanted onto this tenant's record: keys are derived per tenant.
    reject((i) => {
      const foreign = fixtureAuthority(i, { exceptionClasses: ['SUBSTITUTE'], tenantId: 'ten_fixture-other' as never });
      const local = fixtureAuthority(i, {
        exceptionClasses: ['SUBSTITUTE'],
        authorityRecordId: foreign.authorityRecordId,
      });
      return evidence({ ...local, signature: foreign.signature });
    }, 'AUTHORITY_SIGNATURE_INVALID');
    reject(
      (i) =>
        evidence(fixtureAuthority(i, { exceptionClasses: ['SUBSTITUTE'], tenantId: 'ten_fixture-other' as never })),
      'AUTHORITY_SCOPE_MISMATCH',
    );
  });

  it('security review: the production index exports no fixture signer and the signer refuses short keys', () => {
    expect('fixtureAuthority' in domain).toBe(false);
    expect(Object.keys(domain).filter((k) => /fixture.*(authority|sign|key)/i.test(k))).toEqual([]);
    expect(() => signAuthorityRecord(unsignedAuthority(substitute()), new Uint8Array(16), 'k')).toThrow();
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
    i.authorities = [evidence(engineer(i))];
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
    // Security review: a component no rule classifies is safety-critical; keys are canonicalized on both sides.
    expect(c('STANDARD', 'condenser-coil')).toBe('SAFETY_CRITICAL');
    expect(c('STANDARD', ' Compressor ')).toBe('SAFETY_CRITICAL');
    expect(c('STANDARD', 'Evaporator Fan Motor')).toBe('STANDARD');
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

  it('security review: unknown, case-variant and unregistered components fail closed', () => {
    const policy = fixtureGoverningPolicy();
    const unknown = exactMatchInput();
    unknown.candidate.component = 'condenser-coil';
    unknown.facts.requiredPart = fixtureFact('5A1-0402');
    const r = evaluateCompatibility(unknown, policy);
    expect(r.decision).toBe('HOLD');
    expect(r.safetyClass).toBe('SAFETY_CRITICAL');
    expect(r.blockingReasons).toEqual(expect.arrayContaining(['COMPONENT_UNCLASSIFIED', 'SAFETY_CLASSIFICATION']));
    // A non-canonical component key never reaches the rules: the input is refused.
    const variant = exactMatchInput();
    variant.candidate.component = ' Compressor';
    expect(() => evaluateCompatibility(variant, policy)).toThrow();
    // An empty safety registry classifies nothing as STANDARD.
    const empty = fixtureGoverningPolicy();
    empty.compatibility!.safetyClasses = [];
    expect(evaluateCompatibility(exactMatchInput(), empty).blockingReasons).toContain('COMPONENT_UNCLASSIFIED');
    // A catch-all STANDARD rule would turn unknown components into ALLOW: policy validation refuses it.
    const p = fixtureGoverningPolicy().compatibility!;
    const catchAll = validateCompatibilityPolicy({
      ...p,
      safetyClasses: [{ components: null, actionKinds: null, assetSafetyClasses: null, safetyClass: 'STANDARD' }],
    });
    expect(catchAll.ok).toBe(false);
  });
});
