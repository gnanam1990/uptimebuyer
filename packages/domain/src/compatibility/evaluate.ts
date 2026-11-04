// Deterministic fail-closed compatibility evaluation and approval routing (FR-06, FR-10, INV-02, INV-04, INV-15).
//
// ALLOW is reached only by positive checks: resolved asset identity on current bound revisions, an authoritative
// exact OEM part number equal to the candidate's (or a valid named-engineer exception where policy permits one),
// every mandatory electrical/mechanical constraint authoritative and not contradicted, every required certification
// authoritatively present, a compatible warranty status, an approved vendor and a fresh offer. Anything missing,
// conflicting, stale, seller-authored, semantic-only or model-extracted is a HOLD reason; known incompatibility,
// prohibited work and forbidden substitution are REJECT. There is no default or catch-all rule: an unknown value is a
// HOLD. Explanation (model confidence, rank, seller claims) is carried through for display only.
import { DomainError, decodeWire, encodeWire, type VersionedDigest } from '@uptimebuyer/contracts';
import { z } from 'zod';
import { computeSchemaDigest } from '../digest.js';
import { verifyAuthorityRecord, type AuthorityKeyring } from './authority.js';
import {
  AUTHORITATIVE_BASES,
  CompatibilityInputSchema,
  ExplanationSchema,
  SEMANTIC_BASES,
  type AuthorityKind,
  type CompatibilityInput,
  type ExceptionClass,
  type Explanation,
  type Fact,
} from './input.js';
import {
  NAMED_ENGINEER_ROLE,
  NON_AUTHORITATIVE_TRUST,
  OVERRIDABLE_REASONS,
  SELLER_SOURCE_KINDS,
  policyApproverRoles,
  type CompatibilityPolicy,
  type FactCategory,
  type GoverningPolicy,
  type InterventionSafetyClass,
  type OverridableReason,
} from './policy.js';

export const COMPATIBILITY_ENGINE_VERSION = 'compatibility-engine.v1';
export const COMPATIBILITY_INPUT_DIGEST_DOMAIN = 'compatibility-input';
/** Clock tolerance for source and offer timestamps ahead of the evaluation instant. */
export const SOURCE_FUTURE_SKEW_MS = 5_000;
const PURCHASE_KINDS: readonly string[] = ['PART_PURCHASE', 'CONTAINMENT_PURCHASE'];

export const RECOVERY_PATHS = Object.freeze([
  'NEW_EVIDENCE_REVISION',
  'NAMED_ENGINEER',
  'POLICY_APPROVER',
  'NEW_OFFER',
  'NEW_POLICY_REVISION',
  'NEW_TUPLE',
] as const);
export type RecoveryPath = (typeof RECOVERY_PATHS)[number];

export const normalizePartNumber = (s: string) => s.trim().toUpperCase();
export const normalizeManufacturer = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
export const normalizeFactValue = (s: string) => s.trim().replace(/\s+/g, ' ');
export const normalizeComponentKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

export interface RequiredAuthority {
  kind: AuthorityKind;
  roles: string[];
  exceptionClasses: ExceptionClass[];
  overriddenReasons: OverridableReason[];
}

export interface ApprovalRequirement {
  kind: AuthorityKind;
  roles: string[];
  scope: 'COMPATIBILITY_EXCEPTION' | 'POLICY_OVERRIDE' | 'AMOUNT_OUT_OF_BOUNDS';
  satisfied: boolean;
}

export interface ApprovalRoute {
  outcome: 'AUTO_PERMITTED' | 'REQUIRES_APPROVAL' | 'HOLD_FOR_EVIDENCE' | 'REJECT';
  requirements: ApprovalRequirement[];
  reasonCodes: string[];
}

export interface CompatibilityResult {
  decision: 'ALLOW' | 'HOLD' | 'REJECT';
  /** ALLOW: the satisfied checks (plus applied exceptions); HOLD/REJECT: the blocking reasons. */
  reasonCodes: string[];
  blockingReasons: string[];
  satisfiedChecks: string[];
  missingFields: string[];
  conflictingFields: string[];
  requiredAuthorities: RequiredAuthority[];
  recoveryPaths: RecoveryPath[];
  appliedAuthorityIds: string[];
  exceptionClassesApplied: ExceptionClass[];
  overridesApplied: OverridableReason[];
  authorityFindings: { authorityRecordId: string; reasonCode: string }[];
  safetyClass: InterventionSafetyClass;
  exactMatch: boolean;
  approvalRoute: ApprovalRoute;
  inputDigest: VersionedDigest;
  ruleVersion: typeof COMPATIBILITY_ENGINE_VERSION;
  policyRuleSet: string | null;
  explanation: (Explanation & { authority: 'NONE' }) | null;
}

const DigestPreimageSchema = z.strictObject({
  engine: z.literal(COMPATIBILITY_ENGINE_VERSION),
  policyRevisionId: z.string().min(1).max(80),
  policyBodyDigest: z.string().min(1).max(200),
  input: CompatibilityInputSchema,
});

/** The exact input digest: the validated input plus the governing revision id and its immutable body digest. */
export function compatibilityInputDigest(input: CompatibilityInput, policy: GoverningPolicy): VersionedDigest {
  return computeSchemaDigest(COMPATIBILITY_INPUT_DIGEST_DOMAIN, 1, DigestPreimageSchema, {
    engine: COMPATIBILITY_ENGINE_VERSION,
    policyRevisionId: policy.policyRevisionId,
    policyBodyDigest: policy.bodyDigest,
    input,
  });
}

/**
 * Safety class of an intervention, fail-closed. The asset floor (STANDARD stays STANDARD; ELEVATED, SAFETY_CRITICAL
 * and unknown classes are SAFETY_CRITICAL) is raised, never lowered, by every matching rule. A component is
 * classified only by a rule that names it explicitly (component keys canonicalized on both sides); an unclassified
 * component is SAFETY_CRITICAL. A catch-all rule (components null) can only raise.
 */
export function classifyInterventionDetailed(
  i: { assetSafetyClass: string; actionKind: string; component: string },
  policy: CompatibilityPolicy,
): { safetyClass: InterventionSafetyClass; componentClassified: boolean } {
  const rank: Record<InterventionSafetyClass, number> = { STANDARD: 0, SAFETY_CRITICAL: 1, PROHIBITED: 2 };
  const names: InterventionSafetyClass[] = ['STANDARD', 'SAFETY_CRITICAL', 'PROHIBITED'];
  const component = normalizeComponentKey(i.component);
  let level = i.assetSafetyClass === 'STANDARD' ? 0 : 1;
  let classified = false;
  for (const r of policy.safetyClasses) {
    const applies =
      (r.actionKinds === null || (r.actionKinds as readonly string[]).includes(i.actionKind)) &&
      (r.assetSafetyClasses === null || r.assetSafetyClasses.includes(i.assetSafetyClass));
    if (!applies) continue;
    if (r.components === null) {
      if (r.safetyClass !== 'STANDARD') level = Math.max(level, rank[r.safetyClass]);
      continue;
    }
    if (r.components.some((x) => normalizeComponentKey(x) === component)) {
      classified = true;
      level = Math.max(level, rank[r.safetyClass]);
    }
  }
  if (!classified) level = Math.max(level, 1);
  return { safetyClass: names[level]!, componentClassified: classified };
}

export function classifyIntervention(
  i: { assetSafetyClass: string; actionKind: string; component: string },
  policy: CompatibilityPolicy,
): InterventionSafetyClass {
  return classifyInterventionDetailed(i, policy).safetyClass;
}

export interface EvaluationOptions {
  /** Display-only context; never part of the input digest. */
  explanation?: Explanation;
  /** The authority service's keyring. Without it no authority record can be verified or applied. */
  keyring?: AuthorityKeyring | null;
}

type Cover = { type: 'ENGINEER'; cls: ExceptionClass } | { type: 'OVERRIDE' } | { type: 'NONE'; path: RecoveryPath };
interface Hold {
  reason: string;
  cover: Cover;
}

type Assessment =
  | { status: 'MISSING' }
  | { status: 'CONFLICT' }
  | { status: 'NON_AUTHORITATIVE'; value: string; why: string }
  | { status: 'AUTHORITATIVE'; value: string };

export function evaluateCompatibility(
  rawInput: CompatibilityInput,
  policy: GoverningPolicy,
  options: EvaluationOptions = {},
): CompatibilityResult {
  const explanation = options.explanation;
  let input: CompatibilityInput;
  let expl: Explanation | null = null;
  try {
    input = decodeWire(CompatibilityInputSchema, encodeWire(CompatibilityInputSchema, rawInput));
    if (explanation !== undefined) expl = decodeWire(ExplanationSchema, explanation);
  } catch {
    throw new DomainError('VALIDATION_FAILED', 'Compatibility input failed validation.', {
      reasonCode: 'INVALID_COMPATIBILITY_INPUT',
    });
  }
  const inputDigest = compatibilityInputDigest(input, policy);
  const c = policy.compatibility;
  const b = input.binding;
  const at = Date.parse(input.evaluatedAt);

  const holds: Hold[] = [];
  const rejects = new Set<string>();
  const satisfied = new Set<string>();
  const missing = new Set<string>();
  const conflicting = new Set<string>();
  const hold = (reason: string, cover: Cover = { type: 'NONE', path: 'NEW_EVIDENCE_REVISION' }) =>
    holds.push({ reason, cover });
  const evidenceHold = (reason: string) => hold(reason, { type: 'NONE', path: 'NEW_EVIDENCE_REVISION' });

  // Bound revisions must be the current ones.
  if (!input.state.policyRevisionEffective || b.policyRevisionId !== policy.policyRevisionId)
    hold('POLICY_REVISION_NOT_EFFECTIVE', { type: 'NONE', path: 'NEW_TUPLE' });
  if (!input.state.evidenceRevisionCurrent) hold('EVIDENCE_REVISION_NOT_CURRENT', { type: 'NONE', path: 'NEW_TUPLE' });
  if (!input.state.assetRevisionCurrent) hold('ASSET_REVISION_SUPERSEDED', { type: 'NONE', path: 'NEW_TUPLE' });

  // Exact asset identity.
  let identityOk = input.state.assetRevisionCurrent;
  if (input.state.evidenceAssetRevisionId !== b.assetRevisionId) {
    evidenceHold('ASSET_IDENTITY_UNRESOLVED');
    missing.add('evidence.assetRevision');
    identityOk = false;
  }
  for (const f of ['manufacturer', 'model', 'serial', 'bomRevision'] as const)
    if (input.asset[f] === null) {
      evidenceHold('ASSET_IDENTITY_UNRESOLVED');
      missing.add(`asset.${f}`);
      identityOk = false;
    }
  if (identityOk) satisfied.add('ASSET_IDENTITY_RESOLVED');

  if (!c) {
    hold('POLICY_RULES_MISSING', { type: 'NONE', path: 'NEW_POLICY_REVISION' });
    return finish();
  }

  const isAuthoritative = (s: Fact['values'][number]['sources'][number], cat: FactCategory) =>
    AUTHORITATIVE_BASES.includes(s.basis) &&
    !SELLER_SOURCE_KINDS.includes(s.sourceKind) &&
    !NON_AUTHORITATIVE_TRUST.includes(s.trustLevel) &&
    Date.parse(s.observedAt) <= at + SOURCE_FUTURE_SKEW_MS &&
    c.authoritativeSources.some(
      (r) =>
        r.category === cat &&
        (r.roles as readonly string[]).includes(s.role) &&
        (r.sourceKinds as readonly string[]).includes(s.sourceKind) &&
        (r.trustLevels as readonly string[]).includes(s.trustLevel),
    );
  const assess = (fact: Fact, cat: FactCategory): Assessment => {
    if (fact.values.length === 0) return { status: 'MISSING' };
    const distinct = new Set(fact.values.map((v) => normalizeFactValue(v.value)));
    if (distinct.size > 1) return { status: 'CONFLICT' };
    const value = normalizeFactValue(fact.values[0]!.value);
    const sources = fact.values.flatMap((v) => v.sources);
    if (sources.some((s) => isAuthoritative(s, cat))) return { status: 'AUTHORITATIVE', value };
    const seller = sources.every((s) => SELLER_SOURCE_KINDS.includes(s.sourceKind) || s.basis === 'SELLER_TEXT');
    const semantic = sources.every((s) => SEMANTIC_BASES.includes(s.basis));
    return {
      status: 'NON_AUTHORITATIVE',
      value,
      why: seller ? 'SELLER_AUTHORED_EVIDENCE' : semantic ? 'SEMANTIC_EVIDENCE_ONLY' : 'NON_AUTHORITATIVE_SOURCE',
    };
  };
  const overridable = (reason: string): Cover =>
    (c.overridableReasons as readonly string[]).includes(reason)
      ? { type: 'OVERRIDE' }
      : { type: 'NONE', path: 'NEW_EVIDENCE_REVISION' };

  const cand = input.candidate;

  // Safety classification of the intervention.
  const { safetyClass, componentClassified } = classifyInterventionDetailed(
    { assetSafetyClass: input.asset.safetyClass, actionKind: cand.actionKind, component: cand.component },
    c,
  );
  if (!componentClassified && safetyClass !== 'PROHIBITED')
    hold('COMPONENT_UNCLASSIFIED', { type: 'ENGINEER', cls: 'SAFETY_CRITICAL' });
  if (safetyClass === 'PROHIBITED') rejects.add('SAFETY_PROHIBITED');
  else if (safetyClass === 'SAFETY_CRITICAL')
    hold('SAFETY_CLASSIFICATION', { type: 'ENGINEER', cls: 'SAFETY_CRITICAL' });

  // Exact OEM part identity.
  const partField = `part:${cand.component}`;
  const req = assess(input.facts.requiredPart, 'PART_IDENTITY');
  let exact = false;
  let nonExact: ExceptionClass | null = null;
  if (cand.partNumber === null) {
    evidenceHold('MISSING_EXACT_MPN');
    missing.add('candidate.partNumber');
  }
  if (cand.manufacturer === null) {
    evidenceHold('MISSING_EXACT_MPN');
    missing.add('candidate.manufacturer');
  }
  if (req.status === 'MISSING') {
    evidenceHold('MISSING_EXACT_MPN');
    missing.add(partField);
  } else if (req.status === 'CONFLICT') {
    evidenceHold('CONFLICTING_MANUALS');
    conflicting.add(partField);
  } else if (req.status === 'NON_AUTHORITATIVE') {
    evidenceHold('MISSING_EXACT_MPN');
    evidenceHold(req.why);
    missing.add(partField);
  } else if (cand.partNumber !== null && cand.manufacturer !== null) {
    const mpnEqual = normalizePartNumber(cand.partNumber) === normalizePartNumber(req.value);
    const mfrEqual =
      input.asset.manufacturer !== null &&
      normalizeManufacturer(cand.manufacturer) === normalizeManufacturer(input.asset.manufacturer);
    if (mpnEqual && mfrEqual) {
      exact = true;
      satisfied.add('EXACT_OEM_MATCH');
    } else {
      nonExact = mpnEqual ? 'NON_EXACT_MATCH' : 'SUBSTITUTE';
      if (c.substitution.mode === 'FORBIDDEN') rejects.add('SUBSTITUTION_FORBIDDEN');
      else
        hold(nonExact === 'SUBSTITUTE' ? 'UNSUPPORTED_SUBSTITUTE' : 'NON_EXACT_MATCH', {
          type: 'ENGINEER',
          cls: nonExact,
        });
    }
  }

  // Mandatory electrical and mechanical constraints.
  for (const category of ['ELECTRICAL', 'MECHANICAL'] as const) {
    const constraints = c.mandatoryConstraints.filter((m) => m.category === category);
    let ok = constraints.length > 0;
    for (const { key } of constraints) {
      const field = `spec:${key}`;
      const fact = input.facts.requiredConstraints.find((r) => r.key === key)?.fact ?? { values: [] };
      const a = assess(fact, category);
      if (a.status !== 'AUTHORITATIVE') {
        ok = false;
        if (a.status === 'CONFLICT') {
          evidenceHold('CONFLICTING_MANUALS');
          conflicting.add(field);
        } else {
          evidenceHold('MISSING_CONSTRAINT_EVIDENCE');
          if (a.status === 'NON_AUTHORITATIVE') evidenceHold(a.why);
          missing.add(field);
        }
        continue;
      }
      const claims = input.facts.candidateConstraints.filter((x) => x.key === key).flatMap((x) => x.fact.values);
      if (claims.some((v) => normalizeFactValue(v.value) !== a.value)) {
        rejects.add('KNOWN_INCOMPATIBILITY');
        conflicting.add(`candidate.${field}`);
        ok = false;
        continue;
      }
      if (!exact) {
        const verified = claims.some((v) => v.sources.some((s) => isAuthoritative(s, category)));
        if (!verified) {
          ok = false;
          if (nonExact) {
            hold('CANDIDATE_CONSTRAINT_UNVERIFIED', { type: 'ENGINEER', cls: nonExact });
            missing.add(`candidate.${field}`);
          }
        }
      }
    }
    if (ok) satisfied.add(`${category}_CONSTRAINTS_SATISFIED`);
  }

  // Required certifications.
  let certOk = true;
  for (const rc of c.requiredCertifications) {
    if (rc.components !== null && !rc.components.includes(cand.component)) continue;
    const field = `certification:${rc.code}`;
    const merged: Fact = {
      values: input.facts.certifications.filter((x) => x.code === rc.code).flatMap((x) => x.fact.values),
    };
    const a = assess(merged, 'CERTIFICATION');
    if (a.status === 'AUTHORITATIVE' && a.value === 'CERTIFIED') continue;
    certOk = false;
    if (a.status === 'AUTHORITATIVE' && a.value === 'NOT_CERTIFIED') {
      rejects.add('CERTIFICATION_ABSENT');
      continue;
    }
    evidenceHold('MISSING_CERTIFICATION');
    if (a.status === 'CONFLICT') conflicting.add(field);
    else missing.add(field);
    if (a.status === 'NON_AUTHORITATIVE') evidenceHold(a.why);
  }
  if (certOk) satisfied.add('CERTIFICATION_SATISFIED');

  // Warranty.
  if (c.warranty.statusRequired) {
    const a = assess(input.facts.warranty, 'WARRANTY');
    if (a.status === 'AUTHORITATIVE' && a.value === 'OUT_OF_WARRANTY') satisfied.add('WARRANTY_COMPATIBLE');
    else if (a.status === 'AUTHORITATIVE' && a.value === 'IN_WARRANTY') {
      if (exact) satisfied.add('WARRANTY_COMPATIBLE');
      else if (nonExact) hold('WARRANTY_REQUIRES_OEM_PART', overridable('WARRANTY_REQUIRES_OEM_PART'));
    } else {
      hold('WARRANTY_STATUS_UNKNOWN', overridable('WARRANTY_STATUS_UNKNOWN'));
      if (a.status === 'CONFLICT') conflicting.add('warranty.status');
      else missing.add('warranty.status');
    }
  } else satisfied.add('WARRANTY_NOT_REQUIRED');

  // Approved vendor.
  if (cand.vendorId === null) {
    hold('VENDOR_STATUS_UNKNOWN', overridable('VENDOR_STATUS_UNKNOWN'));
    missing.add('candidate.vendorId');
  } else {
    const a = assess(input.facts.vendor, 'VENDOR');
    if (a.status === 'AUTHORITATIVE' && a.value === 'APPROVED') satisfied.add('APPROVED_VENDOR');
    else if (a.status === 'AUTHORITATIVE' && a.value === 'NOT_APPROVED')
      hold('VENDOR_NOT_APPROVED', overridable('VENDOR_NOT_APPROVED'));
    else {
      hold('VENDOR_STATUS_UNKNOWN', overridable('VENDOR_STATUS_UNKNOWN'));
      if (a.status === 'CONFLICT') conflicting.add('vendor.status');
      else missing.add('vendor.status');
    }
  }

  // Offer (price/stock) freshness for purchases.
  if (PURCHASE_KINDS.includes(cand.actionKind)) {
    const o = cand.offerObservedAt === null ? null : Date.parse(cand.offerObservedAt);
    if (o === null || o > at + SOURCE_FUTURE_SKEW_MS || at - o > c.freshness.maxOfferAgeMs) {
      hold('STALE_PRICE_OR_STOCK', { type: 'NONE', path: 'NEW_OFFER' });
      if (o === null) missing.add('candidate.offerObservedAt');
    } else satisfied.add('OFFER_FRESH');
  }

  return finish(safetyClass, exact);

  function finish(safetyClass: InterventionSafetyClass = 'SAFETY_CRITICAL', exactMatch = false): CompatibilityResult {
    const neededClasses = new Set<ExceptionClass>();
    const neededOverrides = new Set<OverridableReason>();
    for (const h of holds) {
      if (h.cover.type === 'ENGINEER') neededClasses.add(h.cover.cls);
      if (h.cover.type === 'OVERRIDE') neededOverrides.add(h.reason as OverridableReason);
    }

    // Authority evidence: verify every record, then apply only what covers a needed class or override.
    const coveredClasses = new Set<ExceptionClass>();
    const coveredOverrides = new Set<OverridableReason>();
    const applied: string[] = [];
    const findings: { authorityRecordId: string; reasonCode: string }[] = [];
    const permitted = (OVERRIDABLE_REASONS as readonly string[]).filter((r) =>
      (c?.overridableReasons as readonly string[] | undefined)?.includes(r),
    );
    for (const e of input.authorities) {
      const a = e.record;
      const v = verifyAuthorityRecord(e, input, policy, options.keyring);
      if (!v.valid) {
        findings.push({ authorityRecordId: a.authorityRecordId, reasonCode: v.reasonCode });
        continue;
      }
      const classes = a.exceptionClasses.filter(
        (x) => neededClasses.has(x) && (x === 'SAFETY_CRITICAL' || c?.substitution.mode === 'ENGINEER_EXCEPTION'),
      );
      const overrides = a.overriddenReasons.filter((x) => neededOverrides.has(x) && permitted.includes(x));
      if (classes.length === 0 && overrides.length === 0) {
        findings.push({ authorityRecordId: a.authorityRecordId, reasonCode: 'AUTHORITY_NOT_APPLICABLE' });
        continue;
      }
      classes.forEach((x) => coveredClasses.add(x));
      overrides.forEach((x) => coveredOverrides.add(x));
      applied.push(a.authorityRecordId);
    }

    const remaining = holds.filter(
      (h) =>
        !(h.cover.type === 'ENGINEER' && coveredClasses.has(h.cover.cls)) &&
        !(h.cover.type === 'OVERRIDE' && coveredOverrides.has(h.reason as OverridableReason)),
    );
    const uncoveredClasses = [...neededClasses].filter((x) => !coveredClasses.has(x)).sort();
    const uncoveredOverrides = [...neededOverrides].filter((x) => !coveredOverrides.has(x)).sort();
    const blocking = new Set<string>([...rejects, ...remaining.map((h) => h.reason)]);
    if (uncoveredClasses.length > 0) blocking.add('NAMED_APPROVAL_REQUIRED');

    const decision: CompatibilityResult['decision'] =
      rejects.size > 0 ? 'REJECT' : blocking.size > 0 ? 'HOLD' : 'ALLOW';
    const amount = input.candidate.amount;
    const requiredAuthorities: RequiredAuthority[] = [];
    if (decision !== 'REJECT') {
      if (uncoveredClasses.length > 0)
        requiredAuthorities.push({
          kind: 'ENGINEER_EXCEPTION',
          roles: [NAMED_ENGINEER_ROLE],
          exceptionClasses: uncoveredClasses,
          overriddenReasons: [],
        });
      if (uncoveredOverrides.length > 0)
        requiredAuthorities.push({
          kind: 'POLICY_APPROVAL',
          roles: policyApproverRoles(policy, 'POLICY_OVERRIDE', b.siteId, amount),
          exceptionClasses: [],
          overriddenReasons: uncoveredOverrides,
        });
    }
    const paths = new Set<RecoveryPath>();
    if (decision === 'HOLD') {
      for (const h of remaining)
        paths.add(
          h.cover.type === 'ENGINEER'
            ? 'NAMED_ENGINEER'
            : h.cover.type === 'OVERRIDE'
              ? 'POLICY_APPROVER'
              : h.cover.path,
        );
      if (uncoveredClasses.length > 0) paths.add('NAMED_ENGINEER');
    }

    const markers: string[] = [];
    if (coveredClasses.size > 0) markers.push('ENGINEER_EXCEPTION_APPLIED');
    if (coveredOverrides.size > 0) markers.push('POLICY_OVERRIDE_APPLIED');
    const satisfiedChecks = [...satisfied].sort();
    const blockingReasons = [...blocking].sort();

    // Approval routing (FR-10): compatibility exceptions, policy overrides and pre-authorized amount bounds.
    const route = ((): ApprovalRoute => {
      if (decision === 'REJECT')
        return { outcome: 'REJECT', requirements: [], reasonCodes: ['COMPATIBILITY_REJECTED'] };
      const requirements: ApprovalRequirement[] = [];
      const reasons: string[] = [];
      if (neededClasses.size > 0) {
        requirements.push({
          kind: 'ENGINEER_EXCEPTION',
          roles: [NAMED_ENGINEER_ROLE],
          scope: 'COMPATIBILITY_EXCEPTION',
          satisfied: uncoveredClasses.length === 0,
        });
        if (uncoveredClasses.length > 0) reasons.push('ENGINEER_EXCEPTION_REQUIRED');
      }
      if (neededOverrides.size > 0) {
        requirements.push({
          kind: 'POLICY_APPROVAL',
          roles: policyApproverRoles(policy, 'POLICY_OVERRIDE', b.siteId, amount),
          scope: 'POLICY_OVERRIDE',
          satisfied: uncoveredOverrides.length === 0,
        });
        if (uncoveredOverrides.length > 0) reasons.push('POLICY_OVERRIDE_REQUIRED');
      }
      const within =
        c?.autoPermit.some(
          (r) =>
            r.currency === amount.currency &&
            amount.amountMinor <= r.maxAmountMinor &&
            (r.siteIds === null || (r.siteIds as readonly string[]).includes(b.siteId)) &&
            (r.actionKinds as readonly string[]).includes(input.candidate.actionKind),
        ) ?? false;
      if (within) reasons.push('WITHIN_AUTO_PERMIT');
      else {
        const roles = policyApproverRoles(policy, 'STANDARD', b.siteId, amount);
        if (roles.length === 0) return { outcome: 'REJECT', requirements: [], reasonCodes: ['NO_APPROVER_ROUTE'] };
        requirements.push({ kind: 'POLICY_APPROVAL', roles, scope: 'AMOUNT_OUT_OF_BOUNDS', satisfied: false });
        reasons.push('AMOUNT_OUT_OF_BOUNDS');
      }
      const evidencePending = remaining.some((h) => h.cover.type === 'NONE');
      const outcome = evidencePending
        ? 'HOLD_FOR_EVIDENCE'
        : requirements.some((r) => !r.satisfied)
          ? 'REQUIRES_APPROVAL'
          : 'AUTO_PERMITTED';
      return { outcome, requirements, reasonCodes: [...new Set(reasons)].sort() };
    })();

    return {
      decision,
      reasonCodes: decision === 'ALLOW' ? [...satisfiedChecks, ...markers].sort() : blockingReasons,
      blockingReasons,
      satisfiedChecks,
      missingFields: [...missing].sort(),
      conflictingFields: [...conflicting].sort(),
      requiredAuthorities,
      recoveryPaths: [...paths].sort(),
      appliedAuthorityIds: applied.sort(),
      exceptionClassesApplied: [...coveredClasses].sort(),
      overridesApplied: [...coveredOverrides].sort(),
      authorityFindings: findings.sort((x, y) => (x.authorityRecordId < y.authorityRecordId ? -1 : 1)),
      safetyClass,
      exactMatch,
      approvalRoute: route,
      inputDigest,
      ruleVersion: COMPATIBILITY_ENGINE_VERSION,
      policyRuleSet: c?.ruleSet ?? null,
      explanation: expl ? { ...expl, authority: 'NONE' } : null,
    };
  }
}
